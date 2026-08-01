import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { UserPreferences } from "./model";

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
