import { Data, DateTime, Effect, Option, Result, Schema } from "effect";
import { RequestBodyPolicy, boundedJsonBody } from "../http/request-body";
import { DashboardView } from "../../src/shell/dashboard/operations";
import { loadDashboardFacts, renderDashboardView } from "./dashboard-view";
import { makeDashboardCatalog, makeDefaultDashboard } from "../../src/core/dashboard/catalog";
import { CategoryId } from "../../src/core/categories/reference";
import {
  DashboardCatalog,
  DashboardDocument,
  DashboardEdit,
  WidgetId,
  collectDashboardCategoryReferences,
} from "../../src/core/dashboard/model";
import { applyDashboardEdit } from "../../src/core/dashboard/rules";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionCaller,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../transactions/transaction-boundary";

const restaurantId = "10000000-0000-4000-8000-000000000001";
const DocumentJson = Schema.fromJsonString(Schema.toCodecJson(DashboardDocument));
const StoredDocument = Schema.Struct({ document_json: Schema.String, revision: Schema.Int });
const editBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16_384,
  deadlineMilliseconds: 2_000,
});
class DashboardUnavailable extends Data.TaggedError("DashboardUnavailable") {}
const io = <Value>(run: () => Promise<Value>): Effect.Effect<Value, DashboardUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new DashboardUnavailable() });
type DashboardOperation =
  | "dashboard.getDashboard"
  | "dashboard.getDashboardView"
  | "dashboard.listDashboardCatalog"
  | "dashboard.applyDashboardEdit";

const response = <A>(schema: Schema.Codec<A, Schema.Json>, data: A): Response =>
  Response.json(
    { data: Schema.encodeSync(schema)(data), next: [] },
    { headers: transactionNoStore }
  );
const invalid = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: 400,
    message: "Invalid Dashboard edit.",
  });
const missing = (): Response =>
  transactionFailure({ code: "not_found", status: 404, message: "Dashboard widget unavailable." });
const refused = (): Response =>
  transactionFailure({
    code: "unauthenticated",
    status: 401,
    message: "Present a valid credential and retry.",
  });
const assertion = (db: D1Database): D1PreparedStatement =>
  db.prepare(`INSERT INTO dashboard_assertion (id, accepted)
  VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
  ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`);

type DashboardAudit = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: DashboardOperation;
  outcome: "accepted" | "rejected";
  current: number;
  writes: ReadonlyArray<D1PreparedStatement>;
}>;

/** One metadata-only AuditLogEntry under the live User's credential; never stores a document. */
const audit = ({
  db,
  subject,
  operation,
  outcome,
  current,
}: DashboardAudit): D1PreparedStatement => {
  if (isPATCaller(subject)) {
    return prepareOwnedStatement({
      db,
      statement: recordCanonicalPATWork({
        subject,
        input: {
          id: transactionId(),
          current,
          operation,
          outcome,
          afterOwnerWrite: false,
        },
      }),
    });
  }
  const authority = liveWebSessionAuthority({ subject, current });
  return db
    .prepare(`INSERT INTO dashboard_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT ?, user_id, id, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
    .bind(transactionId(), operation, outcome, current, ...authority.bindings);
};

const audited = (input: DashboardAudit): Promise<boolean> =>
  input.db
    .batch([
      ...(isPATCaller(input.subject)
        ? [
            prepareOwnedStatement({
              db: input.db,
              statement: recordLivePATUse({ subject: input.subject, current: input.current }),
            }),
          ]
        : []),
      ...input.writes,
      audit(input),
      assertion(input.db),
    ])
    .then(() => true)
    .catch(() => false);

const documentForUser = (
  db: D1Database,
  userId: string
): Promise<Option.Option<{ document: DashboardDocument; revision: number }>> =>
  db
    .prepare("SELECT document_json, revision FROM dashboard_documents WHERE user_id = ?")
    .bind(userId)
    .first()
    .then((raw) => {
      const row = Schema.decodeUnknownOption(StoredDocument)(raw);
      if (Option.isNone(row)) return Option.none();
      return Option.map(Schema.decodeOption(DocumentJson)(row.value.document_json), (document) => ({
        document,
        revision: row.value.revision,
      }));
    });

const validCategories = (
  db: D1Database,
  document: DashboardDocument
): Effect.Effect<boolean, DashboardUnavailable> =>
  Effect.gen(function* () {
    const ids = [
      ...new Set(
        collectDashboardCategoryReferences(document).map((reference) => reference.categoryId)
      ),
    ];
    if (ids.length === 0) return true;
    const found = yield* io(() =>
      db
        .prepare(`SELECT id FROM categories WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all()
    );
    return found.results.length === ids.length;
  });

/** First use retains exactly one validated document; a competing request cannot replace it. */
const ensureDocument = ({
  db,
  subject,
  operation,
  current,
}: Pick<DashboardAudit, "db" | "subject" | "operation" | "current">): Effect.Effect<
  Option.Option<{ document: DashboardDocument; revision: number }>,
  DashboardUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const existing = yield* io(() => documentForUser(db, subject.userId));
    if (Option.isSome(existing)) {
      if (
        !(yield* io(() =>
          audited({ db, subject, operation, outcome: "accepted", current, writes: [] })
        ))
      ) {
        return Option.none();
      }
      return existing;
    }
    const document = makeDefaultDashboard({
      restaurantCategoryId: CategoryId.make(restaurantId),
      widgetIds: [
        WidgetId.make(transactionId()),
        WidgetId.make(transactionId()),
        WidgetId.make(transactionId()),
        WidgetId.make(transactionId()),
      ],
    });
    const authority = callerAuthority({ subject, current });
    const encoded = yield* Schema.encodeEffect(DocumentJson)(document);
    const created = yield* io(() =>
      audited({
        db,
        subject,
        operation,
        outcome: "accepted",
        current,
        writes: [
          db
            .prepare(`INSERT INTO dashboard_documents (user_id, document_json, revision)
        SELECT user_id, ?, 1 FROM ${authority.table} WHERE ${authority.predicate}
        ON CONFLICT(user_id) DO NOTHING`)
            .bind(encoded, ...authority.bindings),
        ],
      })
    );
    return created ? yield* io(() => documentForUser(db, subject.userId)) : Option.none();
  });

