import { type UserContext, UserId } from "../../../src/core/identity/contract";
import { readUserContext } from "../../identity/user-context/operations";
import {
  BudgetCrossing,
  BudgetId,
  type BudgetMonthLatch,
  type BudgetStatus,
} from "../../../src/core/budgets/contract";
import { advanceBudgetLatch } from "../../../src/core/budgets/operations";
import { DateTime, Effect, Option, Schema } from "effect";
import { currentBudgetReport } from "./budget-queries";

const Marks = Schema.Struct({
  reached_80: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  reached_100: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
// One period per request keeps the aggregate report and latch work independent of backlog size.
const maximumPendingWork = 1;
const PendingWork = Schema.Struct({ occurred_at: Schema.String, version: Schema.Int });

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
const reconcileStatus = ({
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
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT reached_80, reached_100 FROM budget_month_latches
    WHERE user_id = ? AND budget_id = ? AND from_utc = ? AND time_zone = ?`)
        .bind(userId, budgetId, from, timeZone)
        .first()
    );
    const marks =
      row === null
        ? Option.some({ reached_80: 0, reached_100: 0 })
        : Schema.decodeUnknownOption(Marks)(row);
    if (Option.isNone(marks)) return false;
    const advanced = yield* advanceBudgetLatch({
      budget: status.budget,
      spent: status.spent,
      latch: latchFor(status, marks.value),
    });
    const next = advanced.latch;
    const crossings = yield* encodeCrossings({
      status,
      context,
      thresholds: advanced.newlyReached,
      detectedAt: yield* DateTime.now,
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
        (user_id, budget_id, from_utc, time_zone, threshold, crossing_json)
        SELECT user_id, budget_id, from_utc, time_zone, ?, ? FROM budget_month_latches
        WHERE user_id = ? AND budget_id = ? AND from_utc = ? AND time_zone = ?`)
          .bind(threshold, json, userId, budgetId, from, timeZone)
      ),
    ];
    yield* Effect.tryPromise(() => db.batch(writes));
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

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
    const report = yield* currentBudgetReport({
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
export const reconcileBudgetLatches = ({
  db,
  userId,
}: Readonly<{
  db: D1Database;
  userId: string;
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const subject = yield* Schema.decodeEffect(UserId)(userId);
    const context = yield* readUserContext({ db, userId: subject, authority: Option.none() });
    if (Option.isNone(context)) return false;
    const pending = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT occurred_at, version
    FROM budget_reconciliation_work WHERE user_id = ? ORDER BY occurred_at LIMIT ${maximumPendingWork}`)
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
          .prepare(`DELETE FROM budget_reconciliation_work
      WHERE user_id = ? AND occurred_at = ? AND version = ?`)
          .bind(userId, item.value.occurred_at, item.value.version)
          .run()
      );
    }
    // A partially drained backlog must not allow a later correction to erase an unobserved peak.
    const remaining = yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT 1 FROM budget_reconciliation_work WHERE user_id = ? LIMIT 1")
        .bind(userId)
        .first()
    );
    return remaining === null;
  }).pipe(Effect.orElseSucceed(() => false));
