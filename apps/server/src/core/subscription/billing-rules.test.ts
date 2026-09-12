import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Duration, Effect, Option } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import type { WompiBillingStatus } from "./model";
import {
  type BillingTransactionFact,
  amountInCentsForBilling,
  approvingFinalizedAtFor,
  decideBillingAttemptOutcome,
  decideBillingTransactionStatus,
  paidPeriodFor,
  wompiRetryOpportunity,
} from "./billing-rules";

const finalizedAt = DateTime.makeUnsafe("2026-01-31T23:30:00.000Z");
const bogota = IanaTimeZone.make("America/Bogota");

const fact = (
  status: WompiBillingStatus,
  firstObservedAt: DateTime.Utc,
  finalizedAt: Option.Option<DateTime.Utc> = Option.none()
): BillingTransactionFact => ({
  status,
  firstObservedAt,
  finalizedAt,
});

it.effect("keeps one provider transaction monotonic with absorbing approval", () =>
  Effect.gen(function* () {
    expect(
      yield* decideBillingTransactionStatus({ current: Option.none(), observed: "PENDING" })
    ).toBe("PENDING");
    expect(
      yield* decideBillingTransactionStatus({
        current: Option.some("PENDING"),
        observed: "APPROVED",
      })
    ).toBe("APPROVED");
    expect(
      yield* decideBillingTransactionStatus({
        current: Option.some("APPROVED"),
        observed: "DECLINED",
      })
    ).toBe("APPROVED");
    expect(
      yield* decideBillingTransactionStatus({
        current: Option.some("DECLINED"),
        observed: "PENDING",
      })
    ).toBe("DECLINED");
    expect(
      yield* decideBillingTransactionStatus({
        current: Option.some("ERROR"),
        observed: "APPROVED",
      })
    ).toBe("APPROVED");
    expect(
      yield* decideBillingTransactionStatus({
        current: Option.some("DECLINED"),
        observed: "VOIDED",
      })
    ).toBe("DECLINED");
  })
);

it.effect("keeps a BillingAttempt pending while any provider transaction is unresolved", () =>
  Effect.gen(function* () {
    const observedAt = DateTime.makeUnsafe("2026-03-01T12:05:00.000Z");
    const first = DateTime.makeUnsafe("2026-03-01T12:00:00.000Z");
    expect(
      yield* decideBillingAttemptOutcome({ current: "pending", transactions: [], observedAt })
    ).toBe("pending");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "pending",
        transactions: [fact("PENDING", first)],
        observedAt,
      })
    ).toBe("pending");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "pending",
        transactions: [fact("DECLINED", first), fact("PENDING", observedAt)],
        observedAt,
      })
    ).toBe("pending");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "pending",
        transactions: [fact("APPROVED", first)],
        observedAt,
      })
    ).toBe("succeeded");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "succeeded",
        transactions: [fact("DECLINED", first)],
        observedAt,
      })
    ).toBe("succeeded");
  })
);

it.effect("waits out the Wompi retry opportunity before failing observed negatives", () =>
  Effect.gen(function* () {
    const first = DateTime.makeUnsafe("2026-03-01T12:00:00.000Z");
    const retry = DateTime.makeUnsafe("2026-03-01T12:02:00.000Z");
    const window = Duration.toMillis(wompiRetryOpportunity);
    expect(
      yield* decideBillingAttemptOutcome({
        current: "pending",
        transactions: [fact("DECLINED", first)],
        observedAt: DateTime.add(first, { milliseconds: window - 1 }),
      })
    ).toBe("pending");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "pending",
        transactions: [fact("DECLINED", first)],
        observedAt: DateTime.add(first, { milliseconds: window }),
      })
    ).toBe("failed");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "pending",
        transactions: [fact("DECLINED", first), fact("DECLINED", retry)],
        observedAt: DateTime.add(first, { milliseconds: window - 1 }),
      })
    ).toBe("pending");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "pending",
        transactions: [fact("DECLINED", first), fact("DECLINED", retry)],
        observedAt: DateTime.add(first, { milliseconds: window }),
      })
    ).toBe("failed");
  })
);

it.effect("allows a late verified approval to recover aggregate failure", () =>
  Effect.gen(function* () {
    const first = DateTime.makeUnsafe("2026-03-01T12:00:00.000Z");
    const observedAt = DateTime.makeUnsafe("2026-03-01T12:10:00.000Z");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "failed",
        transactions: [fact("DECLINED", first)],
        observedAt,
      })
    ).toBe("failed");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "failed",
        transactions: [fact("DECLINED", first), fact("APPROVED", observedAt)],
        observedAt,
      })
    ).toBe("succeeded");
  })
);

it.effect("anchors the paid period on the first retained approval", () =>
  Effect.gen(function* () {
    const first = DateTime.makeUnsafe("2026-03-01T12:00:00.000Z");
    const approval = DateTime.makeUnsafe("2026-03-01T12:00:30.000Z");
    const later = DateTime.makeUnsafe("2026-03-01T12:04:00.000Z");
    expect(
      yield* approvingFinalizedAtFor([
        fact("DECLINED", first),
        fact("APPROVED", first, Option.some(approval)),
        fact("APPROVED", later, Option.some(later)),
      ])
    ).toEqual(Option.some(approval));
    expect(yield* approvingFinalizedAtFor([fact("DECLINED", first)])).toEqual(Option.none());
  })
);

it.effect("never fabricates failure without an observed provider transaction", () =>
  Effect.gen(function* () {
    const first = DateTime.makeUnsafe("2026-03-01T12:00:00.000Z");
    expect(
      yield* decideBillingAttemptOutcome({
        current: "pending",
        transactions: [],
        observedAt: DateTime.add(first, { minutes: 20 }),
      })
    ).toBe("pending");
  })
);

it.effect("converts exact billing amounts without floating-point arithmetic", () =>
  Effect.gen(function* () {
    expect(yield* amountInCentsForBilling(BigDecimal.fromStringUnsafe("99.99"))).toBe(9_999);
    expect(yield* amountInCentsForBilling(BigDecimal.fromStringUnsafe("28900"))).toBe(2_890_000);
  })
);

it.effect("derives weekly paid periods from the verified finalization instant", () =>
  Effect.gen(function* () {
    const period = yield* paidPeriodFor("weekly", bogota, finalizedAt);
    expect(DateTime.formatIso(period.startsAt)).toBe("2026-01-31T23:30:00.000Z");
    expect(DateTime.formatIso(period.endsAt)).toBe("2026-02-07T23:30:00.000Z");
    expect(DateTime.formatIso(period.renewalAnchor)).toBe("2026-02-07T23:30:00.000Z");
  })
);

it.effect("derives monthly and yearly anchors in the captured time zone", () =>
  Effect.gen(function* () {
    const monthly = yield* paidPeriodFor("monthly", bogota, finalizedAt);
    expect(DateTime.formatIso(monthly.endsAt)).toBe("2026-02-28T23:30:00.000Z");
    const yearly = yield* paidPeriodFor("yearly", bogota, finalizedAt);
    expect(DateTime.formatIso(yearly.endsAt)).toBe("2027-01-31T23:30:00.000Z");
  })
);
