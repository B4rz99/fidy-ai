import { Money } from "../../src/core/_shared/money";
import { findDashboardAggregate } from "../transactions/operations";
import {
  acceptsGroupCapPrecision,
  acceptsGroupCurrency,
  prepareGroupCurrency,
} from "./internal/group-currency";
import {
  type BudgetCrossingRead,
  BudgetCrossingUnavailable,
  type BudgetOutcome,
  type BudgetQueryOperation,
} from "./contract";
import {
  Budget,
  type BudgetCrossing,
  BudgetId,
  type BudgetStatusQueryParameters,
  BudgetStatusReport,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from "../../src/core/budgets/contract";
import { BigDecimal, DateTime, Effect, Option, Schema } from "effect";
import {
  type QueryCaller,
  type TransactionBoundaryFailure,
  type TransactionCaller,
  boundaryFailure,
  callerAuthority,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isPATCaller,
  refusedPreparation,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionUnavailable,
} from "../canonical-work/operations";
import { monthlyCashFlow } from "./internal/monthly-cash-flow";
import { recordBudgetCall } from "./internal/budget-audit";
import { budgetFromRow } from "./internal/budget-row";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type GuardRefusalWork,
} from "../canonical-operations/contract";
import { type OAuthMutationReview } from "../oauth-confirmation/contract";
import { recordLivePATUse } from "../../src/shell/tokens/operations";
import { budgetOutcome, findOwnedBudget } from "./internal/budget-outcome";
import { calculateBudgetStatus } from "../../src/core/budgets/operations";
import { type UserContext, UserId } from "../../src/core/identity/contract";
import { readUserContext } from "../identity/user-context/operations";
import { budgetParameters, budgetPeriod } from "./internal/budget-queries";
import {
  authorityReady,
  budgetAudit,
  budgetCommitGuards,
  categoryExists,
  createBudgetStatement,
  findConflict,
  prepareBudgetMonthUpdate,
  prepareMonthlyCap,
  prepareMonthlyPlan,
  reviewBudget,
  updateBudgetStatement,
} from "./internal/budgets";
import { prepareOptInFence, reconcileStatus } from "./internal/budget-latches";
import {
  discoverUsers,
  findFirstCreation,
  noteEvaluation,
  prepareFirstOffer,
  preparePublication,
  readGroups,
} from "./internal/budget-proactivity";
import { readCrossings } from "./internal/budget-crossings";
import { readConsentStatus } from "../consent/operations";

const HTTP_NOT_FOUND = 404;

const HTTP_BAD_REQUEST = 400;

type BudgetMutationOperation = BudgetOutcome["operation"];

/** Record and present an owner-decided refusal under the same caller's live authority. */
export const budgetRefusal = ({
  db,
  subject,
  operation,
  current,
  code,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: BudgetMutationOperation;
  current: number;
  code: "not_found" | "validation_failed";
}>): CanonicalMutationRefusal => ({
  code,
  message: code === "not_found" ? "Budget or Category unavailable." : "Budget input unavailable.",
  record: () => recordBudgetCall({ db, subject, operation, current, outcome: "rejected" }),
  respond: () =>
    Effect.succeed(
      transactionFailure({
        code,
        status: code === "not_found" ? HTTP_NOT_FOUND : HTTP_BAD_REQUEST,
        message:
          code === "not_found" ? "Budget or Category unavailable." : "Budget input unavailable.",
      })
    ),
});

/** Explain a proved Budget completion using retained earlier children and the post-rollback owner row. */
const budgetGuardRefusal =
  (outcome: BudgetOutcome) =>
  ({
    db,
    subject,
    current,
    earlier,
  }: GuardRefusalWork): Effect.Effect<CanonicalMutationRefusal> => {
    const refusal = (code: "not_found" | "validation_failed"): CanonicalMutationRefusal =>
      budgetRefusal({ db, subject, current, operation: outcome.operation, code });
    if (outcome.operation === "budgets.createBudget") {
      return Effect.succeed(refusal("validation_failed"));
    }
    if (
      earlier.some(
        (child) =>
          child._tag === "Owner" &&
          Option.isSome(child.guardFacts) &&
          child.guardFacts.value._tag === "Budget" &&
          child.guardFacts.value.operation === "budgets.deleteBudget" &&
          child.guardFacts.value.budgetId === outcome.budgetId
      )
    ) {
      return Effect.succeed(refusal("not_found"));
    }
    return findOwnedBudget({
      db,
      userId: subject.userId,
      id: outcome.budgetId,
      month: outcome.month,
    }).pipe(
      Effect.map((owned) => refusal(Option.isNone(owned) ? "not_found" : "validation_failed")),
      Effect.orElseSucceed(() => refusal("validation_failed"))
    );
  };

