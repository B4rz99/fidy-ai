import { prepareAuthorizedAuditCall } from "../../src/shell/audit/operations";
import {
  prepareChangedRowAssertion,
  prepareReservedChangeCheck,
} from "../../src/shell/sql-assertions/operations";
import {
  type CanonicalBrowserQueryFinalizer,
  type CanonicalBrowserRead,
  type CanonicalReadCompletion,
} from "../canonical-admission/contract";
import {
  type QueryCaller,
  type TransactionCaller,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isOAuthCaller,
  liveTransactionAuthority,
  refusedPreparation,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../canonical-work/operations";

import { prepareCanonicalBrowserQueryFinalization } from "../canonical-admission/operations";
import { makeDashboardTiming } from "./internal/dashboard-timing";

import { DateTime, Effect, Option, Result, Schema } from "effect";

import { boundedJsonBody } from "../http/operations";
import { applyDashboardEdit, makeDashboardCatalog } from "../../src/core/dashboard/operations";
import { categoryIds } from "../../src/core/categories/contract";
import {
  DashboardCatalog,
  type DashboardDocument,
  DashboardEdit,
} from "../../src/core/dashboard/contract";
import { DashboardUninitialized } from "../../src/shell/dashboard/contract";

import {
  audit,
  credentialUse,
  dashboardOutcome,
  defaultDocument,
  editWrite,
  failure,
  findDashboardDocument,
  findDashboardSource,
  firstUse,
  projectDashboardValue,
  validCategories,
} from "./internal/dashboard-mutation";
import {
  type DashboardMutationOperation,
  type DashboardQueryOperation,
  type DashboardRequest,
} from "./contract";

import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type CommittedMutationValue,
} from "../canonical-operations/contract";
import { dashboardOAuthReview, oauthDefaultDashboard } from "./internal/oauth-review";
import { type OAuthMutationReview } from "../oauth-confirmation/contract";
import { accountQuery, editBodyPolicy, prepareQueryAccounting } from "./internal/dashboard";

type MutationContext = Readonly<{ db: D1Database; subject: TransactionCaller; current: number }>;

/** Record and present a closed owner refusal under the same live caller's authority. */
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
        audit({ work, operation, outcome: "rejected" }),
        prepareChangedRowAssertion({ db: work.db, scope: "dashboard" }),
      ])
    ).pipe(
      Effect.map(() => "recorded" as const),
      Effect.orElseSucceed(() => "unavailable" as const)
    ),
  respond: (disposition) =>
    Effect.succeed(disposition === "recorded" ? failure(code) : transactionUnavailable()),
});

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
    const valid = yield* validCategories({ db: work.db, document: result.success });
    if (Option.isNone(valid)) return Result.fail(failedPreparation());
    return valid.value
      ? Result.succeed(result.success)
      : Result.fail(
          refusedPreparation(dashboardRefusal({ work, operation, code: "validation_failed" }))
        );
  });

