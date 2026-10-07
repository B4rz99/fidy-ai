import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import { paidPeriodFor, weeklyRenewalPeriod } from "./operations";

const finalizedAt = DateTime.makeUnsafe("2026-01-31T23:30:00.000Z");
const bogota = IanaTimeZone.make("America/Bogota");

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
      const period = yield* weeklyRenewalPeriod({
        timeZone: bogota,
        previousEndsAt: DateTime.makeUnsafe("2026-02-07T23:30:00Z"),
      });
      expect(DateTime.formatIso(period.startsAt)).toBe("2026-02-07T23:30:00.000Z");
      expect(DateTime.formatIso(period.endsAt)).toBe("2026-02-14T23:30:00.000Z");
      expect(DateTime.formatIso(period.renewalAnchor)).toBe("2026-02-14T23:30:00.000Z");
    })
);
