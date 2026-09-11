import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Effect } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import {
  amountInCentsForBilling,
  decideBillingAttemptOutcome,
  paidPeriodFor,
} from "./billing-rules";

const finalizedAt = DateTime.makeUnsafe("2026-01-31T23:30:00.000Z");
const bogota = IanaTimeZone.make("America/Bogota");

it.effect("keeps BillingAttempt settlement monotonic while allowing a late approval", () =>
  Effect.gen(function* () {
    expect(yield* decideBillingAttemptOutcome({ current: "pending", observed: "PENDING" })).toBe(
      "pending"
    );
    expect(yield* decideBillingAttemptOutcome({ current: "pending", observed: "DECLINED" })).toBe(
      "failed"
    );
    expect(yield* decideBillingAttemptOutcome({ current: "failed", observed: "APPROVED" })).toBe(
      "succeeded"
    );
    expect(yield* decideBillingAttemptOutcome({ current: "succeeded", observed: "ERROR" })).toBe(
      "succeeded"
    );
    expect(yield* decideBillingAttemptOutcome({ current: "failed", observed: "VOIDED" })).toBe(
      "failed"
    );
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
