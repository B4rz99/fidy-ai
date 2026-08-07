import { BigDecimal, DateTime, Effect, Option } from "effect";
import { MigrationSqlClient } from "~/shell/db/client";
import { Currency, Money } from "~/core/_shared/money";
import { categoryIds } from "~/core/categories/taxonomy";
import { type CreateTransactionInput } from "~/core/transactions/model";

/** Resets the Transactions slice's harness state between tests. */
export const truncateTransactions = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`TRUNCATE source_attestations, transactions, keyword_rules`;
});

/**
 * What a caller sends to record a Transaction, defaulted so a test spells out
 * only what it is about: an outflow of 25.000 COP to "El Corral" on
 * 2026-07-20T12:30:00Z.
 *
 * Those values are a plausible movement, not a promise — a test whose assertion
 * turns on one of them should pass it as an override rather than read it off
 * the default.
 */
type TransactionPayloadOverrides = Omit<Partial<CreateTransactionInput>, "counterparty"> &
  Partial<Readonly<{ counterparty: string | CreateTransactionInput["counterparty"] }>>;

export const transactionPayload = (
  overrides?: TransactionPayloadOverrides
): CreateTransactionInput => {
  const { counterparty = Option.some("El Corral"), ...rest } = overrides ?? {};
  return {
    money: Money.make({
      amount: BigDecimal.fromStringUnsafe("25000"),
      currency: Currency.make("COP"),
    }),
    counterparty: typeof counterparty === "string" ? Option.some(counterparty) : counterparty,
    direction: "outflow",
    categoryId: Option.some(categoryIds.restaurantes),
    notes: Option.none(),
    occurredAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
    ...rest,
  };
};
