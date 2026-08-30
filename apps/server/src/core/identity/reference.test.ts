import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  E164PhoneNumber,
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  WhatsAppCallerReference,
  WhatsAppParentBusinessScopedUserId,
  whatsAppCallerReference,
} from "./reference";

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

it("projects a WhatsApp caller to its stable cross-slice reference", () => {
  const caller = {
    businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-test"),
    businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.caller123"),
  };

  expect(Schema.decodeSync(WhatsAppCallerReference)(whatsAppCallerReference(caller))).toEqual(
    caller
  );
});
