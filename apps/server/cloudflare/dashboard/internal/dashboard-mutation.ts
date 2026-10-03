import type { DashboardMutationOperation } from "../contract";
import { listCategories } from "../../categories/operations";
import { Data, DateTime, Effect, Option, Result, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { prepareOwnedStatement } from "../../database/operations";
import {
  applyDashboardEdit,
  collectDashboardCategoryReferences,
  makeDefaultDashboard,
} from "../../../src/core/dashboard/operations";
import { categoryIds } from "../../../src/core/categories/contract";
import {
  DashboardDocument,
  type DashboardEdit,
  WidgetId,
} from "../../../src/core/dashboard/contract";

import { DashboardView } from "../../../src/shell/dashboard/contract";
import { loadDashboardFacts } from "./dashboard-view";
import { renderDashboardView } from "../../../src/shell/dashboard/operations";
import {
  type TransactionCaller,
  callerAuthority,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isPATCaller,
  liveTransactionAuthority,
  refusedPreparation,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type CommittedMutationValue,
  type OwnerOutcome,
} from "../../canonical-operations/contract";

/** The persisted Dashboard is decoded before it is used to plan any mutation. */
const DocumentJson = Schema.fromJsonString(Schema.toCodecJson(DashboardDocument));
const StoredDocument = Schema.Struct({ document_json: Schema.String, revision: Schema.Int });
type MutationContext = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>;

/** A skipped guarded edit or audit invalidates the entire shared unit. */
export const dashboardCompletion = `INSERT INTO dashboard_assertion (id, accepted)
  VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
  ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

const audit = (
  work: MutationContext,
  operation: DashboardMutationOperation,
  outcome: "accepted" | "rejected"
): D1PreparedStatement => {
  const { db, subject, current } = work;
  if (isPATCaller(subject)) {
    return prepareOwnedStatement({
      db,
      statement: recordCanonicalPATWork({
        authority: livePATAuthority({ subject, current }),
        input: { id: transactionId(), current, operation, outcome, afterOwnerWrite: false },
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

const credentialUse = (work: MutationContext): ReadonlyArray<D1PreparedStatement> =>
  isPATCaller(work.subject)
    ? [
        prepareOwnedStatement({
          db: work.db,
          statement: recordLivePATUse({ subject: work.subject, current: work.current }),
        }),
      ]
    : [];

class InvalidStoredDashboard extends Data.TaggedError("InvalidStoredDashboard") {}
type StoredDashboard = Readonly<{ document: DashboardDocument; revision: number }>;

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
        }))
      );
      return Option.isSome(decoded)
        ? Effect.succeed(decoded)
        : Effect.fail(new InvalidStoredDashboard());
    })
  );

const defaultDocument = (): DashboardDocument =>
  makeDefaultDashboard({
    restaurantCategoryId: categoryIds.restaurantes,
    widgetIds: [
      WidgetId.make(transactionId()),
      WidgetId.make(transactionId()),
      WidgetId.make(transactionId()),
      WidgetId.make(transactionId()),
    ],
  });

const firstUse = (
  work: MutationContext,
  document: DashboardDocument
): Effect.Effect<D1PreparedStatement, Schema.SchemaError> =>
  Schema.encodeEffect(DocumentJson)(document).pipe(
    Effect.map((encoded) => {
      const authority = callerAuthority(work);
      return work.db
        .prepare(`INSERT INTO dashboard_documents (user_id, document_json, revision)
        SELECT user_id, ?, 1 FROM ${authority.table} WHERE ${authority.predicate}
        ON CONFLICT(user_id) DO NOTHING`)
        .bind(encoded, ...authority.bindings);
    })
  );

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const failure = (code: "validation_failed" | "not_found"): Response =>
  transactionFailure({
    code,
    status: code === "not_found" ? HTTP_NOT_FOUND : HTTP_BAD_REQUEST,
    message: code === "not_found" ? "Dashboard widget unavailable." : "Invalid Dashboard edit.",
  });

/** Refusal audit is separate from the rolled-back unit, under the same live credential. */
export const dashboardRefusal = ({
  work,
  operation,
  code,
}: Readonly<{
  work: MutationContext;
  operation: DashboardMutationOperation;
  code: "validation_failed" | "not_found";
}>): CanonicalMutationRefusal => ({
  code,
  message: code === "not_found" ? "Dashboard widget unavailable." : "Invalid Dashboard edit.",
  record: () =>
    Effect.tryPromise(() =>
      work.db.batch([
        ...credentialUse(work),
        audit(work, operation, "rejected"),
        work.db.prepare(dashboardCompletion),
      ])
    ).pipe(
      Effect.map(() => "recorded" as const),
      Effect.orElseSucceed(() => "unavailable" as const)
    ),
  respond: (disposition) =>
    Effect.succeed(disposition === "recorded" ? failure(code) : transactionUnavailable()),
});

const validCategories = (
  db: D1Database,
  document: DashboardDocument
): Effect.Effect<Option.Option<boolean>> => {
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

const decideDocument = ({
  work,
  operation,
  edit,
  base,
}: Readonly<{
  work: MutationContext;
  operation: DashboardMutationOperation;
  edit: Option.Option<DashboardEdit>;
  base: DashboardDocument;
}>): Effect.Effect<Result.Result<DashboardDocument, CanonicalMutationPreparation>> =>
  Effect.gen(function* () {
    if (operation !== "dashboard.applyDashboardEdit" || Option.isNone(edit)) {
      return Result.succeed(base);
    }
    const result = yield* Effect.result(applyDashboardEdit({ document: base, edit: edit.value }));
    if (Result.isFailure(result)) {
      const code =
        result.failure._tag === "WidgetNotFound" || result.failure._tag === "RegionNotFound"
          ? "not_found"
          : "validation_failed";
      return Result.fail(refusedPreparation(dashboardRefusal({ work, operation, code })));
    }
    const valid = yield* validCategories(work.db, result.success);
    if (Option.isNone(valid)) return Result.fail(failedPreparation());
    return valid.value
      ? Result.succeed(result.success)
      : Result.fail(
          refusedPreparation(dashboardRefusal({ work, operation, code: "validation_failed" }))
        );
  });

const editWrite = ({
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
        .prepare(`UPDATE dashboard_documents SET document_json = ?, revision = revision + 1
      WHERE user_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
        .bind(encoded, work.subject.userId, revision, ...authority.bindings),
    ])
  );
};

