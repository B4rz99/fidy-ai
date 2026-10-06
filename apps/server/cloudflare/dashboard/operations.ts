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
  type QueryCaller,
  type TransactionCaller,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isOAuthCaller,
  liveTransactionAuthority,
  refusedPreparation,
  transactionFailure,
  transactionNoStore,
  transactionUnavailable,
} from "../canonical-work/operations";
import {
  audit,
  credentialUse,
  dashboardCompletion,
  dashboardOutcome,
  defaultDocument,
  editWrite,
  failure,
  findDashboardDocument,
  findDashboardValue,
  firstUse,
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
import { accountQuery, editBodyPolicy } from "./internal/dashboard";

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
        work.db.prepare(dashboardCompletion),
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

/** Present an owner-encoded committed value identically for individual and atomic-batch calls. */
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
      return yield* queryDashboard({ db, subject, operation: input.operation });
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

const queryDashboard = ({
  db,
  subject,
  operation,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  operation: DashboardQueryOperation;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = DateTime.toEpochMillis(yield* DateTime.now);
    const live = yield* Effect.tryPromise(() => liveTransactionAuthority({ db, subject, current }));
    if (!live) {
      return transactionFailure({
        code: "unauthenticated",
        status: 401,
        message: "Present a valid credential and retry.",
      });
    }
    if (operation === "dashboard.listDashboardCatalog") {
      yield* accountQuery({ db, subject, current, operation });
      const data = yield* Schema.encodeEffect(Schema.toCodecJson(DashboardCatalog))(
        makeDashboardCatalog({ restaurantCategoryId: categoryIds.restaurantes })
      );
      return Response.json({ data, next: [] }, { headers: transactionNoStore });
    }
    const found = yield* findDashboardDocument({ db, userId: subject.userId });
    if (Option.isNone(found)) {
      yield* accountQuery({ db, subject, current, operation });
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
    const value = yield* findDashboardValue({ db, userId: subject.userId, operation });
    if (Option.isNone(value) || value.value._tag !== "Owner") return transactionUnavailable();
    yield* accountQuery({ db, subject, current, operation });
    return yield* presentDashboard(value.value);
  }).pipe(
    Effect.catchTag("DashboardQueryLimited", () =>
      Effect.succeed(
        transactionFailure({
          code: "rate_limited",
          status: 429,
          message: "Daily audit budget exhausted.",
        })
      )
    ),
    Effect.orElseSucceed(transactionUnavailable)
  );
