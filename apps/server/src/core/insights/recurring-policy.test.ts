import { expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { ConfirmationDay, RecurringDigestPayload } from "./contract";
import { IanaTimeZone } from "~/core/_shared/context";
import { captureConfirmationDay, recurringDigestTiming } from "./operations";

it("captures a complete local day and schedules the following local morning", () => {
  const day = captureConfirmationDay({
    confirmedAt: DateTime.makeUnsafe("2026-10-07T04:59:59Z"),
    timeZone: IanaTimeZone.make("America/Bogota"),
  });
  expect(day.localDate).toBe("2026-10-06");
  expect(DateTime.formatIso(day.from)).toBe("2026-10-06T05:00:00.000Z");
  expect(DateTime.formatIso(day.toExclusive)).toBe("2026-10-07T05:00:00.000Z");
  const timing = recurringDigestTiming(day);
  expect(DateTime.formatIso(timing.scheduledAt)).toBe("2026-10-07T14:00:00.000Z");
  expect(DateTime.formatIso(timing.expiresAt)).toBe("2026-10-08T14:00:00.000Z");
});

it("distinguishes equal date labels after backward travel and preserves daylight-saving day length", () => {
  const confirmedAt = DateTime.makeUnsafe("2026-11-01T16:00:00Z");
  const east = captureConfirmationDay({ confirmedAt, timeZone: IanaTimeZone.make("Asia/Tokyo") });
  const west = captureConfirmationDay({
    confirmedAt,
    timeZone: IanaTimeZone.make("America/New_York"),
  });
  const earlier = captureConfirmationDay({
    confirmedAt: DateTime.makeUnsafe("2026-11-01T10:00:00Z"),
    timeZone: IanaTimeZone.make("Asia/Tokyo"),
  });
  expect(earlier.localDate).toBe(west.localDate);
  expect(DateTime.formatIso(earlier.from)).toBe("2026-10-31T15:00:00.000Z");
  expect(DateTime.formatIso(west.from)).toBe("2026-11-01T04:00:00.000Z");
  expect(DateTime.formatIso(west.toExclusive)).toBe("2026-11-02T05:00:00.000Z");
  expect(east.localDate).toBe("2026-11-02");
  expect(DateTime.formatIso(recurringDigestTiming(west).scheduledAt)).toBe(
    "2026-11-02T14:00:00.000Z"
  );
});

it("rejects empty, duplicate, unordered and out-of-window digest items without losing exact Money", () => {
  const day = captureConfirmationDay({
    confirmedAt: DateTime.makeUnsafe("2026-10-06T18:00:00Z"),
    timeZone: IanaTimeZone.make("America/Bogota"),
  });
  const item = {
    confirmationId: "10000000-0000-4000-8000-000000000001",
    seriesId: "20000000-0000-4000-8000-000000000001",
    counterparty: "Netflix",
    money: { amount: "12345678901234567890.12", currency: "COP" },
    cadence: { kind: "monthly" },
    confirmedAt: "2026-10-06T18:00:00.000Z",
  };
  const codec = Schema.toCodecJson(RecurringDigestPayload);
  const confirmationDay = Schema.encodeSync(Schema.toCodecJson(ConfirmationDay))(day);
  const decoded = Schema.decodeSync(codec)({ confirmationDay, items: [item] });
  expect(Schema.encodeSync(codec)(decoded)).toEqual({ confirmationDay, items: [item] });
  for (const items of [
    [],
    [item, item],
    [{ ...item, money: { ...item.money, amount: "0" } }],
    [{ ...item, confirmedAt: "2026-10-07T05:00:00.000Z" }],
    [
      item,
      { ...item, confirmationId: "10000000-0000-4000-8000-000000000002", counterparty: "Amazon" },
    ],
  ]) {
    expect(Schema.decodeOption(codec)({ confirmationDay, items })._tag).toBe("None");
  }
});
