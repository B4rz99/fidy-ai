import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { E164PhoneNumber, UserId } from "./reference";

it("rejects an owner id that is not a UUID", () => {
  const decodeUserId = Schema.decodeUnknownResult(UserId);

  expect(Result.isFailure(decodeUserId("el-corral"))).toBe(true);
});

it("accepts only normalized E.164 WhatsApp phone numbers", () => {
  const decodePhoneNumber = Schema.decodeUnknownResult(E164PhoneNumber);

  expect(Result.isSuccess(decodePhoneNumber("+573001234567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("3001234567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("+57 300 123 4567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("+0573001234567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("x+573001234567"))).toBe(true);
  expect(Result.isFailure(decodePhoneNumber("+573001234567x"))).toBe(true);
});
