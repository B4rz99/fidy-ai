import {
  IneligibleTransactionPair,
  InvalidTransactionPeriod,
  type LinkedTransactionDecision,
  type ReconciliationMember,
  SameTransactionPair,
  TransactionNotYetOccurred,
  type TransactionPair,
  type TransactionPairInput,
} from "./contract";
import { DateTime, Effect, Equal, Option } from "effect";
/**
 * Decides whether a movement about to be recorded has actually happened.
 *
 * A Transaction is money that moved (GLOSSARY.md), so `occurredAt` may be any
 * instant up to and including `now`, and nothing after it. The same instant is
 * accepted: a capture that races the clock to the millisecond is a real
 * movement, not a future-dated one.
 *
 * `now` is a parameter rather than a clock read, because core reads no clock
 * (ARCHITECTURE.md §3); the caller supplies the instant it is deciding at, and
 * the same pair always gives the same answer. Both instants are named fields
 * rather than positional arguments, so a call site cannot swap them silently.
 */
export const checkAlreadyOccurred = (
  occurrence: Readonly<{
    readonly occurredAt: DateTime.Utc;
    readonly now: DateTime.Utc;
  }>
): Effect.Effect<void, TransactionNotYetOccurred> =>
  DateTime.isGreaterThan(occurrence.occurredAt, occurrence.now)
    ? Effect.fail(new TransactionNotYetOccurred(occurrence))
    : Effect.void;

type TransactionPeriod = Readonly<{
  readonly from: Option.Option<DateTime.Utc>;
  readonly to: Option.Option<DateTime.Utc>;
}>;

type PeriodBounds = Readonly<{
  readonly from: DateTime.Utc;
  readonly to: DateTime.Utc;
}>;

const checkPeriodWidth = (
  bounds: PeriodBounds
): Effect.Effect<void> | Effect.Effect<never, InvalidTransactionPeriod> =>
  DateTime.isLessThan(bounds.from, bounds.to)
    ? Effect.void
    : Effect.fail(new InvalidTransactionPeriod(bounds));

/** A two-ended period must have positive width; either end may be omitted. */
export const checkTransactionPeriod = (
  period: TransactionPeriod
): Effect.Effect<void> | Effect.Effect<never, InvalidTransactionPeriod> =>
  Option.match(Option.all({ from: period.from, to: period.to }), {
    onNone: () => Effect.void,
    onSome: checkPeriodWidth,
  });

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
