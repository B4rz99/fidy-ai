import { BigDecimal, DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Currency, Money } from "~/core/_shared/money";
import { type CreateTransactionInput } from "~/core/transactions/model";

/** Resets the Transactions slice's harness state between tests. */
export const truncateTransactions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`TRUNCATE transactions`;
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
export const transactionPayload = (
  overrides?: Partial<CreateTransactionInput>
): CreateTransactionInput => ({
  money: Money.make({
    amount: BigDecimal.fromStringUnsafe("25000"),
    currency: Currency.make("COP"),
  }),
  merchant: "El Corral",
  direction: "outflow",
  occurredAt: DateTime.makeUnsafe("2026-07-20T12:30:00Z"),
  ...overrides,
});
