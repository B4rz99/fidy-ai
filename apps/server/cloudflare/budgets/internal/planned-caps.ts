import { Effect, Option } from "effect";
import type { Budget } from "../../../src/core/budgets/contract";
import { budgetFromRow } from "./budget-row";

const maximumBudgetCount = 128;

export const preparePlannedCaps = ({
  db,
  userId,
  month,
  includeInactive,
}: Readonly<{
  db: D1Database;
  userId: string;
  month: string;
  includeInactive: boolean;
}>): D1PreparedStatement =>
  db
    .prepare(`SELECT b.id,b.category_id,
      COALESCE((SELECT g.currency FROM (SELECT rowid,user_id,group_name,month,currency FROM budget_month_plan_records WHERE kind='currency') g WHERE g.user_id=b.user_id AND g.group_name=b.group_name AND g.month<=? ORDER BY g.month DESC LIMIT 1),b.currency) AS currency,
      COALESCE((SELECT p.cap FROM (SELECT rowid,user_id,budget_id,month,cap FROM budget_month_plan_records WHERE kind='cap') p WHERE p.user_id=b.user_id AND p.budget_id=b.id AND p.month<=? ORDER BY p.month DESC LIMIT 1),b.cap) AS cap,
      b.created_at_ms,b.updated_at_ms,b.group_name,
      CASE WHEN b.starts_month IS NULL OR b.starts_month<=? THEN 1 ELSE 0 END AS active_in_month FROM budgets b WHERE b.user_id=? AND (?=1 OR b.starts_month IS NULL OR b.starts_month<=?)
      ORDER BY b.currency,b.category_id LIMIT ${maximumBudgetCount + 1}`)
    .bind(month, month, month, userId, includeInactive ? 1 : 0, month);

export const decodePlannedCaps = (
  rows: ReadonlyArray<unknown>
): Effect.Effect<Option.Option<ReadonlyArray<Budget>>> =>
  rows.length > maximumBudgetCount
    ? Effect.succeedNone
    : Effect.forEach(rows, budgetFromRow).pipe(
        Effect.asSome,
        Effect.orElseSucceed(() => Option.none())
      );

export const readPlannedCaps = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    month: string;
    includeInactive: boolean;
  }>
): Effect.Effect<Option.Option<ReadonlyArray<Budget>>> =>
  Effect.tryPromise(() => preparePlannedCaps(input).all()).pipe(
    Effect.flatMap((rows) => decodePlannedCaps(rows.results)),
    Effect.orElseSucceed(() => Option.none())
  );
