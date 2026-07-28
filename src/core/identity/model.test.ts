import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { E164PhoneNumber, UserPreferences } from "./model";

it("accepts only normalized E.164 WhatsApp phone numbers", () => {
  const decodePhoneNumber = Schema.decodeUnknownResult(E164PhoneNumber);

  expect(Result.isSuccess(decodePhoneNumber("+573001234567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("3001234567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("+57 300 123 4567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("+0573001234567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("x+573001234567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("+573001234567x"))).toBe(true);
});

it("derives editable User preferences as locale and time zone together", () => {
  const decoded = Schema.decodeUnknownResult(UserPreferences)({
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