const statements = ({
  db,
  subject,
  outcome,
  write,
  current,
  oauthReview,
  before,
  after,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  outcome: BudgetOutcome;
  write: D1PreparedStatement;
  current: number;
  oauthReview: Option.Option<OAuthMutationReview>;
  before: ReadonlyArray<D1PreparedStatement>;
  after: ReadonlyArray<D1PreparedStatement>;
}>): CanonicalMutationPreparation => ({
  _tag: "Prepared",
  mutation: {
    oauthReview,
    requiredScope: callerScope(subject),
    outcome: budgetOutcome(outcome),

    commitGuards: Option.some(({ db, userId, index }) =>
      budgetCommitGuards({
        db,
        userId,
        index,
        operation: outcome.operation,
      })
    ),
    guardRefusal: budgetGuardRefusal(outcome),
    statements: [
      ...(isPATCaller(subject)
        ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
            db.prepare(sql).bind(...params)
          )
        : []),
      ...before,
      write,
      ...after,
      budgetAudit({ db, subject, operation: outcome.operation, current }),
    ],
  },
});

const refuseBudget = ({
  db,
  subject,
  current,
  operation,
  code,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  operation: BudgetOutcome["operation"];
  code: "not_found" | "validation_failed";
}>): CanonicalMutationPreparation =>
  refusedPreparation(budgetRefusal({ db, subject, current, operation, code }));

const checkedBudgetWrite = ({
  db,
  subject,
  current,
  categoryId,
  currency,
  exceptId,
  owned,
  operation,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  categoryId: string;
  currency: string;
  exceptId: string;
  owned: boolean;
  operation: BudgetOutcome["operation"];
}>): Effect.Effect<Option.Option<CanonicalMutationPreparation>, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    if (!(yield* authorityReady({ db, subject, current }))) {
      return Option.some(credentialRefusedPreparation());
    }
    if (!owned) {
      return Option.some(
        refusedPreparation(budgetRefusal({ db, subject, operation, current, code: "not_found" }))
      );
    }
    if (!(yield* categoryExists({ db, categoryId }))) {
      return Option.some(
        refusedPreparation(budgetRefusal({ db, subject, operation, current, code: "not_found" }))
      );
    }
    if (
      yield* Effect.tryPromise({
        try: () => findConflict({ db, userId: subject.userId, categoryId, currency, exceptId }),
        catch: boundaryFailure,
      })
    ) {
      return Option.some(
        refusedPreparation(
          budgetRefusal({ db, subject, operation, current, code: "validation_failed" })
        )
      );
    }
    return Option.none();
  });

const refuseInvalidBudget = (
  input: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    current: number;
    operation: "budgets.createBudget" | "budgets.updateBudget";
  }>
): CanonicalMutationPreparation => refuseBudget({ ...input, code: "validation_failed" });

/**
 * Prepare one positive cap for a known Category under live caller authority. The canonical User
 * unit commits these guarded writes with its accountability evidence or commits none of them.
 */
