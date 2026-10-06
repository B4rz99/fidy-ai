import { type DashboardMutationOperation, type DashboardOperation } from "../contract";
import { listCategories } from "../../categories/operations";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { prepareOwnedStatement } from "../../database/operations";
import {
  collectDashboardCategoryReferences,
  makeDefaultDashboard,
} from "../../../src/core/dashboard/operations";
import { categoryIds } from "../../../src/core/categories/contract";
import { DashboardDocument, WidgetId } from "../../../src/core/dashboard/contract";
import { DashboardView } from "../../../src/shell/dashboard/contract";
import { loadDashboardFacts } from "./dashboard-view";
import { renderDashboardView } from "../../../src/shell/dashboard/operations";
import {
  type TransactionCaller,
  callerAuthority,
  isPATCaller,
  transactionFailure,
  transactionId,
} from "../../canonical-work/operations";
import {
  type CommittedMutationValue,
  type OwnerOutcome,
} from "../../canonical-operations/contract";

/** The persisted Dashboard is decoded before it is used to plan any mutation. */
const DocumentJson = Schema.fromJsonString(Schema.toCodecJson(DashboardDocument));
const StoredDocument = Schema.Struct({
  document_json: Schema.String,
  revision: Schema.Int,
});
type MutationContext = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>;

