import { BigDecimal, DateTime, Option } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import type { ReadonlyMoney } from "~/core/_shared/money";
import type { Announcement, RecurringFact, RecurringProposal } from "./contract";

const monthsPerYear = 12;
const maximumDayDrift = 3;
const percentScale = BigDecimal.make(100n, 0);
const tolerancePercent = BigDecimal.make(5n, 0);
/** Formatting equivalence only; it never guesses a person or organization. */
export const normalizeCounterparty = (text: string): string =>
  text
    .normalize("NFKC")
    .replaceAll(/\p{White_Space}+/gu, " ")
    .trim()
    .toLowerCase();
/** The reference never moves: small increases cannot compound the five-percent same-Currency band. */
export const comparableMoney = ({
  candidate,
  reference,
}: Readonly<{ candidate: ReadonlyMoney; reference: ReadonlyMoney }>): boolean =>
  candidate.currency === reference.currency &&
  BigDecimal.Order(
    BigDecimal.multiply(
      BigDecimal.abs(BigDecimal.subtract(candidate.amount, reference.amount)),
      percentScale
    ),
    BigDecimal.multiply(reference.amount, tolerancePercent)
  ) <= 0;

type DatedFact = Readonly<{
  fact: RecurringFact;
  key: string;
  month: number;
  day: number;
  lastDay: number;
}>;
const dated = (fact: RecurringFact, timeZone: IanaTimeZone): DatedFact => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(fact.occurredAt, { timeZone }));
  const lastDay = DateTime.toPartsUtc(
    DateTime.makeUnsafe({ year: parts.year, month: parts.month, day: 1 }).pipe(
      DateTime.add({ months: 1 }),
      DateTime.subtract({ days: 1 })
    )
  ).day;
  return {
    fact,
    key: Option.match(fact.counterparty, { onNone: () => "", onSome: normalizeCounterparty }),
    month: parts.year * monthsPerYear + parts.month,
    day: parts.day,
    lastDay,
  };
};
const dateMatches = (anchor: DatedFact, candidate: DatedFact): boolean =>
  Math.abs(candidate.day - Math.min(anchor.day, candidate.lastDay)) <= maximumDayDrift;
const related = (anchor: DatedFact, candidate: DatedFact): boolean =>
  anchor.key === candidate.key &&
  comparableMoney({ candidate: candidate.fact.money, reference: anchor.fact.money }) &&
  dateMatches(anchor, candidate);
type Triple = readonly [DatedFact, DatedFact, DatedFact];
const tripleAt = (first: DatedFact, facts: ReadonlyArray<DatedFact>): Option.Option<Triple> => {
  const near = facts.filter((candidate) => related(first, candidate));
  const months = [first.month, first.month + 1, first.month + 2].map((month) =>
    near.filter((candidate) => candidate.month === month)
  );
  if (months.some((month: ReadonlyArray<DatedFact>) => month.length !== 1)) return Option.none();
  const second = months[1]?.[0];
  const third = months[2]?.[0];
  if (second === undefined || third === undefined) return Option.none();
  const competing = facts.some(
    (candidate) =>
      candidate.fact.id !== first.fact.id &&
      candidate.month === first.month &&
      related(candidate, second) &&
      related(candidate, third)
  );
  return competing ? Option.none() : Option.some([first, second, third]);
};
const unambiguousTriples = (facts: ReadonlyArray<DatedFact>): ReadonlyArray<Triple> => {
  const triples = facts.flatMap((first) => Option.toArray(tripleAt(first, facts)));
  const ambiguous = new Set<string>();
  for (const [index, left] of triples.entries()) {
    for (const right of triples.slice(index + 1)) {
      // Compatible anchors are continuations; the earliest accepted reference stays fixed.
      if (related(left[0], right[0]) && related(right[0], left[0])) continue;
      for (const { fact } of left.filter(({ fact }) =>
        right.some((candidate) => candidate.fact.id === fact.id)
      )) {
        ambiguous.add(fact.id);
      }
    }
  }
  return triples.filter((triple) => !triple.some(({ fact }) => ambiguous.has(fact.id)));
};
const belongsTo = ({
  proposal,
  first,
  last,
  timeZone,
}: Readonly<{
  proposal: RecurringProposal;
  first: DatedFact;
  last: DatedFact;
  timeZone: IanaTimeZone;
}>): boolean =>
  normalizeCounterparty(proposal.counterparty) === first.key &&
  comparableMoney({ candidate: first.fact.money, reference: proposal.referenceMoney }) &&
  comparableMoney({ candidate: last.fact.money, reference: proposal.referenceMoney }) &&
  dateMatches(dated({ ...first.fact, occurredAt: proposal.firstOccurredAt }, timeZone), last);
