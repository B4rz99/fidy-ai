import type { Budget, BudgetStatusReport } from "@fidy/server/budgets-runtime";
import { Money, encodeMoneyAmount } from "@fidy/server/transactions-runtime";
import { DateTime, Effect, Option, Schema } from "effect";

const Version = Schema.Struct({ revision: Schema.Int });
const Progress = Schema.Struct({
  revision: Schema.Int,
  after_at: Schema.String,
  after_id: Schema.String,
  amount: Schema.String,
  complete: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type BudgetProgressKey = Readonly<{
  db: D1Database;
  userId: string;
  budget: Budget;
  period: BudgetStatusReport["period"];
}>;
export type BudgetProgress = Readonly<{
  revision: number;
  cursorAt: string;
  cursorId: string;
  spent: Money;
  complete: boolean;
}>;

/** Read the durable User-fact revision that a paged Budget report must remain on. */
export const findBudgetRevision = ({
  db,
  userId,
}: BudgetProgressKey): Effect.Effect<Option.Option<number>> =>
  Effect.tryPromise(() =>
    db.prepare("SELECT revision FROM budget_user_versions WHERE user_id = ?").bind(userId).first()
  ).pipe(
    Effect.map((raw) =>
      Option.map(Schema.decodeUnknownOption(Version)(raw), (row) => row.revision)
    ),
    Effect.orElseSucceed(() => Option.none())
  );

/** Resume one exact Budget/month at its committed cursor, discarding a stale fact revision. */
export const findBudgetProgress = ({
  db,
  userId,
  budget,
  period,
}: BudgetProgressKey): Effect.Effect<Option.Option<BudgetProgress>> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT revision, after_at, after_id, amount, complete FROM budget_report_progress
      WHERE user_id = ? AND budget_id = ? AND from_utc = ? AND time_zone = ?`)
      .bind(userId, budget.id, DateTime.formatIso(period.from), period.timeZone)
      .first()
  ).pipe(
    Effect.map((raw) => {
      if (raw === null) return Option.none<BudgetProgress>();
      const row = Schema.decodeUnknownOption(Progress)(raw);
      if (Option.isNone(row)) return Option.none<BudgetProgress>();
      const spent = Schema.decodeOption(Schema.toCodecJson(Money))({
        amount: row.value.amount,
        currency: budget.cap.currency,
      });
      return Option.map(spent, (money) => ({
        revision: row.value.revision,
        cursorAt: row.value.after_at,
        cursorId: row.value.after_id,
        spent: money,
        complete: row.value.complete === 1,
      }));
    }),
    Effect.orElseSucceed(() => Option.none())
  );

/** Advance a cursor only if its User-fact revision and previous cursor still match. */
export const advanceBudgetProgress = ({
  key,
  previous,
  next,
}: Readonly<{
  key: BudgetProgressKey;
  previous: BudgetProgress;
  next: BudgetProgress;
}>): Effect.Effect<boolean> =>
  Effect.tryPromise(() =>
    key.db
      .prepare(`INSERT INTO budget_report_progress
      (user_id, budget_id, from_utc, time_zone, revision, after_at, after_id, amount, complete)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT revision FROM budget_user_versions WHERE user_id = ?) = ?
      ON CONFLICT(user_id, budget_id, from_utc, time_zone) DO UPDATE SET
        revision = excluded.revision, after_at = excluded.after_at, after_id = excluded.after_id,
        amount = excluded.amount, complete = excluded.complete
      WHERE (SELECT revision FROM budget_user_versions WHERE user_id = excluded.user_id) = excluded.revision
        AND (budget_report_progress.revision <> excluded.revision OR
          (budget_report_progress.after_at = ? AND budget_report_progress.after_id = ?))`)
      .bind(
        key.userId,
        key.budget.id,
        DateTime.formatIso(key.period.from),
        key.period.timeZone,
        next.revision,
        next.cursorAt,
        next.cursorId,
        encodeMoneyAmount(next.spent.amount),
        Number(next.complete),
        key.userId,
        next.revision,
        previous.cursorAt,
        previous.cursorId
      )
      .run()
  ).pipe(
    Effect.map((result) => result.meta.changes === 1),
    Effect.orElseSucceed(() => false)
  );
