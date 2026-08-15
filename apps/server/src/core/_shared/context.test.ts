import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { IanaTimeZone } from "./context";

const decodeTimeZone = Schema.decodeUnknownResult(IanaTimeZone);

it("accepts named IANA time zones beyond the Colombian default", () => {
  expect(Result.isSuccess(decodeTimeZone("America/New_York"))).toBe(true);
});

it("rejects strings and fixed offsets that are not named IANA time zones", () => {
  expect(Result.isFailure(decodeTimeZone("Bogota-ish"))).toBe(true);
  expect(Result.isFailure(decodeTimeZone("-05:00"))).toBe(true);
  expect(Result.isFailure(decodeTimeZone("+05:30"))).toBe(true);
});

it("attributes an invalid IANA time zone only to its containing field", () => {
  const decodePreferences = Schema.decodeUnknownResult(Schema.Struct({ timeZone: IanaTimeZone }));
  const decoded = decodePreferences({ timeZone: "Bogota-ish" });

  expect(Result.isFailure(decoded) ? String(decoded.failure) : "").toBe(
    'SchemaError(Expected a valid named IANA time zone\n  at ["timeZone"])'
  );
});
