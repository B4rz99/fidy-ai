import { expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { WeeklyPeriods, WeeklyTiming } from "./contract";
import { IanaTimeZone } from "~/core/_shared/context";
import {
  decideInsightDelivery,
  insightDeliveryDeadline,
  latestWeeklyOccurrence,
  nextWeeklyOccurrence,
  weeklyPeriods,
} from "./operations";

it("freezes consecutive Sunday 18:00 reporting periods in the captured Bogotá zone", () => {
  const periods = weeklyPeriods({
    scheduledAt: DateTime.makeUnsafe("2026-10-11T23:00:00Z"),
    timeZone: IanaTimeZone.make("America/Bogota"),
  });
  expect(DateTime.formatIso(periods.current.from)).toBe("2026-10-04T23:00:00.000Z");
  expect(DateTime.formatIso(periods.current.toExclusive)).toBe("2026-10-11T23:00:00.000Z");
  expect(DateTime.formatIso(periods.previous.from)).toBe("2026-09-27T23:00:00.000Z");
  expect(DateTime.formatIso(periods.previous.toExclusive)).toBe("2026-10-04T23:00:00.000Z");
});

it("keeps seven local days across daylight saving rather than subtracting 168 elapsed hours", () => {
  const periods = weeklyPeriods({
    scheduledAt: DateTime.makeUnsafe("2026-11-01T23:00:00Z"),
    timeZone: IanaTimeZone.make("America/New_York"),
  });
  expect(DateTime.formatIso(periods.current.from)).toBe("2026-10-25T22:00:00.000Z");
});

it("defers a closed-window attempt to 09:00 but refuses a new send at its exact expiry", () => {
  const input = {
    scheduledAt: DateTime.makeUnsafe("2026-10-11T23:00:00Z"),
    expiresAt: DateTime.makeUnsafe("2026-10-12T23:00:00Z"),
    timeZone: IanaTimeZone.make("America/Bogota"),
  };
  const closed = decideInsightDelivery({
    ...input,
    now: DateTime.makeUnsafe("2026-10-12T00:00:00Z"),
  });
  expect(closed._tag).toBe("Deferred");
  if (closed._tag === "Deferred") {
    expect(DateTime.formatIso(closed.nextEligibleAt)).toBe("2026-10-12T14:00:00.000Z");
  }
  expect(
    decideInsightDelivery({ ...input, now: DateTime.makeUnsafe("2026-10-12T23:00:00Z") })
  ).toEqual({ _tag: "Expired" });
});

it("includes 09:00, excludes 19:00 and never sends before the original due instant", () => {
  const input = {
    scheduledAt: DateTime.makeUnsafe("2026-10-11T23:00:00Z"),
    expiresAt: DateTime.makeUnsafe("2026-10-12T23:00:00Z"),
    timeZone: IanaTimeZone.make("America/Bogota"),
  };
  expect(
    decideInsightDelivery({ ...input, now: DateTime.makeUnsafe("2026-10-11T22:59:59Z") })._tag
  ).toBe("Deferred");
  expect(
    decideInsightDelivery({ ...input, now: DateTime.makeUnsafe("2026-10-11T23:59:59.999Z") })._tag
  ).toBe("Ready");
  expect(
    decideInsightDelivery({ ...input, now: DateTime.makeUnsafe("2026-10-12T13:59:59Z") })._tag
  ).toBe("Deferred");
  expect(
    decideInsightDelivery({ ...input, now: DateTime.makeUnsafe("2026-10-12T14:00:00Z") })._tag
  ).toBe("Ready");
  expect(
    decideInsightDelivery({
      ...input,
      expiresAt: DateTime.makeUnsafe("2026-10-12T14:00:00Z"),
      now: DateTime.makeUnsafe("2026-10-12T13:00:00Z"),
    })._tag
  ).toBe("Expired");
});

it("rejects a persisted report whose comparison period overlaps its current period", () => {
  const decoded = Schema.decodeOption(Schema.toCodecJson(WeeklyPeriods))({
    current: { from: "2026-10-04T23:00:00Z", toExclusive: "2026-10-11T23:00:00Z" },
    previous: { from: "2026-09-27T23:00:00Z", toExclusive: "2026-10-05T23:00:00Z" },
  });
  expect(decoded._tag).toBe("None");
});

it("finds the next Sunday 18:00 strictly after the decision instant and rejects invalid timing", () => {
  const timing = WeeklyTiming.make({ weekday: 0, hour: 18, minute: 0 });
  const next = nextWeeklyOccurrence({
    after: DateTime.makeUnsafe("2026-10-11T23:00:00Z"),
    timing,
    timeZone: IanaTimeZone.make("America/Bogota"),
  });
  expect(DateTime.formatIso(next)).toBe("2026-10-18T23:00:00.000Z");
  expect(Schema.decodeOption(WeeklyTiming)({ weekday: 7, hour: 24, minute: 60 })._tag).toBe("None");
});

it("selects only the latest scheduled cutoff after missed weeks, including the exact cutoff", () => {
  const input = {
    timing: WeeklyTiming.make({ weekday: 0, hour: 18, minute: 0 }),
    timeZone: IanaTimeZone.make("America/Bogota"),
  };
  expect(
    DateTime.formatIso(
      latestWeeklyOccurrence({ ...input, atOrBefore: DateTime.makeUnsafe("2026-10-11T23:00:00Z") })
    )
  ).toBe("2026-10-11T23:00:00.000Z");
  expect(
    DateTime.formatIso(
      latestWeeklyOccurrence({ ...input, atOrBefore: DateTime.makeUnsafe("2026-10-12T14:00:00Z") })
    )
  ).toBe("2026-10-11T23:00:00.000Z");
});

it("expires a Sunday summary after exactly 24 elapsed hours, or sooner at the next occurrence", () => {
  const scheduledAt = DateTime.makeUnsafe("2026-10-11T23:00:00Z");
  expect(
    DateTime.formatIso(
      insightDeliveryDeadline({
        scheduledAt,
        nextScheduledAt: DateTime.makeUnsafe("2026-10-18T23:00:00Z"),
      })
    )
  ).toBe("2026-10-12T23:00:00.000Z");
  expect(
    DateTime.formatIso(
      insightDeliveryDeadline({
        scheduledAt,
        nextScheduledAt: DateTime.makeUnsafe("2026-10-12T15:00:00Z"),
      })
    )
  ).toBe("2026-10-12T15:00:00.000Z");
});
