import { DateTime, Effect, Equal, Option } from "effect";
import { IneligibleTransactionPair, SameTransactionPair } from "./errors";
import type { ReadonlyMoney } from "~/core/_shared/money";
import type { Transaction, TransactionId, TransactionPairInput } from "./model";
/** Canonical policy facts required to validate a link and choose authoritative members. */
export type ReconciliationMember = Readonly<{
  id: Transaction["id"];
  money: ReadonlyMoney;
  direction: Transaction["direction"];
  createdAt: DateTime.Utc;
  correctedAt: Option.Option<DateTime.Utc>;
  hasStatementSource: boolean;
  categoryUserDecided: boolean;
  counterpartyUserDecided: boolean;
  notesUserDecided: boolean;
}>;

/** Canonically ordered pair used by persistence so caller order cannot create a second decision. */
export type TransactionPair = TransactionPairInput;

/** Source Transaction ids selected by core policy for each effective fact group. */
export type EffectiveTransactionAuthorities = Readonly<{
  movementTransactionId: TransactionId;
  categoryTransactionId: TransactionId;
  counterpartyTransactionId: TransactionId;
  notesTransactionId: TransactionId;
}>;

/** Complete pure decision persisted after an explicit link succeeds. */
export type LinkedTransactionDecision = Readonly<{
  pair: TransactionPair;
  visibleTransactionId: TransactionId;
  statementTransactionId: Option.Option<TransactionId>;
  authorities: EffectiveTransactionAuthorities;
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

const latestMember = (
  members: ReadonlyArray<ReconciliationMember>
): Option.Option<ReconciliationMember> => {
  const [head, ...tail] = members;
  if (head === undefined) return Option.none();
  return Option.some(
    tail.reduce((latest, candidate) => {
      const latestAt = Option.getOrElse(latest.correctedAt, () => latest.createdAt);
      const candidateAt = Option.getOrElse(candidate.correctedAt, () => candidate.createdAt);
      const order = DateTime.Order(candidateAt, latestAt);
      if (order > 0) return candidate;
      if (order < 0) return latest;
      return candidate.id.localeCompare(latest.id) > 0 ? candidate : latest;
    }, head)
  );
};

const explicitlyDecidedMember = (
  first: ReconciliationMember,
  second: ReconciliationMember,
  field: "categoryUserDecided" | "counterpartyUserDecided" | "notesUserDecided"
): Option.Option<ReconciliationMember> =>
  latestMember([first, second].filter((member) => member[field]));

const statementMember = (
  first: ReconciliationMember,
  second: ReconciliationMember
): Option.Option<ReconciliationMember> => {
  const statements = [first, second].filter((member) => member.hasStatementSource);
  return latestMember(statements);
};

/** Selects the domain-owned source Transaction for every effective fact group. */
export const decideEffectiveTransactionAuthorities = (input: {
  readonly first: ReconciliationMember;
  readonly second: ReconciliationMember;
}): EffectiveTransactionAuthorities => {
  const { first, second } = input;
  const visibleMember = selectVisibleMember(first, second);
  const statement = statementMember(first, second);
  const corrected = latestMember(
    [first, second].filter((member) => Option.isSome(member.correctedAt))
  );
  return {
    movementTransactionId: Option.getOrElse(corrected, () =>
      Option.getOrElse(statement, () => visibleMember)
    ).id,
    categoryTransactionId: Option.getOrElse(
      explicitlyDecidedMember(first, second, "categoryUserDecided"),
      () => visibleMember
    ).id,
    counterpartyTransactionId: Option.getOrElse(
      explicitlyDecidedMember(first, second, "counterpartyUserDecided"),
      () => visibleMember
    ).id,
    notesTransactionId: Option.getOrElse(
      explicitlyDecidedMember(first, second, "notesUserDecided"),
      () => visibleMember
    ).id,
  };
};

/**
 * Validates one explicit pair and selects the effective facts. Exact Money, Currency, and direction
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
  const statement = statementMember(first, second);
  return {
    pair,
    visibleTransactionId: visibleMember.id,
    statementTransactionId: Option.map(statement, (member) => member.id),
    authorities: decideEffectiveTransactionAuthorities({ first, second }),
  } satisfies LinkedTransactionDecision;
});
