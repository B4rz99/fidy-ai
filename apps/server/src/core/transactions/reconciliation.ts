import { DateTime, Effect, Equal } from "effect";
import { IneligibleTransactionPair, SameTransactionPair } from "./errors";
import type { ReadonlyMoney } from "~/core/_shared/money";
import type { Transaction, TransactionId, TransactionPairInput } from "./model";

/** Canonical policy facts required to validate a link and choose its visible member. */
export type ReconciliationMember = Readonly<{
  id: Transaction["id"];
  money: ReadonlyMoney;
  direction: Transaction["direction"];
  createdAt: DateTime.Utc;
}>;

/** Canonically ordered pair used by persistence so caller order cannot create a second decision. */
export type TransactionPair = TransactionPairInput;

/**
 * The one reversible decision persistence stores: the canonical pair and the member a caller reads
 * the effective Transaction under. Effective fact authorities are never stored; the shared read
 * relation selects them from the retained members on every read.
 */
export type LinkedTransactionDecision = Readonly<{
  pair: TransactionPair;
  visibleTransactionId: TransactionId;
}>;

/** Orders one exact pair independently of caller argument order. */
export const orderTransactionPair = (
  input: TransactionPairInput
): Effect.Effect<TransactionPair, SameTransactionPair> => {
  if (input.firstTransactionId === input.secondTransactionId) {
    return Effect.fail(new SameTransactionPair({ transactionId: input.firstTransactionId }));
  }
  return Effect.succeed(
    input.firstTransactionId.localeCompare(input.secondTransactionId) < 0
      ? input
      : {
          firstTransactionId: input.secondTransactionId,
          secondTransactionId: input.firstTransactionId,
        }
  );
};

const compareVisibleMembers = (first: ReconciliationMember, second: ReconciliationMember): number =>
  DateTime.Order(first.createdAt, second.createdAt) || first.id.localeCompare(second.id);

const selectVisibleMember = (
  first: ReconciliationMember,
  second: ReconciliationMember
): ReconciliationMember =>
  [second].reduce(
    (visible, candidate) => (compareVisibleMembers(visible, candidate) < 0 ? visible : candidate),
    first
  );

/**
 * Validates one explicit pair and selects its visible member. Exact Money, Currency, and direction
 * are hard gates; timing ambiguity is deliberately bypassed because the authorized User decided.
 */
export const decideTransactionLink = Effect.fn(function* (
  first: ReconciliationMember,
  second: ReconciliationMember
) {
  if (first.money.currency !== second.money.currency) {
    return yield* new IneligibleTransactionPair({ reason: "different-currency" });
  }
  if (!Equal.equals(first.money.amount, second.money.amount)) {
    return yield* new IneligibleTransactionPair({ reason: "different-amount" });
  }
  if (first.direction !== second.direction) {
    return yield* new IneligibleTransactionPair({ reason: "incompatible-direction" });
  }
  const pair = yield* orderTransactionPair({
    firstTransactionId: first.id,
    secondTransactionId: second.id,
  });
  const visibleMember = selectVisibleMember(first, second);
  return {
    pair,
    visibleTransactionId: visibleMember.id,
  } satisfies LinkedTransactionDecision;
});
