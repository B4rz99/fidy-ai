import { expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { calculateWebSessionDeadlines, renewWebSessionIdleDeadline } from "./rules";

it("starts one WebSession with ten-minute freshness, thirty-day idle, and ninety-day hard deadlines", () => {
  const pairedAt = DateTime.makeUnsafe("2026-03-01T12:00:00.000Z");

  expect(calculateWebSessionDeadlines(pairedAt)).toEqual({
    freshUntil: DateTime.makeUnsafe("2026-03-01T12:10:00.000Z"),
    idleExpiresAt: DateTime.makeUnsafe("2026-03-31T12:00:00.000Z"),
    hardExpiresAt: DateTime.makeUnsafe("2026-05-30T12:00:00.000Z"),
  });
});

it("extends ordinary idle use by thirty days without shortening a later deadline", () => {
  const hardExpiresAt = DateTime.makeUnsafe("2026-05-30T12:00:00.000Z");
  const currentIdleExpiresAt = DateTime.makeUnsafe("2026-04-15T12:00:00.000Z");

  expect(
    renewWebSessionIdleDeadline({
      usedAt: DateTime.makeUnsafe("2026-03-10T12:00:00.000Z"),
      currentIdleExpiresAt,
      hardExpiresAt,
    })
  ).toEqual(currentIdleExpiresAt);
  expect(
    renewWebSessionIdleDeadline({
      usedAt: DateTime.makeUnsafe("2026-03-20T12:00:00.000Z"),
      currentIdleExpiresAt,
      hardExpiresAt,
    })
  ).toEqual(DateTime.makeUnsafe("2026-04-19T12:00:00.000Z"));
});

it("renews idle use without crossing the immutable hard deadline", () => {
  const hardExpiresAt = DateTime.makeUnsafe("2026-05-30T12:00:00.000Z");

  expect(
    renewWebSessionIdleDeadline({
      usedAt: DateTime.makeUnsafe("2026-05-20T12:00:00.000Z"),
      currentIdleExpiresAt: DateTime.makeUnsafe("2026-05-21T12:00:00.000Z"),
      hardExpiresAt,
    })
  ).toEqual(hardExpiresAt);
});
