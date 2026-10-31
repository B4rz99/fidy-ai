import {
  findUserDocument,
  prepareUserDocumentWrite,
  readAuthorizedUserDocumentSnapshot,
} from "../../user-documents/operations";
import { type DashboardMutationOperation, type DashboardOperation } from "../contract";
import { listCategories, prepareCategorySnapshot } from "../../categories/operations";
import { UserContext, UserId } from "../../../src/core/identity/contract";
import { prepareUserContext } from "../../identity/user-context/operations";
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
import { type DashboardReadContext, loadDashboardFacts } from "./dashboard-view";
import { renderDashboardView } from "../../../src/shell/dashboard/operations";
import {
  type QueryCaller,
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

type DashboardSource = Readonly<{
  live: boolean;
  document: Option.Option<StoredDashboard>;
  viewContext: Option.Option<DashboardReadContext>;
}>;
const decodeStoredDashboard = (
  row: Readonly<{ encoded: string; revision: number }>
): Effect.Effect<StoredDashboard, Schema.SchemaError> =>
  Schema.decodeEffect(DocumentJson)(row.encoded).pipe(
    Effect.map((document) => ({ ...row, document }))
  );

const decodeViewContext = (related: ReadonlyArray<D1Result>): Option.Option<UserContext> => {
  const rows = related[0]?.results;
  return related.length === 1 && rows?.length === 1
    ? Schema.decodeUnknownOption(UserContext)(rows[0])
    : Option.none();
};

/** Observe live authority and its gated view sources in one read-only native snapshot. */
const readViewSource = ({
  db,
  subject,
  current,
}: Readonly<{ db: D1Database; subject: QueryCaller; current: number }>): Effect.Effect<
  DashboardSource,
  InvalidStoredDashboard
> =>
  Effect.gen(function* () {
    const authority = callerAuthority({ subject, current });
    const taxonomy = prepareCategorySnapshot({ db, authority });
    const retained = yield* readAuthorizedUserDocumentSnapshot({
      db,
      subject,
      current,
      kind: "dashboard",
      related: [
        prepareUserContext({
          db,
          userId: UserId.make(subject.userId),
          statement: {
            sql: `SELECT serviceMarket, locale, timeZone FROM identity_user_context
              WHERE EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`,
            params: authority.bindings,
          },
        }),
        taxonomy.statement,
      ],
    });
    if (!retained.live) {
      return { live: false, document: Option.none(), viewContext: Option.none() };
    }
    const document = Option.isNone(retained.document)
      ? Option.none()
      : Option.some(yield* decodeStoredDashboard(retained.document.value));
    const context = decodeViewContext(retained.related.slice(0, 1));
    const categories = taxonomy.decode(retained.related[1]?.results);
    return {
      live: true,
      document,
      viewContext:
        Option.isSome(context) && Option.isSome(categories)
          ? Option.some({ context: context.value, categories: categories.value })
          : Option.none(),
    };
  }).pipe(Effect.mapError(() => new InvalidStoredDashboard()));

export const findDashboardSource = ({
  db,
  subject,
  current,
  operation,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  current: number;
  operation: DashboardOperation;
}>): Effect.Effect<DashboardSource, InvalidStoredDashboard> =>
  operation === "dashboard.getDashboardView"
    ? readViewSource({ db, subject, current })
    : findDashboardDocument({ db, userId: subject.userId }).pipe(
        Effect.map((document) => ({ live: true, document, viewContext: Option.none() }))
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

/** Read the committed document from the same User after the mutation unit commits. */
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
    const document = yield* findDashboardDocument({ db, userId });
    if (Option.isNone(document)) return Option.none();
    return yield* projectDashboardValue({
      db,
      userId,
      operation,
      document: document.value.document,
      viewContext: Option.none(),
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

/** Project a document already established in this canonical read, without retaining it afterward. */
export const projectDashboardValue = ({
  db,
  userId,
  operation,
  document,
  viewContext,
}: Readonly<{
  db: D1Database;
  userId: string;
  operation: DashboardOperation;
  document: DashboardDocument;
  viewContext: Option.Option<DashboardReadContext>;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.gen(function* () {
    if (operation !== "dashboard.getDashboardView") {
      return Option.some({
        _tag: "Owner" as const,
        payload: document,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(DashboardDocument))(document),
      });
    }
    if (Option.isNone(viewContext)) return Option.none();
    const now = yield* DateTime.now;
    const facts = yield* loadDashboardFacts({
      db,
      userId,
      document,
      now,
      initial: viewContext.value,
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
