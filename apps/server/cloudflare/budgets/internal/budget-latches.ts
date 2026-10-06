import { type UserContext, UserId } from "../../../src/core/identity/contract";
import {
  BudgetCrossing,
  BudgetId,
  type BudgetMonthLatch,
  type BudgetStatus,
} from "../../../src/core/budgets/contract";
import { advanceBudgetLatch } from "../../../src/core/budgets/operations";
import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { currentProactivityGrantQuery } from "../../consent/operations";
import { newId } from "../../secret-material/operations";

/** Compose this fence before a new category grant: every pre-opt-in financial revision must already be latched under its prior eligibility. */
export const prepareOptInFence = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): D1PreparedStatement =>
  input.db
    .prepare(
      "INSERT INTO budget_mutation_assertion(id,accepted) SELECT 1,CASE WHEN NOT EXISTS (SELECT 1 FROM budget_reconciliation_work WHERE user_id=?) THEN 1 ELSE 0 END ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
    )
    .bind(input.userId);

const Marks = Schema.Struct({
  reached_80: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  reached_100: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

const latchFor = (status: BudgetStatus, marks: typeof Marks.Type): BudgetMonthLatch => {
  const budgetId = BudgetId.make(status.budget.id);
  const period = status.period;
  if (marks.reached_100 === 1) {
    return { budgetId, period, reached80: true as const, reached100: true as const };
  }
  if (marks.reached_80 === 1) {
    return { budgetId, period, reached80: true as const, reached100: false as const };
  }
  return { budgetId, period, reached80: false as const, reached100: false as const };
};

const findLatch = (
  input: Readonly<{ db: D1Database; userId: string; status: BudgetStatus }>
): Effect.Effect<Option.Option<BudgetMonthLatch>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT reached_80,reached_100 FROM budget_month_latches WHERE user_id=? AND budget_id=? AND from_utc=? AND time_zone=?"
        )
        .bind(
          input.userId,
          input.status.budget.id,
          DateTime.formatIso(input.status.period.from),
          input.status.period.timeZone
        )
        .first()
    );
    const marks =
      row === null
        ? Option.some({ reached_80: 0, reached_100: 0 })
        : Schema.decodeUnknownOption(Marks)(row);
    return Option.map(marks, (value) => latchFor(input.status, value));
  });

const encodeCrossings = (
  input: Readonly<{
    status: BudgetStatus;
    context: UserContext;
    thresholds: ReadonlyArray<BudgetCrossing["threshold"]>;
    detectedAt: DateTime.Utc;
  }>
): Effect.Effect<
  ReadonlyArray<Readonly<{ threshold: BudgetCrossing["threshold"]; json: string }>>,
  Schema.SchemaError
> =>
  Effect.forEach(input.thresholds, (threshold) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(BudgetCrossing)))(
      BudgetCrossing.make({
        budgetId: input.status.budget.id,
        categoryId: input.status.budget.categoryId,
        cap: input.status.budget.cap,
        spent: input.status.spent,
        period: input.status.period,
        threshold,
        detectedAt: input.detectedAt,
        serviceMarket: input.context.serviceMarket,
        locale: input.context.locale,
      })
    ).pipe(Effect.map((json) => ({ threshold, json })))
  );

/** Commit monotone threshold evidence and at most one pending occurrence for each threshold. */
export const reconcileStatus = ({
  db,
  userId,
  context,
  status,
}: Readonly<{
  db: D1Database;
  userId: string;
  context: UserContext;
  status: BudgetStatus;
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const timeZone = context.timeZone;
    const budgetId = status.budget.id;
    const from = DateTime.formatIso(status.period.from);
    const latch = yield* findLatch({ db, userId, status });
    if (Option.isNone(latch)) return false;
    const advanced = yield* advanceBudgetLatch({
      budget: status.budget,
      spent: status.spent,
      latch: latch.value,
    });
    const next = advanced.latch;
    const detectedAt = yield* DateTime.now;
    const groupId = newId();
    const grant = currentProactivityGrantQuery({
      userId: UserId.make(userId),
      kind: "budget-threshold",
    });
    const crossings = yield* encodeCrossings({
      status,
      context,
      thresholds: advanced.newlyReached,
      detectedAt,
    });
    const writes = [
      db
        .prepare(`INSERT INTO budget_month_latches
      (user_id, budget_id, from_utc, time_zone, reached_80, reached_100)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, budget_id, from_utc, time_zone) DO UPDATE SET
        reached_80 = max(reached_80, excluded.reached_80),
        reached_100 = max(reached_100, excluded.reached_100)`)
        .bind(userId, budgetId, from, timeZone, Number(next.reached80), Number(next.reached100)),
      ...crossings.map(({ threshold, json }) =>
        db
          .prepare(`INSERT OR IGNORE INTO budget_threshold_alerts
        (user_id, budget_id, from_utc, time_zone, threshold, crossing_json,delivery_group_id,consent_grant_id)
        SELECT user_id, budget_id, from_utc, time_zone, ?, ?,?,(${grant.sql}) FROM budget_month_latches
        WHERE user_id = ? AND budget_id = ? AND from_utc = ? AND time_zone = ?`)
          .bind(threshold, json, groupId, ...grant.params, userId, budgetId, from, timeZone)
      ),
      db
        .prepare(
          "INSERT OR IGNORE INTO budget_crossing_publications(user_id,delivery_group_id,detected_at_ms) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM budget_threshold_alerts WHERE user_id=? AND delivery_group_id=?)"
        )
        .bind(userId, groupId, detectedAt.epochMilliseconds, userId, groupId),
    ];
    return yield* Effect.tryPromise(() => db.batch(writes)).pipe(Effect.as(true));
  }).pipe(Effect.orElseSucceed(() => false));
