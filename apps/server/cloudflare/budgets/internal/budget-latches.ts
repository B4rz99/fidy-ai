import { type UserContext, UserId } from "../../../src/core/identity/contract";
import {
  BudgetCrossing,
  BudgetMonthLatch,
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
      "INSERT INTO sql_assertions (scope, accepted) SELECT 'budget_mutation',CASE WHEN NOT EXISTS (SELECT 1 FROM budget_evaluation_work WHERE user_id=?) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted"
    )
    .bind(input.userId);

const Marks = Schema.Struct({ highest_reached: BudgetMonthLatch.fields.highestReached });

const findLatch = (
  input: Readonly<{ db: D1Database; userId: string; status: BudgetStatus }>
): Effect.Effect<Option.Option<BudgetMonthLatch>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT highest_reached FROM budget_month_latches WHERE user_id=? AND budget_id=? AND from_utc_ms=? AND time_zone=?"
        )
        .bind(
          input.userId,
          input.status.budget.id,
          input.status.period.from.epochMilliseconds,
          input.status.period.timeZone
        )
        .first()
    );
    const marks =
      row === null
        ? Option.some({ highest_reached: 0 as const })
        : Schema.decodeUnknownOption(Marks)(row);
    return Option.map(marks, (value) => ({
      budgetId: input.status.budget.id,
      period: input.status.period,
      highestReached: value.highest_reached,
    }));
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
    const from = status.period.from.epochMilliseconds;
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
      (user_id, budget_id, from_utc_ms, time_zone, highest_reached)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, budget_id, from_utc_ms, time_zone) DO UPDATE SET
        highest_reached = max(highest_reached, excluded.highest_reached)`)
        .bind(userId, budgetId, from, timeZone, next.highestReached),
      ...crossings.map(({ threshold, json }) =>
        db
          .prepare(`INSERT OR IGNORE INTO budget_threshold_alerts
        (user_id, budget_id, from_utc_ms, time_zone, threshold, crossing_json,delivery_group_id,consent_grant_id)
        SELECT user_id, budget_id, from_utc_ms, time_zone, ?, ?,?,(${grant.sql}) FROM budget_month_latches
        WHERE user_id = ? AND budget_id = ? AND from_utc_ms = ? AND time_zone = ?`)
          .bind(threshold, json, groupId, ...grant.params, userId, budgetId, from, timeZone)
      ),
      db
        .prepare(
          "INSERT OR IGNORE INTO budget_publications(user_id,delivery_group_id,detected_at_ms) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM budget_threshold_alerts WHERE user_id=? AND delivery_group_id=?)"
        )
        .bind(userId, groupId, detectedAt.epochMilliseconds, userId, groupId),
    ];
    return yield* Effect.tryPromise(() => db.batch(writes)).pipe(Effect.as(true));
  }).pipe(Effect.orElseSucceed(() => false));
