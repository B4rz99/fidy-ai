import { DateTime, Effect, Option, Schema } from "effect";
import { Money } from "../../../src/core/_shared/money";
import { Transaction } from "../../../src/core/transactions/contract";
import type {
  BudgetContribution,
  BudgetContributionPage,
  BudgetContributionQuery,
} from "../contract";
import { effectiveTransactionRelation } from "./effective-transaction";

const contributionPageSize = 512;

const ContributionRow = Schema.Struct({
  id: Transaction.fields.id,
  amount: Schema.String,
  currency: Money.fields.currency,
  category_id: Transaction.fields.categoryId,
  direction: Transaction.fields.direction,
  occurred_at: Schema.String,
});

const decodeContribution = (
  row: typeof ContributionRow.Type
): Option.Option<BudgetContribution> => {
  const money = Schema.decodeOption(Schema.toCodecJson(Money))({
    amount: row.amount,
    currency: row.currency,
  });
  const occurredAt = Schema.decodeOption(Transaction.fields.occurredAt)(row.occurred_at);
  return Option.map(Option.all({ money, occurredAt }), (facts) => ({
    ...facts,
    categoryId: row.category_id,
    direction: row.direction,
  }));
};

/**
 * Read at most 512 effective outflows in ascending occurrence/identity order. The caller owns
 * report progress and revision checks. A failed or malformed page never advances its cursor or
 * supplies a partial sum; equal timestamps progress by Transaction identity without skipping rows.
 */
export const readBudgetContributions = ({
  db,
  userId,
  categoryId,
  currency,
  period,
  cursor,
}: BudgetContributionQuery): Effect.Effect<Option.Option<BudgetContributionPage>> =>
  Effect.gen(function* () {
    const relation = effectiveTransactionRelation(userId);
    const result = yield* Effect.tryPromise(() =>
      db
        .prepare(`WITH ${relation.sql}
      SELECT id, amount, currency, category_id, direction, occurred_at FROM effective_transaction
      WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ?
        AND category_id = ? AND currency = ? AND direction = 'outflow'
        AND (occurred_at > ? OR (occurred_at = ? AND id > ?))
      ORDER BY occurred_at, id LIMIT ${contributionPageSize}`)
        .bind(
          ...relation.bindings,
          userId,
          DateTime.formatIso(period.from),
          DateTime.formatIso(period.to),
          categoryId,
          currency,
          cursor.occurredAt,
          cursor.occurredAt,
          cursor.transactionId
        )
        .all()
    );
    if (result.results.length > contributionPageSize) return Option.none();
    const rows = Option.all(
      result.results.map((raw) => Schema.decodeUnknownOption(ContributionRow)(raw))
    );
    if (Option.isNone(rows)) return Option.none();
    const movements = Option.all(rows.value.map(decodeContribution));
    if (Option.isNone(movements)) return Option.none();
    const last = rows.value.at(-1);
    return Option.some({
      movements: movements.value,
      cursor:
        last === undefined ? cursor : { occurredAt: last.occurred_at, transactionId: last.id },
      complete: rows.value.length < contributionPageSize,
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));