const preparedDashboard = ({
  work,
  operation,
  initial,
  write,
}: Readonly<{
  work: MutationContext;
  operation: DashboardMutationOperation;
  initial: Option.Option<D1PreparedStatement>;
  write: ReadonlyArray<D1PreparedStatement>;
}>): CanonicalMutationPreparation => ({
  _tag: "Prepared",
  mutation: {
    requiredScope: callerScope(work.subject),
    auditBudget: "shared",
    commitGuards: Option.none(),
    guardRefusal: ({ db, subject, current }) =>
      Effect.succeed(
        dashboardRefusal({
          work: { db, subject, current },
          operation,
          code: "validation_failed",
        })
      ),
    statements: [
      ...credentialUse(work),
      ...(Option.isSome(initial) ? [initial.value] : []),
      // A first edit cannot update a competing document it did not validate.
      ...(operation === "dashboard.applyDashboardEdit" && Option.isSome(initial)
        ? [work.db.prepare(dashboardCompletion)]
        : []),
      ...write,
      // The revision guard must change exactly one row before a success Audit can commit.
      ...(write.length > 0 ? [work.db.prepare(dashboardCompletion)] : []),
      audit(work, operation, "accepted"),
    ],
    outcome: dashboardOutcome(operation),
  },
});

const dashboardAccess = ({
  work,
  operation,
  edit,
}: Readonly<{
  work: MutationContext;
  operation: DashboardMutationOperation;
  edit: Option.Option<DashboardEdit>;
}>): Effect.Effect<Option.Option<CanonicalMutationPreparation>> =>
  Effect.tryPromise(() => liveTransactionAuthority(work)).pipe(
    Effect.option,
    Effect.map((live) => {
      if (Option.isNone(live)) return Option.some(failedPreparation());
      if (!live.value) return Option.some(credentialRefusedPreparation());
      return operation === "dashboard.applyDashboardEdit" && Option.isNone(edit)
        ? Option.some(
            refusedPreparation(dashboardRefusal({ work, operation, code: "validation_failed" }))
          )
        : Option.none();
    })
  );

/** Prepare initialization, one first-use read or a guarded edit, without opening a D1 unit. */
export const prepareDashboard = ({
  work,
  operation,
  edit,
}: Readonly<{
  work: MutationContext;
  operation: DashboardMutationOperation;
  edit: Option.Option<DashboardEdit>;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const access = yield* dashboardAccess({ work, operation, edit });
    if (Option.isSome(access)) return access.value;
    const existing = yield* findDashboardDocument({ db: work.db, userId: work.subject.userId });
    const base = Option.isSome(existing) ? existing.value.document : defaultDocument();
    const decision = yield* decideDocument({ work, operation, edit, base });
    if (Result.isFailure(decision)) return decision.failure;
    const document = decision.success;
    const initial = Option.isSome(existing)
      ? Option.none()
      : Option.some(yield* firstUse(work, base));
    const write = yield* editWrite({
      work,
      operation,
      document,
      revision: Option.isSome(existing) ? existing.value.revision : 1,
    });
    return preparedDashboard({
      work,
      operation,
      initial,
      write,
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Commit-time owner decisions stay with the Dashboard, not in the common mutation unit. */
const dashboardOutcome = (operation: DashboardMutationOperation): OwnerOutcome => ({
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
  operation: DashboardMutationOperation;
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
    const now = DateTime.nowUnsafe();
    const facts = yield* loadDashboardFacts({ db, userId, document: found.value.document, now });
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

/** The Dashboard owner presents exactly the same value for individual and batch callers. */
export const presentDashboard = (
  value: Extract<CommittedMutationValue, { _tag: "Owner" }>
): Effect.Effect<Response> =>
  value.encode().pipe(
    Effect.map((data) => Response.json({ data, next: [] }, { headers: transactionNoStore })),
    Effect.orElseSucceed(transactionUnavailable)
  );
