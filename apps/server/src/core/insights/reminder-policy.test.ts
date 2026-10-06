import { expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { ReminderCadence, ReminderStanding } from "./contract";
import { IanaTimeZone } from "~/core/_shared/context";
import {
  budgetAlertDeadline,
  latestReminderOccurrence,
  nextReminderOccurrence,
} from "./operations";

it("keeps a three-local-day anchor across the end of a month", () => {
  const next = nextReminderOccurrence({
    after: DateTime.makeUnsafe("2026-01-31T23:00:00Z"),
    timing: { hour: 18, minute: 0 },
    cadence: { kind: "every-three-days", anchorDate: "2026-01-28" },
    timeZone: IanaTimeZone.make("America/Bogota"),
  });
  expect(DateTime.formatIso(next)).toBe("2026-02-03T23:00:00.000Z");
});

it("recovers only the latest anchored reminder after missed occurrences, including its exact cutoff", () => {
  const input = {
    timing: { hour: 18, minute: 0 },
    cadence: { kind: "every-three-days" as const, anchorDate: "2026-01-28" },
    timeZone: IanaTimeZone.make("America/Bogota"),
  };
  expect(
    DateTime.formatIso(
      latestReminderOccurrence({
        ...input,
        atOrBefore: DateTime.makeUnsafe("2026-02-10T22:59:59Z"),
      })
    )
  ).toBe("2026-02-09T23:00:00.000Z");
  expect(
    DateTime.formatIso(
      latestReminderOccurrence({
        ...input,
        atOrBefore: DateTime.makeUnsafe("2026-02-12T23:00:00Z"),
      })
    )
  ).toBe("2026-02-12T23:00:00.000Z");
});

it("expires unstarted Budget alert sends at month-end even when detection was less than 24 hours earlier", () => {
  expect(
    DateTime.formatIso(
      budgetAlertDeadline({
        detectedAt: DateTime.makeUnsafe("2026-02-01T03:00:00Z"),
        monthEnd: DateTime.makeUnsafe("2026-02-01T05:00:00Z"),
      })
    )
  ).toBe("2026-02-01T05:00:00.000Z");
  expect(
    DateTime.formatIso(
      budgetAlertDeadline({
        detectedAt: DateTime.makeUnsafe("2026-01-28T23:00:00Z"),
        monthEnd: DateTime.makeUnsafe("2026-02-01T05:00:00Z"),
      })
    )
  ).toBe("2026-01-29T23:00:00.000Z");
});

it("rejects malformed cadence instructions and impossible reminder attention states", () => {
  for (const anchorDate of ["2026-02-30", "2026-1-28", "not-a-date"]) {
    expect(
      Schema.decodeOption(ReminderCadence)({ kind: "every-three-days", anchorDate })._tag
    ).toBe("None");
  }
  expect(Schema.decodeOption(ReminderCadence)({ kind: "weekly", weekday: 7 })._tag).toBe("None");
  expect(
    Schema.decodeUnknownOption(ReminderStanding)({ _tag: "QuestionDelivered", unanswered: 2 })._tag
  ).toBe("None");
  expect(Schema.decodeUnknownOption(ReminderStanding)({ _tag: "Paused", unanswered: 5 })._tag).toBe(
    "None"
  );
});

it("skips weekends and chooses weekly occurrences strictly after the selected time", () => {
  const input = {
    timing: { hour: 18, minute: 0 },
    timeZone: IanaTimeZone.make("America/Bogota"),
    after: DateTime.makeUnsafe("2026-10-09T23:00:00Z"),
  };
  expect(
    DateTime.formatIso(nextReminderOccurrence({ ...input, cadence: { kind: "weekdays" } }))
  ).toBe("2026-10-12T23:00:00.000Z");
  expect(
    DateTime.formatIso(
      nextReminderOccurrence({ ...input, cadence: { kind: "weekly", weekday: 5 } })
    )
  ).toBe("2026-10-16T23:00:00.000Z");
});

it("keeps the anchored local time across daylight saving rather than adding 72 elapsed hours", () => {
  const input = {
    timing: { hour: 18, minute: 0 },
    timeZone: IanaTimeZone.make("America/New_York"),
    cadence: { kind: "every-three-days" as const, anchorDate: "2026-10-30" },
  };
  expect(
    DateTime.formatIso(
      nextReminderOccurrence({
        ...input,
        after: DateTime.makeUnsafe("2026-10-30T22:00:00Z"),
      })
    )
  ).toBe("2026-11-02T23:00:00.000Z");
});