/** A skipped guarded edit or audit invalidates the entire shared unit. */
export const dashboardCompletion = `INSERT INTO dashboard_assertion (id, accepted)
  VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
  ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

export const audit = ({
  work,
  operation,
  outcome,
}: Readonly<{
  work: MutationContext;
  operation: DashboardMutationOperation;
  outcome: "accepted" | "rejected";
}>): D1PreparedStatement => {
  const { db, subject, current } = work;
  if (isPATCaller(subject)) {
    return prepareOwnedStatement({
      db,
      statement: recordCanonicalPATWork({
        authority: livePATAuthority({ subject, current }),
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
  const authority = callerAuthority({ subject, current });
  return prepareAuthorizedAuditCall({
    db,
    authority,
    id: transactionId(),
    operation,
    outcome,
    current,
    afterOwnerWrite: false,
  });
};

export const credentialUse = (work: MutationContext): ReadonlyArray<D1PreparedStatement> =>
  isPATCaller(work.subject)
    ? [
        prepareOwnedStatement({
          db: work.db,
          statement: recordLivePATUse({
            subject: work.subject,
            current: work.current,
          }),
        }),
      ]
    : [];

class InvalidStoredDashboard extends Data.TaggedError("InvalidStoredDashboard") {}
type StoredDashboard = Readonly<{
  document: DashboardDocument;
  revision: number;
  encoded: string;
}>;

/** Fetch a decoded owned document; an invalid retained row fails closed rather than resetting it. */
export const findDashboardDocument = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<
  Option.Option<StoredDashboard>,
  InvalidStoredDashboard
> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare("SELECT document_json, revision FROM dashboard_documents WHERE user_id = ?")
        .bind(userId)
        .first(),
    catch: () => new InvalidStoredDashboard(),
  }).pipe(
    Effect.flatMap((raw): Effect.Effect<Option.Option<StoredDashboard>, InvalidStoredDashboard> => {
      if (raw === null) return Effect.succeedNone;
      const decoded = Option.flatMap(Schema.decodeUnknownOption(StoredDocument)(raw), (row) =>
        Option.map(Schema.decodeOption(DocumentJson)(row.document_json), (document) => ({
          document,
          revision: row.revision,
          encoded: row.document_json,
        }))
      );
      return Option.isSome(decoded)
        ? Effect.succeed(decoded)
        : Effect.fail(new InvalidStoredDashboard());
    })
  );

export const defaultDocument = (): DashboardDocument =>
  makeDefaultDashboard({
    restaurantCategoryId: categoryIds.restaurantes,
    widgetIds: [
      WidgetId.make(transactionId()),
      WidgetId.make(transactionId()),
      WidgetId.make(transactionId()),
      WidgetId.make(transactionId()),
    ],
  });

export const firstUse = ({
  work,
  document,
}: Readonly<{ work: MutationContext; document: DashboardDocument }>): Effect.Effect<
  D1PreparedStatement,
  Schema.SchemaError
> =>
  Schema.encodeEffect(DocumentJson)(document).pipe(
    Effect.map((encoded) => {
      const authority = callerAuthority(work);
      return work.db
        .prepare(
          `INSERT INTO dashboard_documents (user_id, document_json, revision)
        SELECT user_id, ?, 1 FROM ${authority.table} WHERE ${authority.predicate}
        ON CONFLICT(user_id) DO NOTHING`
        )
        .bind(encoded, ...authority.bindings);
    })
  );

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
export const failure = (code: "validation_failed" | "not_found"): Response =>
  transactionFailure({
    code,
    status: code === "not_found" ? HTTP_NOT_FOUND : HTTP_BAD_REQUEST,
    message: code === "not_found" ? "Dashboard widget unavailable." : "Invalid Dashboard edit.",
  });

export const validCategories = ({
  db,
  document,
}: Readonly<{ db: D1Database; document: DashboardDocument }>): Effect.Effect<
  Option.Option<boolean>
> => {
  const ids = [
    ...new Set(collectDashboardCategoryReferences(document).map((item) => item.categoryId)),
  ];
  if (ids.length === 0) return Effect.succeedSome(true);
  return listCategories({ db }).pipe(
    Effect.map((categories) =>
      Option.some(ids.every((id) => categories.some((category) => category.id === id)))
    ),
    Effect.orElseSucceed(() => Option.none())
  );
};

export const editWrite = ({
  work,
  operation,
  document,
  revision,
}: Readonly<{
  work: MutationContext;
  operation: DashboardMutationOperation;
  document: DashboardDocument;
  revision: number;
}>): Effect.Effect<ReadonlyArray<D1PreparedStatement>, Schema.SchemaError> => {
  if (operation !== "dashboard.applyDashboardEdit") return Effect.succeed([]);
  const authority = callerAuthority(work);
  return Schema.encodeEffect(DocumentJson)(document).pipe(
    Effect.map((encoded) => [
      work.db
        .prepare(
          `UPDATE dashboard_documents SET document_json = ?, revision = revision + 1
      WHERE user_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`
        )
        .bind(encoded, work.subject.userId, revision, ...authority.bindings),
    ])
  );
};

/** Commit-time owner decisions stay with the Dashboard, not in the common mutation unit. */
export const dashboardOutcome = (operation: DashboardMutationOperation): OwnerOutcome => ({
  _tag: "Owner",
  operation,
  collisionKey: Option.some("dashboard-document"),
  guardFacts: Option.none(),
  read: (db, userId) => findDashboardValue({ db, userId, operation }),
  triggerRefusal: (_work, kind) =>
    kind === "audit"
      ? Option.some({
          code: "rate_limited",
          message: "Daily audit budget exhausted.",
          record: () => Effect.succeed("rate_limited" as const),
          respond: () =>
            Effect.succeed(
              transactionFailure({
                code: "rate_limited",
                status: 429,
                message: "Daily audit budget exhausted.",
              })
            ),
        })
      : Option.none(),
});

/** Read the committed document or ephemeral view from the same User after the unit commits. */
export const findDashboardValue = ({
  db,
  userId,
  operation,
}: Readonly<{
  db: D1Database;
  userId: string;
  operation: DashboardOperation;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.gen(function* () {
    const found = yield* findDashboardDocument({ db, userId });
    if (Option.isNone(found)) return Option.none();
    if (operation !== "dashboard.getDashboardView") {
      const document = found.value.document;
      return Option.some({
        _tag: "Owner" as const,
        payload: document,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(DashboardDocument))(document),
      });
    }
    const now = yield* DateTime.now;
    const facts = yield* loadDashboardFacts({
      db,
      userId,
      document: found.value.document,
      now,
    });
    if (Option.isNone(facts)) return Option.none();
    const view = yield* renderDashboardView({
      document: found.value.document,
      facts: facts.value,
      now,
    });
    return Option.some({
      _tag: "Owner" as const,
      payload: view,
      encode: () => Schema.encodeEffect(Schema.toCodecJson(DashboardView))(view),
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));