const preparedDashboard = ({
  work,
  operation,
  initial,
  write,
  oauthReview,
}: Readonly<{
  work: MutationContext;
  operation: DashboardMutationOperation;
  initial: Option.Option<D1PreparedStatement>;
  write: ReadonlyArray<D1PreparedStatement>;
  oauthReview: Option.Option<OAuthMutationReview>;
}>): CanonicalMutationPreparation => ({
  _tag: "Prepared",
  mutation: {
    oauthReview,
    requiredScope: callerScope(work.subject),

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
      ...(operation === "dashboard.applyDashboardEdit" && Option.isSome(initial)
        ? [prepareChangedRowAssertion({ db: work.db, scope: "dashboard" })]
        : []),
      ...write,
      ...(write.length > 0
        ? [prepareChangedRowAssertion({ db: work.db, scope: "dashboard" })]
        : []),
      audit({ work, operation, outcome: "accepted" }),
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

/**
 * Prepare explicit initialization or one validated edit for the shared one-User atomic
 * unit. Initialization returns an existing document without changing its content or revision.
 * The caller owns the commit boundary; live credential, revision and accountability guards are
 * rechecked there. An invalid initial edit leaves no document; batch collision and failure
 * attribution stay intact.
 */
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
    const existing = yield* findDashboardDocument({
      db: work.db,
      userId: work.subject.userId,
    });
    const base = Option.getOrElse(
      Option.map(existing, (stored) => stored.document),
      () => (isOAuthCaller(work.subject) ? oauthDefaultDashboard() : defaultDocument())
    );
    const decision = yield* decideDocument({ work, operation, edit, base });
    if (Result.isFailure(decision)) return decision.failure;
    const document = decision.success;
    const initial = Option.isSome(existing)
      ? Option.none()
      : Option.some(yield* firstUse({ work, document: base }));
    const write = yield* editWrite({
      work,
      operation,
      document,
      revision: Option.isSome(existing) ? existing.value.revision : 1,
    });
    const oauthReview = yield* dashboardOAuthReview({
      ...work,
      operation,
      existing,
      document,
      edit,
    });
    return preparedDashboard({ work, operation, initial, write, oauthReview });
  }).pipe(Effect.orElseSucceed(failedPreparation));

export const presentDashboard = (
  value: Extract<CommittedMutationValue, { _tag: "Owner" }>
): Effect.Effect<Response> =>
  value.encode().pipe(
    Effect.map((data) => Response.json({ data, next: [] }, { headers: transactionNoStore })),
    Effect.orElseSucceed(transactionUnavailable)
  );

/**
 * Execute the caller's canonical Dashboard operation under live credential and User authority.
 * Only explicit initialization and edits use the canonical mutation unit; queries never create or
 * repair domain state and return DashboardUninitialized for genuine absence. Views expose complete,
 * validated projections from the Categories, Transactions and Budgets published operations.
 * The caller applies canonical scope policy and dispatches document queries and mutations through the same User's
 * coordinator. Its turn covers every projection read, so a Correction cannot split a chart snapshot.
 * A subject identity is never a reusable authorization grant.
 */
export const browseDashboard = (input: DashboardRequest): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { db, subject, request, operation } = input;
    if (operation !== "dashboard.applyDashboardEdit" && request.url.includes("?")) {
      return transactionFailure({
        code: "validation_failed",
        status: 400,
        message: "Invalid Dashboard input.",
      });
    }
    if (!("runMutation" in input)) {
      return yield* queryDashboard({
        db,
        subject,
        operation: input.operation,
        completion: input.completion,
      });
    }
    const edit =
      operation === "dashboard.applyDashboardEdit"
        ? yield* boundedJsonBody({
            request,
            policy: editBodyPolicy,
            schema: Schema.toCodecJson(DashboardEdit),
          }).pipe(Effect.orElseSucceed(() => Option.none()))
        : Option.none<DashboardEdit>();
    return input.operation === "dashboard.applyDashboardEdit"
      ? yield* input.runMutation({
          operation: input.operation,
          input: Option.map(edit, (payload) => ({ payload })),
        })
      : yield* input.runMutation({ operation: input.operation, input: Option.some({}) });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const uninitializedDashboard: Effect.Effect<Response, Schema.SchemaError> = Effect.gen(
  function* () {
    const failure = DashboardUninitialized.make({
      error: {
        code: "dashboard_uninitialized",
        message: "Initialize your Dashboard explicitly, then read it again.",
      },
      next: [],
    });
    const body = yield* Schema.encodeEffect(Schema.toCodecJson(DashboardUninitialized))(failure);
    return Response.json(body, { status: 404, headers: transactionNoStore });
  }
);

const refusedDashboardCaller = (): Response =>
  transactionFailure({
    code: "unauthenticated",
    status: 401,
    message: "Present a valid credential and retry.",
  });

const dashboardFinalization = ({
  db,
  subject,
  completion,
  operation,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  completion: Option.Option<CanonicalReadCompletion>;
  operation: DashboardQueryOperation;
}>): Option.Option<CanonicalBrowserQueryFinalizer> =>
  Option.isSome(completion) && "id" in subject
    ? Option.some(
        prepareCanonicalBrowserQueryFinalization({
          db,
          subject,
          completion: completion.value,
          accounting: (current) => prepareQueryAccounting({ db, subject, current, operation }),
        })
      )
    : Option.none();

const limitedDashboardResponse = (): Effect.Effect<Response> =>
  Effect.succeed(
    transactionFailure({
      code: "rate_limited",
      status: 429,
      message: "Daily audit budget exhausted.",
    })
  );

const presentDashboardCatalog = (): Effect.Effect<Response, Schema.SchemaError> =>
  Schema.encodeEffect(Schema.toCodecJson(DashboardCatalog))(
    makeDashboardCatalog({ restaurantCategoryId: categoryIds.restaurantes })
  ).pipe(Effect.map((data) => Response.json({ data, next: [] }, { headers: transactionNoStore })));

const readDashboardCatalog = (
  input: Parameters<typeof accountQuery>[0]
): Effect.Effect<Response, Effect.Error<ReturnType<typeof accountQuery>> | Schema.SchemaError> =>
  accountQuery(input).pipe(Effect.andThen(presentDashboardCatalog()));

/** The static catalog needs only one complete browser authority, pressure and accounting unit. */
export const prepareBoundDashboardCatalog: CanonicalBrowserRead = ({
  db,
  authority,
  reservation,
  current,
}) => ({
  statements: [
    prepareAuthorizedAuditCall({
      db,
      authority,
      id: transactionId(),
      current,
      operation: "dashboard.listDashboardCatalog",
      outcome: "accepted",
      afterOwnerWrite: false,
    }),
    prepareReservedChangeCheck({ db, scope: "dashboard", reservation }),
  ],
  present: () => presentDashboardCatalog().pipe(Effect.orElseSucceed(transactionUnavailable)),
});

const queryDashboard = ({
  db,
  subject,
  operation,
  completion,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  completion: Option.Option<CanonicalReadCompletion>;
  operation: DashboardQueryOperation;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const final = dashboardFinalization({ db, subject, completion, operation });
    const measured = makeDashboardTiming(operation === "dashboard.getDashboardView");
    const current = DateTime.toEpochMillis(yield* DateTime.now);
    const live =
      operation === "dashboard.getDashboardView" ||
      (yield* Effect.tryPromise(() => liveTransactionAuthority({ db, subject, current })));
    if (!live) return refusedDashboardCaller();
    if (operation === "dashboard.listDashboardCatalog") {
      return yield* readDashboardCatalog({ db, subject, current, operation });
    }
    const source = yield* measured.measure(
      "source",
      findDashboardSource({ db, subject, current, operation })
    );
    if (!source.live) return refusedDashboardCaller();
    if (Option.isNone(source.document)) {
      yield* accountQuery({ db, subject, current, operation });
      return yield* uninitializedDashboard;
    }
    const value = yield* measured.measure(
      "projection",
      projectDashboardValue({
        db,
        userId: subject.userId,
        operation,
        document: source.document.value.document,
        viewContext: source.viewContext,
        finalization: Option.map(final, (value) => value.finalization),
      })
    );
    if (Option.isNone(value) || value.value._tag !== "Owner") return transactionUnavailable();
    yield* measured.measure(
      "audit",
      Option.match(final, {
        onNone: () => accountQuery({ db, subject, current, operation }),
        onSome: () => Effect.void,
      })
    );
    const response = yield* presentDashboard(value.value);
    return measured.respond(
      Option.match(final, { onNone: () => response, onSome: (value) => value.present(response) })
    );
  }).pipe(
    Effect.catchTag("DashboardQueryLimited", limitedDashboardResponse),
    Effect.orElseSucceed(transactionUnavailable)
  );
