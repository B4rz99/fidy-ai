import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  E164PhoneNumber,
  UserId,
  WhatsAppBusinessScopedUserId,
  WhatsAppParentBusinessScopedUserId,
} from "./contract";

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

it("requires complete WhatsApp Business Scoped User ID grammars", () => {
  const assertGrammar = <A, E>(
    decode: (value: string) => Result.Result<A, E>,
    valid: string,
    invalid: ReadonlyArray<string>
  ): void => {
    expect(Result.isSuccess(decode(valid))).toBe(true);
    for (const value of invalid) {
      expect(Result.isFailure(decode(value))).toBe(true);
    }
  };

  assertGrammar(Schema.decodeUnknownResult(WhatsAppBusinessScopedUserId), "CO.ab", [
    "xCO.ab",
    "CO.ab!",
    "C.ab",
    "1O.ab",
    "CO.ab-1",
  ]);
  assertGrammar(Schema.decodeUnknownResult(WhatsAppParentBusinessScopedUserId), "CO.ENT.ab", [
    "xCO.ENT.ab",
    "CO.ENT.ab!",
    "C.ENT.ab",
    "1O.ENT.ab",
    "CO.ENT.ab-1",
  ]);
});

it("enforces E.164 digit bounds and accepts every country-code edge digit", () => {
  const decode = Schema.decodeUnknownResult(E164PhoneNumber);
  for (const value of ["+10000000", "+99999999", "+123456789012345"]) {
    expect(Result.isSuccess(decode(value))).toBe(true);
  }
  for (const value of ["+1234567", "+1234567890123456", "+a2345678", "+1234567a", "+12345678\n"]) {
    expect(Result.isFailure(decode(value))).toBe(true);
  }
});

it("bounds scoped WhatsApp identifiers while retaining case-insensitive alphanumeric identity", () => {
  for (const prefix of ["CO.", "CO.ENT."]) {
    const schema =
      prefix === "CO." ? WhatsAppBusinessScopedUserId : WhatsAppParentBusinessScopedUserId;
    const decode = Schema.decodeUnknownResult(schema);
    for (const suffix of ["a", "Z", "0", "9", "a".repeat(128)]) {
      expect(Result.isSuccess(decode(prefix.toLowerCase() + suffix))).toBe(true);
    }
    for (const suffix of ["", "a".repeat(129), "a_b", "a.b", "á"]) {
      expect(Result.isFailure(decode(prefix + suffix))).toBe(true);
    }
  }
});
