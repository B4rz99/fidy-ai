import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { paidPeriodFor, renewalPeriod } from "./operations";

const finalizedAt = DateTime.makeUnsafe("2026-01-31T23:30:00.000Z");
const bogota = IanaTimeZone.make("America/Bogota");

it.effect("returns to January's original monthly day after a shorter February", () =>
  Effect.gen(function* () {
    const period = yield* renewalPeriod({
      billingPeriod: "monthly",
      timeZone: bogota,
      originalStartsAt: finalizedAt,
      previousEndsAt: DateTime.makeUnsafe("2026-02-28T23:30:00Z"),
    });
    expect(DateTime.formatIso(period.startsAt)).toBe("2026-02-28T23:30:00.000Z");
    expect(DateTime.formatIso(period.endsAt)).toBe("2026-03-31T23:30:00.000Z");
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

it.effect(
  "keeps a weekly renewal adjacent to its predecessor despite late provider finalization",
  () =>
    Effect.gen(function* () {
      const period = yield* renewalPeriod({
        billingPeriod: "weekly",
        originalStartsAt: finalizedAt,
        timeZone: bogota,
        previousEndsAt: DateTime.makeUnsafe("2026-02-07T23:30:00Z"),
      });
      expect(DateTime.formatIso(period.startsAt)).toBe("2026-02-07T23:30:00.000Z");
      expect(DateTime.formatIso(period.endsAt)).toBe("2026-02-14T23:30:00.000Z");
      expect(DateTime.formatIso(period.renewalAnchor)).toBe("2026-02-14T23:30:00.000Z");
    })
);

it.effect("preserves leap-day yearly anchors through ordinary years and back to a leap year", () =>
  Effect.gen(function* () {
    const originalStartsAt = DateTime.makeUnsafe("2024-02-29T15:00:00Z");
    for (const [previous, next] of [
      ["2025-02-28T15:00:00Z", "2026-02-28T15:00:00.000Z"],
      ["2027-02-28T15:00:00Z", "2028-02-29T15:00:00.000Z"],
      ["2028-02-29T15:00:00Z", "2029-02-28T15:00:00.000Z"],
    ] as const) {
      const period = yield* renewalPeriod({
        billingPeriod: "yearly",
        timeZone: bogota,
        originalStartsAt,
        previousEndsAt: DateTime.makeUnsafe(previous),
      });
      expect(DateTime.formatIso(period.endsAt)).toBe(next);
    }
  })
);

it.effect("uses the captured local date and wall clock across month ends and daylight saving", () =>
  Effect.gen(function* () {
    const period = yield* renewalPeriod({
      billingPeriod: "monthly",
      timeZone: IanaTimeZone.make("America/New_York"),
      originalStartsAt: DateTime.makeUnsafe("2024-02-01T04:30:00Z"),
      previousEndsAt: DateTime.makeUnsafe("2024-03-01T04:30:00Z"),
    });
    expect(DateTime.formatIso(period.endsAt)).toBe("2024-04-01T03:30:00.000Z");
    const ordinary = yield* renewalPeriod({
      billingPeriod: "monthly",
      timeZone: bogota,
      originalStartsAt: DateTime.makeUnsafe("2026-01-15T15:00:00Z"),
      previousEndsAt: DateTime.makeUnsafe("2026-02-15T15:00:00Z"),
    });
    expect(DateTime.formatIso(ordinary.endsAt)).toBe("2026-03-15T15:00:00.000Z");
    const yearly = yield* renewalPeriod({
      billingPeriod: "yearly",
      timeZone: bogota,
      originalStartsAt: DateTime.makeUnsafe("2024-06-15T15:00:00Z"),
      previousEndsAt: DateTime.makeUnsafe("2025-06-15T15:00:00Z"),
    });
    expect(DateTime.formatIso(yearly.endsAt)).toBe("2026-06-15T15:00:00.000Z");
  })
);