const proposalFrom = ([first, second, last]: Triple): RecurringProposal => ({
  counterparty: Option.getOrThrow(last.fact.counterparty),
  money: last.fact.money,
  referenceMoney: first.fact.money,
  firstOccurredAt: first.fact.occurredAt,
  lastOccurredAt: last.fact.occurredAt,
  supportingTransactionIds: [first.fact.id, second.fact.id, last.fact.id],
  latestTransactionId: last.fact.id,
  backfill: first.fact.backfill || second.fact.backfill || last.fact.backfill,
});
const applyTriple = ({
  proposals,
  triple,
  assignments,
  timeZone,
}: Readonly<{
  proposals: ReadonlyArray<RecurringProposal>;
  triple: Triple;
  assignments: (id: string) => Option.Option<number>;
  timeZone: IanaTimeZone;
}>): Option.Option<Readonly<{ index: number; proposal: RecurringProposal }>> => {
  const [first, , last] = triple;
  const matching = proposals
    .map((proposal, index) => ({ proposal, index }))
    .filter(({ proposal }: Readonly<{ proposal: RecurringProposal }>) =>
      belongsTo({ proposal, first, last, timeZone })
    );
  if (matching.length > 1) return Option.none();
  const index = matching[0]?.index ?? proposals.length;
  if (
    triple.some(({ fact }) => Option.exists(assignments(fact.id), (assigned) => assigned !== index))
  ) {
    return Option.none();
  }
  const fresh = proposalFrom(triple);
  const retained = proposals[index];
  const proposal =
    retained === undefined
      ? fresh
      : {
          ...fresh,
          referenceMoney: retained.referenceMoney,
          firstOccurredAt: retained.firstOccurredAt,
          backfill: retained.backfill,
          supportingTransactionIds: retained.supportingTransactionIds,
        };
  return Option.some({ index, proposal });
};
const canExtend = (
  proposal: RecurringProposal,
  fact: DatedFact,
  timeZone: IanaTimeZone
): boolean => {
  const anchor = dated({ ...fact.fact, occurredAt: proposal.firstOccurredAt }, timeZone);
  return (
    normalizeCounterparty(proposal.counterparty) === fact.key &&
    comparableMoney({ candidate: fact.fact.money, reference: proposal.referenceMoney }) &&
    dateMatches(anchor, fact)
  );
};
const extendProposal = ({
  proposal,
  proposals,
  facts,
  timeZone,
}: Readonly<{
  proposal: RecurringProposal;
  proposals: ReadonlyArray<RecurringProposal>;
  facts: ReadonlyArray<DatedFact>;
  timeZone: IanaTimeZone;
}>): RecurringProposal => {
  const candidates = facts.filter((fact) => canExtend(proposal, fact, timeZone));
  const unique = candidates.filter(
    (fact) =>
      candidates.filter((other) => other.month === fact.month).length === 1 &&
      proposals.filter((other) => canExtend(other, fact, timeZone)).length === 1
  );
  const last = unique.at(-1);
  if (
    last === undefined ||
    last.fact.occurredAt.epochMilliseconds <= proposal.lastOccurredAt.epochMilliseconds
  ) {
    return proposal;
  }
  return {
    ...proposal,
    money: last.fact.money,
    counterparty: Option.getOrThrow(last.fact.counterparty),
    lastOccurredAt: last.fact.occurredAt,
    latestTransactionId: last.fact.id,
  };
};
/**
 * Confirm unambiguous consecutive-month triples in a complete bounded fact selection. Each fact
 * supports at most one proposal. The initial calendar day is clamped at month end with three days
 * of drift; the initial exact Money anchors every comparison. Gaps never expire historical patterns.
 */
export const detectMonthlySeries = ({
  facts,
  timeZone,
}: Readonly<{
  facts: ReadonlyArray<RecurringFact>;
  timeZone: IanaTimeZone;
}>): ReadonlyArray<RecurringProposal> => {
  const unique = new Map(facts.map((fact) => [fact.id, fact]));
  const ordered = [...unique.values()]
    .filter((fact) => Option.isSome(fact.counterparty))
    .map((fact) => dated(fact, timeZone))
    .sort(
      (left, right) =>
        left.fact.occurredAt.epochMilliseconds - right.fact.occurredAt.epochMilliseconds ||
        left.fact.id.localeCompare(right.fact.id)
    );
  const proposals: RecurringProposal[] = [];
  const assignments = new Map<string, number>();
  for (const triple of unambiguousTriples(ordered)) {
    const applied = applyTriple({
      proposals,
      triple,
      assignments: (id) => Option.fromUndefinedOr(assignments.get(id)),
      timeZone,
    });
    if (Option.isNone(applied)) continue;
    proposals[applied.value.index] = applied.value.proposal;
    for (const { fact } of triple) assignments.set(fact.id, applied.value.index);
  }
  return proposals.map((proposal) =>
    extendProposal({ proposal, proposals, facts: ordered, timeZone })
  );
};

const coldStartDays = 30;
const millisecondsPerDay = 86_400_000;
/** Suppression is decided once at confirmation; the thirty-day clock starts at first financial capture. */
export const decideAnnouncement = ({
  backfill,
  firstCapturedAt,
  confirmedAt,
}: Readonly<{ backfill: boolean; firstCapturedAt: number; confirmedAt: number }>): Announcement => {
  if (backfill) return { kind: "suppressed", reason: "backfill" };
  if (confirmedAt < firstCapturedAt + coldStartDays * millisecondsPerDay) {
    return { kind: "suppressed", reason: "cold-start" };
  }
  return { kind: "eligible" };
};