export const prepareCreateBudget = ({
  db,
  subject,
  payload,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  payload: CreateBudgetInput;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const id = BudgetId.make(transactionId());
    const rejected = yield* checkedBudgetWrite({
      db,
      subject,
      current,
      categoryId: payload.categoryId,
      currency: payload.cap.currency,
      exceptId: id,
      owned: true,
      operation: "budgets.createBudget",
    });
    if (Option.isSome(rejected)) return rejected.value;
    if (
      !(yield* acceptsGroupCurrency({
        db,
        userId: subject.userId,
        payload,
        existing: Option.none(),
      }))
    ) {
      return refuseInvalidBudget({ db, subject, current, operation: "budgets.createBudget" });
    }
    return statements({
      db,
      subject,
      current,
      outcome: {
        _tag: "Budget",
        operation: "budgets.createBudget",
        budgetId: id,
        month: Option.fromUndefinedOr(payload.month),
      },
      oauthReview: Option.none(),
      before: [
        ...(payload.month === undefined
          ? []
          : prepareMonthlyPlan({ db, subject, current, month: payload.month })),
        ...prepareGroupCurrency({ db, subject, current, payload }),
      ],
      after: prepareMonthlyCap({ db, subject, current, id, payload }),
      write: createBudgetStatement({ db, subject, current, id, payload }),
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));

type BudgetUpdatePreparation = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: BudgetId;
  payload: UpdateBudgetInput;
  current: number;
}>;

const acceptsBudgetUpdate = ({
  db,
  subject,
  id,
  payload,
}: BudgetUpdatePreparation): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const planned = yield* findOwnedBudget({
      db,
      userId: subject.userId,
      id,
      month: Option.fromUndefinedOr(payload.month),
    });
    if (Option.isNone(planned)) return false;
    return (
      (yield* acceptsGroupCurrency({ db, userId: subject.userId, payload, existing: planned })) &&
      (yield* acceptsGroupCapPrecision({ db, userId: subject.userId, payload }))
    );
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * Prepare a caller-owned Category/cap revision. Group currency is versioned explicitly; commit-time
 * guards recheck Category existence, uniqueness, and authority without reopening monthly marks.
 */
export const prepareUpdateBudget = ({
  db,
  subject,
  id,
  payload,
  current,
}: BudgetUpdatePreparation): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const existing = yield* findOwnedBudget({
      db,
      userId: subject.userId,
      id,
      month: Option.none(),
    });
    if (Option.isNone(existing)) {
      return refuseBudget({
        db,
        subject,
        current,
        operation: "budgets.updateBudget",
        code: "not_found",
      });
    }
    if (!(yield* acceptsBudgetUpdate({ db, subject, id, payload, current }))) {
      return refuseInvalidBudget({ db, subject, current, operation: "budgets.updateBudget" });
    }
    const rejected = yield* checkedBudgetWrite({
      db,
      subject,
      current,
      categoryId: payload.categoryId,
      currency: payload.cap.currency,
      exceptId: id,
      owned: true,
      operation: "budgets.updateBudget",
    });
    if (Option.isSome(rejected)) return rejected.value;
    return statements({
      db,
      subject,
      current,
      outcome: {
        _tag: "Budget",
        operation: "budgets.updateBudget",
        budgetId: id,
        month: Option.fromUndefinedOr(payload.month),
      },
      before: prepareBudgetMonthUpdate({ db, subject, current, id, payload }),
      after: [],
      oauthReview: yield* reviewBudget({
        db,
        userId: subject.userId,
        budget: existing.value,
        action: "Cambiar",
        groupCategoryIds: Option.fromUndefinedOr(payload.groupCategoryIds),
      }),
      write: updateBudgetStatement({ db, subject, current, id, payload }),
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Prepare removal of one caller-owned Budget and its operational marks in the canonical unit. */
export const prepareDeleteBudget = ({
  db,
  subject,
  id,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: BudgetId;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    if (!(yield* authorityReady({ db, subject, current }))) return credentialRefusedPreparation();
    const existing = yield* findOwnedBudget({
      db,
      userId: subject.userId,
      id,
      month: Option.none(),
    });
    if (Option.isNone(existing)) {
      return refusedPreparation(
        budgetRefusal({
          db,
          subject,
          current,
          operation: "budgets.deleteBudget",
          code: "not_found",
        })
      );
    }
    const authority = callerAuthority({ subject, current });
    return statements({
      db,
      subject,
      current,
      outcome: {
        _tag: "Budget",
        operation: "budgets.deleteBudget",
        budgetId: id,
        month: Option.none(),
      },
      before: [],
      after: [],
      oauthReview: yield* reviewBudget({
        db,
        userId: subject.userId,
        budget: existing.value,
        action: "Eliminar",
        groupCategoryIds: Option.none(),
      }),
      write: db
        .prepare(`DELETE FROM budgets WHERE user_id = ? AND id = ?
        AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
        .bind(subject.userId, id, ...authority.bindings),
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));

const maximumBudgetCount = 128;
const monthLabelLength = 7;

const readPlannedCaps = ({
  db,
  userId,
  month,
  includeInactive,
}: Readonly<{
  db: D1Database;
  userId: string;
  month: string;
  includeInactive: boolean;
}>): Effect.Effect<Option.Option<ReadonlyArray<Budget>>> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT b.id,b.category_id,
      COALESCE((SELECT g.currency FROM (SELECT rowid,user_id,group_name,month,currency FROM budget_month_plan_records WHERE kind='currency') g WHERE g.user_id=b.user_id AND g.group_name=b.group_name AND g.month<=? ORDER BY g.month DESC LIMIT 1),b.currency) AS currency,
      COALESCE((SELECT p.cap FROM (SELECT rowid,user_id,budget_id,month,cap FROM budget_month_plan_records WHERE kind='cap') p WHERE p.user_id=b.user_id AND p.budget_id=b.id AND p.month<=? ORDER BY p.month DESC LIMIT 1),b.cap) AS cap,
      b.created_at,b.updated_at,b.group_name FROM budgets b WHERE b.user_id=? AND (?=1 OR b.starts_month IS NULL OR b.starts_month<=?)
      ORDER BY b.currency,b.category_id LIMIT ${maximumBudgetCount + 1}`)
        .bind(month, month, userId, includeInactive ? 1 : 0, month)
        .all()
    );
    if (rows.results.length > maximumBudgetCount) return Option.none<ReadonlyArray<Budget>>();
    return Option.some(yield* Effect.forEach(rows.results, budgetFromRow));
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const respond = <A>(schema: Schema.Codec<A, Schema.Json>, data: A): Response =>
  Response.json(
    { data: Schema.encodeSync(schema)(data), next: [] },
    { headers: transactionNoStore }
  );

const invalid = (): Response =>
  transactionFailure({ code: "validation_failed", status: 400, message: "Invalid Budget query." });

const missing = (): Response =>
  transactionFailure({ code: "not_found", status: 404, message: "Budget unavailable." });

/**
 * Read one User's complete, ordered public cap projection for authorized peer work. The caller
 * establishes authority and serializes that User's work; an id alone is not authority. An invalid
 * or oversized retained set is unavailable, never a partial answer.
 */
export const readBudgetCaps = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<
  Option.Option<ReadonlyArray<Budget>>
> =>
  Effect.gen(function* () {
    const context = yield* readUserContext({
      db,
      userId: UserId.make(userId),
      authority: Option.none(),
    });
    if (Option.isNone(context)) return Option.none<ReadonlyArray<Budget>>();
    const now = yield* DateTime.now;
    const month = DateTime.formatIsoDate(
      DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(context.value.timeZone))
    ).slice(0, monthLabelLength);
    return yield* readPlannedCaps({ db, userId, month, includeInactive: true });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

/**
 * Read spending and cash flow from one complete Transaction-owned aggregate snapshot.
 * The caller supplies one authorized, coordinated User and an explicit IANA zone;
 * unavailable projections never supply partial totals.
 */
export const readBudgetSpending = ({
  db,
  userId,
  query,
  now,
}: Readonly<{
  db: D1Database;
  userId: string;
  query: typeof BudgetStatusQueryParameters.Type;
  now: DateTime.Utc;
}>): Effect.Effect<Option.Option<BudgetStatusReport>> =>
  Effect.gen(function* () {
    const period = budgetPeriod({ now, query });
    const month = DateTime.formatIsoDate(
      DateTime.setZone(period.from, DateTime.zoneMakeNamedUnsafe(query.timeZone))
    ).slice(0, monthLabelLength);
    const budgets = yield* readPlannedCaps({ db, userId, month, includeInactive: false });
    if (Option.isNone(budgets)) return Option.none<BudgetStatusReport>();
    const initialized =
      (yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT 1 FROM (SELECT rowid,user_id,month FROM budget_month_plan_records WHERE kind='plan') WHERE user_id=? AND month=?"
          )
          .bind(userId, month)
          .first()
      )) !== null;
    const aggregates = yield* findDashboardAggregate({
      db,
      userId,
      from: DateTime.toEpochMillis(period.from),
      toExclusive: DateTime.toEpochMillis(period.to),
    });
    if (Option.isNone(aggregates)) return Option.none<BudgetStatusReport>();
    const statuses = yield* Effect.forEach(
      budgets.value.filter(
        (budget) =>
          (query.categoryId === undefined || budget.categoryId === query.categoryId) &&
          (query.currency === undefined || budget.cap.currency === query.currency)
      ),
      (budget) =>
        calculateBudgetStatus({
          budget,
          period,
          spent:
            aggregates.value.find(
              (row) =>
                row.direction === "outflow" &&
                row.categoryId === budget.categoryId &&
                row.sum.currency === budget.cap.currency
            )?.sum ?? Money.make({ amount: BigDecimal.make(0n, 0), currency: budget.cap.currency }),
        })
    );
    return Option.some({
      period,
      statuses,
      initialized,
      cashFlow: monthlyCashFlow({ aggregates: aggregates.value, query }),
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const readAuthorizedBudget = ({
  db,
  subject,
  operation,
  id,
  query,
  now,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  operation: BudgetQueryOperation;
  id: Option.Option<BudgetId>;
  query: Option.Option<typeof BudgetStatusQueryParameters.Type>;
  now: DateTime.Utc;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (operation === "budgets.getBudget") {
      const budgets = yield* readBudgetCaps({ db, userId: subject.userId });
      if (Option.isNone(budgets)) return transactionUnavailable();
      const found = budgets.value.find((budget) => budget.id === Option.getOrThrow(id));
      return found === undefined ? missing() : respond(Schema.toCodecJson(Budget), found);
    }
    if (operation === "budgets.listBudgets") {
      const all = yield* readBudgetCaps({ db, userId: subject.userId });
      return Option.isSome(all)
        ? respond(Schema.toCodecJson(Schema.Array(Budget)), all.value)
        : transactionUnavailable();
    }
    const report = yield* readBudgetSpending({
      db,
      userId: subject.userId,
      query: Option.getOrThrow(query),
      now,
    });
    return Option.isSome(report)
      ? respond(Schema.toCodecJson(BudgetStatusReport), report.value)
      : transactionUnavailable();
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

/** Observe Budget facts with live authority and accountability, without advancing pending alerts. */
export const browseBudgets = ({
  db,
  subject,
  request,
  operation,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  request: Request;
  operation: BudgetQueryOperation;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const parsed = budgetParameters({ operation, url: new URL(request.url) });
    const outcome = Option.isSome(parsed) ? "accepted" : "rejected";
    if (
      (yield* recordBudgetCall({
        db,
        subject,
        operation,
        outcome,
        current: DateTime.toEpochMillis(now),
      })) !== "recorded"
    ) {
      return transactionUnavailable();
    }
    if (Option.isNone(parsed)) return operation === "budgets.getBudget" ? missing() : invalid();
    return yield* readAuthorizedBudget({ db, subject, operation, now, ...parsed.value });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

/** Commit-time fence for a new Budget grant; pending pre-opt-in financial reconciliation must be fully drained before legal activation. */
export const prepareBudgetOptInFence: typeof prepareOptInFence = (input) =>
  prepareOptInFence(input);

/** Bounded pending same-User delivery groups retain the grant captured at detection, including explicit ineligibility. */
export const readBudgetCrossingGroups: typeof readGroups = (input) => readGroups(input);

/** Acknowledge frozen publication only in the peer's atomic occurrence unit, under its same-User occurrence proof. */
export const prepareBudgetCrossingPublication: typeof preparePublication = (input) =>
  preparePublication(input);

/** Bounded identity-only pending publication hints; no financial facts or execution authority. */
export const discoverBudgetCrossingUsers: typeof discoverUsers = (input) => discoverUsers(input);

/** Rotate identity-only pending publication hints after an attempted coordinated evaluation. */
export const noteBudgetCrossingEvaluation: typeof noteEvaluation = (input) => noteEvaluation(input);

/** Observe the original first-Budget milestone once, without reading financial content. */
export const findFirstBudgetOffer: typeof findFirstCreation = (input) => findFirstCreation(input);

/** Acknowledge the first-Budget milestone in the atomic contextual request unit under the peer's same-User request proof. */
export const prepareFirstBudgetOffer: typeof prepareFirstOffer = (input) =>
  prepareFirstOffer(input);

const matchesCrossingMonth = (
  crossing: BudgetCrossing,
  input: Pick<BudgetCrossingRead, "budgetId" | "period">
): boolean =>
  crossing.budgetId === input.budgetId &&
  crossing.period.timeZone === input.period.timeZone &&
  crossing.period.from.epochMilliseconds === input.period.from.epochMilliseconds &&
  crossing.period.to.epochMilliseconds === input.period.to.epochMilliseconds;

/** Read complete immutable threshold facts for one explicit User/month under live processing Consent and caller-owned coordination. Legacy rows without captured facts are unavailable, never rebuilt from current state. */
export const readBudgetCrossings = (
  input: BudgetCrossingRead
): Effect.Effect<ReadonlyArray<BudgetCrossing>, BudgetCrossingUnavailable> =>
  Effect.gen(function* () {
    const standing = yield* readConsentStatus(input).pipe(
      Effect.mapError(() => new BudgetCrossingUnavailable())
    );
    if (standing !== "Granted") return yield* new BudgetCrossingUnavailable();
    const rows = yield* readCrossings(input);
    const thresholds = new Set<number>();
    for (const row of rows) {
      const crossing = row.crossing_json;
      if (
        thresholds.has(row.threshold) ||
        crossing.threshold !== row.threshold ||
        !matchesCrossingMonth(crossing, input)
      ) {
        return yield* new BudgetCrossingUnavailable();
      }
      thresholds.add(row.threshold);
    }
    return rows
      .map((row) => row.crossing_json)
      .sort((left, right) => left.threshold - right.threshold);
  });

const maximumPendingWork = 1;

const PendingWork = Schema.Struct({ occurred_at: Schema.String, version: Schema.Int });

const reconcilePendingPeriod = ({
  db,
  userId,
  context,
  now,
}: Readonly<{
  db: D1Database;
  userId: string;
  context: UserContext;
  now: DateTime.Utc;
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const report = yield* readBudgetSpending({
      db,
      userId,
      query: { timeZone: context.timeZone },
      now,
    });
    if (Option.isNone(report)) return false;
    for (const status of report.value.statuses) {
      if (!(yield* reconcileStatus({ db, userId, context, status }))) return false;
    }
    return true;
  });

/**
 * Consume durable work written atomically by D1 movement/Budget triggers. Work for a backdated
 * correction uses its own zoned month, not the request's current month. The versioned removal
 * leaves a concurrent writer's work pending even if it arrives during an earlier drain.
 */
export const evaluateBudgetAlerts = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const subject = yield* Schema.decodeEffect(UserId)(userId);
    const context = yield* readUserContext({ db, userId: subject, authority: Option.none() });
    if (Option.isNone(context)) return false;
    const pending = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT occurred_at, version
    FROM budget_state WHERE kind='work' AND user_id = ? ORDER BY occurred_at LIMIT ${maximumPendingWork}`)
        .bind(userId)
        .all()
    );
    for (const row of pending.results) {
      const item = Schema.decodeUnknownOption(PendingWork)(row);
      if (Option.isNone(item)) return false;
      const instant = DateTime.make(item.value.occurred_at);
      if (Option.isNone(instant)) return false;
      if (
        !(yield* reconcilePendingPeriod({ db, userId, context: context.value, now: instant.value }))
      ) {
        return false;
      }
      yield* Effect.tryPromise(() =>
        db
          .prepare(`DELETE FROM budget_state
      WHERE kind='work' AND user_id = ? AND occurred_at = ? AND version = ?`)
          .bind(userId, item.value.occurred_at, item.value.version)
          .run()
      );
    }
    const remaining = yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT 1 FROM budget_state WHERE kind='work' AND user_id = ? LIMIT 1")
        .bind(userId)
        .first()
    );
    return remaining === null;
  }).pipe(Effect.orElseSucceed(() => false));
