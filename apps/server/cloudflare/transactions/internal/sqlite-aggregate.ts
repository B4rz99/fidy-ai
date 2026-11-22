import {
  localProjectionRange,
  localProjectionReady,
  projectionRange,
} from "./dashboard-projection";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { BigDecimal, Effect, Option, Order, Schema } from "effect";
import { Money } from "../../../src/core/_shared/money";
import { CategoryReference } from "../../../src/core/categories/contract";
import { currentCategoryRelease, interpretCategory } from "../../../src/core/categories/operations";
import type { UserId } from "../../../src/core/identity/contract";
import {
  Direction,
  type EffectiveTransactionAggregate,
  TransactionId,
} from "../../../src/core/transactions/contract";
import { TransactionAggregatesUnavailable } from "../contract";

const pageSize = 256;

const AggregateRow = Schema.Struct({
  id: TransactionId,
  category_id: CategoryReference.fields.categoryId,
  category_revision: CategoryReference.fields.revision,
  direction: Direction,
  amount: Money.fields.amount,
  currency: Money.fields.currency,
});

const aggregateRows = Schema.decodeUnknownEffect(Schema.Array(AggregateRow));

const aggregateRow = Effect.fn(function* (
  groups: Map<string, EffectiveTransactionAggregate>,
  row: typeof AggregateRow.Type
) {
  const reference = { revision: row.category_revision, categoryId: row.category_id };

  if (Option.isNone(interpretCategory({ release: currentCategoryRelease, reference }))) {
    return yield* new TransactionAggregatesUnavailable();
  }

  const money = yield* Schema.decodeEffect(Schema.toType(Money))({
    amount: row.amount,
    currency: row.currency,
  });

  const key = [money.currency, row.direction, row.category_id].join(":");
  const prior = groups.get(key);
  groups.set(key, {
    categoryId: row.category_id,
    direction: row.direction,
    count: (prior?.count ?? 0n) + 1n,
    maximum:
      prior !== undefined && BigDecimal.Order(prior.maximum.amount, money.amount) > 0
        ? prior.maximum
        : money,
    sum:
      prior === undefined
        ? money
        : { currency: money.currency, amount: BigDecimal.sum(prior.sum.amount, money.amount) },
  });
});

export const readLocalTransactionAggregate = Effect.fn(function* (
  user: UserId,
  from: number,
  toExclusive: number
) {
  const sql = yield* SqliteClient;

  if (
    Option.isSome(projectionRange({ from, toExclusive })) &&
    (yield* localProjectionReady(user))
  ) {
    return yield* localProjectionRange(user, from, toExclusive);
  }

  const groups = new Map<string, EffectiveTransactionAggregate>();
  let cursor = "";

  const aggregatePage = Effect.gen(function* () {
    const rows = yield* aggregateRows(
      yield* sql`SELECT id,category_revision,category_id,direction,amount,currency FROM transaction_effective_source
      WHERE user_id=${user} AND occurred_at_ms>=${from} AND occurred_at_ms<${toExclusive} AND id>${cursor} ORDER BY id LIMIT ${pageSize}`
    );

    yield* Effect.forEach(
      rows,
      Effect.fnUntraced(function* (row) {
        yield* aggregateRow(groups, row);
        cursor = row.id;
      }),
      { discard: true }
    );

    return rows.length;
  });

  yield* aggregatePage.pipe(Effect.repeat({ while: (count) => count >= pageSize }));

  return [...groups.entries()]
    .sort(([left], [right]) => Order.String(left, right))
    .map(([, value]) => value);
});
