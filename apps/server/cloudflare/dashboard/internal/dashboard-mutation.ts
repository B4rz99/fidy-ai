import { findUserDocument, prepareUserDocumentWrite } from "../../user-documents/operations";
import { type DashboardMutationOperation, type DashboardOperation } from "../contract";
import { listCategories } from "../../categories/operations";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
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

const DocumentJson = Schema.fromJsonString(Schema.toCodecJson(DashboardDocument));
type MutationContext = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>;

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
    const auditStatement = recordCanonicalPATWork({
      authority: livePATAuthority({ subject, current }),
      input: {
        id: transactionId(),
        current,
        operation,
        outcome,
        afterOwnerWrite: false,
      },
    });
    return db.prepare(auditStatement.sql).bind(...auditStatement.params);
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
        recordLivePATUse({
          subject: work.subject,
          current: work.current,
        }),
      ].map(({ sql, params }) => work.db.prepare(sql).bind(...params))
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
  findUserDocument({ db, userId, kind: "dashboard" }).pipe(
    Effect.flatMap((found) => {
      if (Option.isNone(found)) return Effect.succeedNone;
      const row = found.value;
      return Schema.decodeEffect(DocumentJson)(row.encoded).pipe(
        Effect.map((document) =>
          Option.some({ document, revision: row.revision, encoded: row.encoded })
        )
      );
    }),
    Effect.mapError(() => new InvalidStoredDashboard())
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
    Effect.map((encoded) =>
      prepareUserDocumentWrite({ work, kind: "dashboard", encoded, revision: 1 })
    )
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
  return Schema.encodeEffect(DocumentJson)(document).pipe(
    Effect.map((encoded) => [
      prepareUserDocumentWrite({
        work,
        kind: "dashboard",
        encoded,
        revision: revision + 1,
      }),
    ])
  );
};

export const dashboardOutcome = (operation: DashboardMutationOperation): OwnerOutcome => ({
  _tag: "Owner",
  operation,
  collisionKey: Option.some("dashboard-document"),
  guardFacts: Option.none(),
  read: (db, userId) => findDashboardValue({ db, userId, operation }),
});

/** Read the committed document or ephemeral view from the same User after the unit commits. */
export const findDashboardValue = ({
  db,
  userId,
  operation,
}: Readonly<{ db: D1Database; userId: string; operation: DashboardOperation }>): Effect.Effect<
  Option.Option<CommittedMutationValue>
> =>
  Effect.gen(function* () {
    const found = yield* findDashboardDocument({ db, userId });
    if (Option.isNone(found)) return Option.none();
    return yield* projectDashboardValue({ db, userId, operation, document: found.value.document });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

/** Project a document already established in this canonical read, without retaining it afterward. */
export const projectDashboardValue = ({
  db,
  userId,
  operation,
  document,
}: Readonly<{
  db: D1Database;
  userId: string;
  operation: DashboardOperation;
  document: DashboardDocument;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.gen(function* () {
    if (operation !== "dashboard.getDashboardView") {
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
      document,
      now,
    });
    if (Option.isNone(facts)) return Option.none();
    const view = yield* renderDashboardView({
      document,
      facts: facts.value,
      now,
    });
    return Option.some({
      _tag: "Owner" as const,
      payload: view,
      encode: () => Schema.encodeEffect(Schema.toCodecJson(DashboardView))(view),
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));
