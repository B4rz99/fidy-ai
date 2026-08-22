import { expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { calculateWebSessionDeadlines } from "./rules";

it("starts one WebSession with ten-minute freshness, thirty-day idle, and ninety-day hard deadlines", () => {
  const pairedAt = DateTime.makeUnsafe("2026-03-01T12:00:00.000Z");

  expect(calculateWebSessionDeadlines(pairedAt)).toEqual({
    freshUntil: DateTime.makeUnsafe("2026-03-01T12:10:00.000Z"),
    idleExpiresAt: DateTime.makeUnsafe("2026-03-31T12:00:00.000Z"),
    hardExpiresAt: DateTime.makeUnsafe("2026-05-30T12:00:00.000Z"),
  });
});
