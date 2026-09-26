import {
  BudgetId,
  type BudgetMonthLatch,
  type BudgetStatus,
  IanaTimeZone,
  advanceBudgetLatch,
  deriveCurrentBudgetMonth,
} from "@fidy/server/budgets-runtime";
import { DateTime, Effect, Option, Schema } from "effect";
import { currentBudgetReport } from "./budget-queries";

const UserZone = Schema.Struct({ time_zone: IanaTimeZone });
const Marks = Schema.Struct({
  reached_80: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  reached_100: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
const eighty = 80;
const hundred = 100;
const maximumPendingWork = 64;
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

/** Commit monotone threshold evidence and at most one pending occurrence for each threshold. */
const reconcileStatus = ({
  db,
  userId,
  timeZone,
  status,
}: Readonly<{
  db: D1Database;
  userId: string;
  timeZone: IanaTimeZone;
  status: BudgetStatus;
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
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
    const writes = [
      db
        .prepare(`INSERT INTO budget_month_latches
      (user_id, budget_id, from_utc, time_zone, reached_80, reached_100)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, budget_id, from_utc, time_zone) DO UPDATE SET
        reached_80 = max(reached_80, excluded.reached_80),
        reached_100 = max(reached_100, excluded.reached_100)`)
        .bind(userId, budgetId, from, timeZone, Number(next.reached80), Number(next.reached100)),
      ...([eighty, hundred] as const)
        .filter((threshold) => (threshold === eighty ? next.reached80 : next.reached100))
        .map((threshold) =>
          db
            .prepare(`INSERT OR IGNORE INTO budget_threshold_alerts
        (user_id, budget_id, from_utc, time_zone, threshold)
        SELECT user_id, budget_id, from_utc, time_zone, ? FROM budget_month_latches
        WHERE user_id = ? AND budget_id = ? AND from_utc = ? AND time_zone = ?`)
            .bind(threshold, userId, budgetId, from, timeZone)
        ),
    ];
    yield* Effect.tryPromise(() => db.batch(writes));
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

const reconcilePendingPeriod = ({
  db,
  userId,
  timeZone,
  now,
}: Readonly<{
  db: D1Database;
  userId: string;
  timeZone: IanaTimeZone;
  now: DateTime.Utc;
}>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const report = yield* currentBudgetReport({ db, userId, query: { timeZone }, now });
    if (Option.isNone(report)) return false;
    for (const status of report.value.statuses) {
      if (!(yield* reconcileStatus({ db, userId, timeZone, status }))) return false;
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
    const raw = yield* Effect.tryPromise(() =>
      db.prepare("SELECT time_zone FROM users WHERE id = ?").bind(userId).first()
    );
    const context = Schema.decodeUnknownOption(UserZone)(raw);
    if (Option.isNone(context)) return false;
    const timeZone = context.value.time_zone;
    const pending = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT occurred_at, version
    FROM budget_reconciliation_work WHERE user_id = ? ORDER BY occurred_at LIMIT ${maximumPendingWork}`)
        .bind(userId)
        .all()
    );
    const periods = new Map<number, DateTime.Utc>();
    const work: Array<typeof PendingWork.Type> = [];
    for (const row of pending.results) {
      const item = Schema.decodeUnknownOption(PendingWork)(row);
      if (Option.isNone(item)) return false;
      const instant = DateTime.make(item.value.occurred_at);
      if (Option.isNone(instant)) return false;
      const period = deriveCurrentBudgetMonth({ now: instant.value, timeZone });
      periods.set(period.from.epochMilliseconds, instant.value);
      work.push(item.value);
    }
    for (const now of periods.values()) {
      if (!(yield* reconcilePendingPeriod({ db, userId, timeZone, now }))) return false;
    }
    for (const item of work) {
      yield* Effect.tryPromise(() =>
        db
          .prepare(`DELETE FROM budget_reconciliation_work
      WHERE user_id = ? AND occurred_at = ? AND version = ?`)
          .bind(userId, item.occurred_at, item.version)
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
