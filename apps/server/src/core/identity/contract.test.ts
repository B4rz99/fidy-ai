import { expect, it } from "@effect/vitest";
import { DateTime, Result, Schema } from "effect";
import { TrialPeriod, UserContext, UserPreferences } from "./contract";

it("accepts only a TrialPeriod lasting exactly 168 hours", () => {
  const startedAt = "2026-08-01T12:00:00Z";
  const exact = Schema.decodeResult(TrialPeriod)({
    startedAt,
    endsAt: "2026-08-08T12:00:00Z",
  });
  const tooLong = Schema.decodeResult(TrialPeriod)({
    startedAt,
    endsAt: "2026-08-08T12:00:00.001Z",
  });

  expect(Result.getOrThrow(exact)).toMatchObject({ startedAt: DateTime.makeUnsafe(startedAt) });
  expect(Result.isFailure(tooLong)).toBe(true);
  expect(Result.isFailure(tooLong) ? String(tooLong.failure) : "").toContain("endsAt");
});

it("derives editable User preferences as locale and time zone together", () => {
  const decoded = Schema.decodeResult(UserPreferences)({
    locale: "es-CO",
    timeZone: "America/Bogota",
  });

  expect(Result.getOrThrow(decoded)).toEqual({
    locale: "es-CO",
    timeZone: "America/Bogota",
  });
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(UserPreferences)({
        locale: "en-US",
        timeZone: "America/Bogota",
      })
    )
  ).toBe(true);
});

it("retains explicit User context without inferring defaults or exposing identity", () => {
  const decoded = Schema.decodeUnknownResult(UserContext)({
    id: "f1d1a000-0000-4000-8000-000000000001",
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/New_York",
  });

  expect(Result.getOrThrow(decoded)).toEqual({
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/New_York",
  });
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(UserContext)({ serviceMarket: "CO", locale: "es-CO" })
    )
  ).toBe(true);
});
