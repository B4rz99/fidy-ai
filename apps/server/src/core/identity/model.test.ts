import { expect, it } from "@effect/vitest";
import { DateTime, Result, Schema } from "effect";
import { EffectiveAccess, PaidTier, TrialPeriod, UserPreferences } from "./model";

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

it("keeps PaidTier and EffectiveAccess closed to unknown values", () => {
  for (const schema of [PaidTier, EffectiveAccess]) {
    expect(Result.isSuccess(Schema.decodeResult(schema)("free"))).toBe(true);
    expect(Result.isSuccess(Schema.decodeResult(schema)("pro"))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(schema)("trial"))).toBe(true);
  }
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
