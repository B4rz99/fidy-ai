import type { IanaTimeZone } from "~/core/_shared/context";
import type { ReadonlyMoney } from "~/core/_shared/money";
import type { Announcement, RecurringFact, RecurringProposal } from "./contract";
import { comparable, detect, normalize } from "~/core/recurring/internal/detector";

/** Formatting equivalence only; it never guesses a person or organization. */
export const normalizeCounterparty = (text: string): string => normalize(text);

/** The reference never moves: small increases cannot compound the five-percent same-Currency band. */
export const comparableMoney = (
  input: Readonly<{ candidate: ReadonlyMoney; reference: ReadonlyMoney }>
): boolean => comparable(input);

/**
 * Confirm unambiguous consecutive-month triples in a complete bounded fact selection. Each fact
 * supports at most one proposal. The initial calendar day is clamped at month end with three days
 * of drift; the initial exact Money anchors every comparison. Gaps never expire historical patterns.
 */
export const detectMonthlySeries = (
  input: Readonly<{ facts: ReadonlyArray<RecurringFact>; timeZone: IanaTimeZone }>
): ReadonlyArray<RecurringProposal> => detect(input);

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