const readEdit = (
  request: Request
): Effect.Effect<Option.Option<DashboardEdit>, DashboardUnavailable> =>
  io(() => boundedJsonBody(request, editBodyPolicy, Schema.toCodecJson(DashboardEdit)));

const commitDocument = ({
  db,
  subject,
  current,
  document,
  expectedRevision,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  document: DashboardDocument;
  expectedRevision: number;
}>): Effect.Effect<Response, DashboardUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const authority = callerAuthority({ subject, current });
    const encoded = yield* Schema.encodeEffect(DocumentJson)(document);
    const committed = yield* io(() =>
      audited({
        db,
        subject,
        operation: "dashboard.applyDashboardEdit",
        outcome: "accepted",
        current,
        writes: [
          db
            .prepare(`UPDATE dashboard_documents SET document_json = ?, revision = revision + 1
        WHERE user_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
            .bind(encoded, subject.userId, expectedRevision, ...authority.bindings),
          assertion(db),
        ],
      })
    );
    return committed
      ? response(Schema.toCodecJson(DashboardDocument), document)
      : transactionUnavailable();
  });

const auditRejection = (
  db: D1Database,
  subject: TransactionCaller,
  current: number
): Effect.Effect<boolean, DashboardUnavailable> =>
  io(() =>
    audited({
      db,
      subject,
      operation: "dashboard.applyDashboardEdit",
      outcome: "rejected",
      current,
      writes: [],
    })
  );

const rejectEdit = ({
  db,
  subject,
  current,
  reason,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  reason: "invalid" | "missing";
}>): Effect.Effect<Response, DashboardUnavailable> =>
  auditRejection(db, subject, current).pipe(
    Effect.map((accepted) => {
      if (!accepted) return transactionUnavailable();
      return reason === "missing" ? missing() : invalid();
    })
  );

const editDocument = ({
  db,
  subject,
  request,
}: Readonly<{ db: D1Database; subject: TransactionCaller; request: Request }>): Effect.Effect<
  Response,
  DashboardUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const current = transactionNow();
    const edit = yield* readEdit(request);
    if (Option.isNone(edit)) {
      return yield* rejectEdit({ db, subject, current, reason: "invalid" });
    }
    const base = yield* ensureDocument({
      db,
      subject,
      operation: "dashboard.getDashboard",
      current,
    });
    if (Option.isNone(base)) return transactionUnavailable();
    const result = yield* Effect.result(
      applyDashboardEdit({ document: base.value.document, edit: edit.value })
    );
    if (Result.isFailure(result)) {
      const reason =
        result.failure._tag === "WidgetNotFound" || result.failure._tag === "RegionNotFound"
          ? "missing"
          : "invalid";
      return yield* rejectEdit({ db, subject, current, reason });
    }
    if (!(yield* validCategories(db, result.success))) {
      return yield* rejectEdit({ db, subject, current, reason: "invalid" });
    }
    return yield* commitDocument({
      db,
      subject,
      current,
      document: result.success,
      expectedRevision: base.value.revision,
    });
  });

const readDashboard = ({
  db,
  subject,
  operation,
  current,
}: Pick<DashboardAudit, "db" | "subject" | "operation" | "current">): Effect.Effect<
  Response,
  DashboardUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    if (operation === "dashboard.listDashboardCatalog") {
      if (
        !(yield* io(() =>
          audited({ db, subject, operation, outcome: "accepted", current, writes: [] })
        ))
      ) {
        return transactionUnavailable();
      }
      return response(
        Schema.toCodecJson(DashboardCatalog),
        makeDashboardCatalog({ restaurantCategoryId: CategoryId.make(restaurantId) })
      );
    }
    const document = yield* ensureDocument({ db, subject, operation, current });
    if (Option.isNone(document)) return transactionUnavailable();
    if (operation === "dashboard.getDashboard") {
      return response(Schema.toCodecJson(DashboardDocument), document.value.document);
    }
    const facts = yield* loadDashboardFacts(db, subject.userId);
    if (Option.isNone(facts)) return transactionUnavailable();
    const view = yield* renderDashboardView(
      document.value.document,
      facts.value,
      DateTime.nowUnsafe()
    );
    return response(Schema.toCodecJson(DashboardView), view);
  });

/** Execute Dashboard document and catalog calls with explicit User authority and no unbounded body. */
export const browseDashboard = ({
  db,
  subject,
  operation,
  request,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: DashboardOperation;
  request: Request;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = transactionNow();
    if (!(yield* io(() => liveTransactionAuthority({ db, subject, current })))) return refused();
    if (operation === "dashboard.applyDashboardEdit") {
      return yield* editDocument({ db, subject, request });
    }
    if (request.url.includes("?")) return invalid();
    return yield* readDashboard({ db, subject, operation, current });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));
