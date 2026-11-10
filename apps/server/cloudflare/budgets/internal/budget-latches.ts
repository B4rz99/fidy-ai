import { type UserContext, UserId } from "../../../src/core/identity/contract";
import {
  BudgetCrossing,
  BudgetMonthLatch,
  type BudgetStatus,
} from "../../../src/core/budgets/contract";
import { advanceBudgetLatch, deriveCurrentBudgetMonth } from "../../../src/core/budgets/operations";
import type { CurrencyMismatch } from "../../../src/core/_shared/money";
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

const findLatches = (
  input: Readonly<{ db: D1Database; userId: string; statuses: ReadonlyArray<BudgetStatus> }>
): Effect.Effect<Option.Option<ReadonlyArray<BudgetMonthLatch>>, Cause.UnknownError> =>
  Effect.gen(function* () {
    if (input.statuses.length === 0) return Option.some([]);
    const rows = yield* Effect.tryPromise(() =>
      input.db.batch(
        input.statuses.map((status) =>
          input.db
            .prepare(
              `SELECT coalesce(l.highest_reached, 0) AS highest_reached FROM budgets b
              LEFT JOIN budget_month_latches l ON l.user_id=b.user_id AND l.budget_id=b.id
                AND l.from_utc_ms=? AND l.time_zone=?
              WHERE b.user_id=? AND b.id=?`
            )
            .bind(
              status.period.from.epochMilliseconds,
              status.period.timeZone,
              input.userId,
              status.budget.id
            )
        )
      )
    );
    if (rows.length !== input.statuses.length) return Option.none();
    return Option.all(
      input.statuses.map((status, index) => {
        const marks = Schema.decodeUnknownOption(Schema.Array(Marks))(rows[index]?.results);
        if (Option.isNone(marks) || marks.value.length !== 1) return Option.none();
        return Option.some({
          budgetId: status.budget.id,
          period: status.period,
          highestReached: marks.value[0]?.highest_reached ?? 0,
        });
      })
    );
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

const prepareStatus = ({
  db,
  userId,
  context,
  status,
  latch,
}: Readonly<{
  db: D1Database;
  userId: string;
  context: UserContext;
  status: BudgetStatus;
  latch: BudgetMonthLatch;
}>): Effect.Effect<ReadonlyArray<D1PreparedStatement>, Schema.SchemaError | CurrencyMismatch> =>
  Effect.gen(function* () {
    const timeZone = status.period.timeZone;
    const budgetId = status.budget.id;
    const from = status.period.from.epochMilliseconds;
    const advanced = yield* advanceBudgetLatch({
      budget: status.budget,
      spent: status.spent,
      latch,
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
    return [
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
  });

/** Commit the bounded report's monotone threshold evidence and one pending occurrence per crossing. */
export const reconcileStatuses = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    context: UserContext;
    statuses: ReadonlyArray<BudgetStatus>;
  }>
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const status of input.statuses) {
      if (status.period.timeZone !== input.context.timeZone) return false;
      const captured = deriveCurrentBudgetMonth({
        now: status.period.from,
        timeZone: status.period.timeZone,
      });
      if (
        captured.from.epochMilliseconds !== status.period.from.epochMilliseconds ||
        captured.to.epochMilliseconds !== status.period.to.epochMilliseconds
      )
        return false;
    }
    const latches = yield* findLatches(input);
    if (Option.isNone(latches)) return false;
    const writes: Array<D1PreparedStatement> = [];
    for (const [index, status] of input.statuses.entries()) {
      const latch = latches.value[index];
      if (latch === undefined) return false;
      writes.push(...(yield* prepareStatus({ ...input, status, latch })));
    }
    if (writes.length === 0) return true;
    return yield* Effect.tryPromise(() => input.db.batch(writes)).pipe(Effect.as(true));
  }).pipe(Effect.orElseSucceed(() => false));
