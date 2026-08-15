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

it("requires a complete WhatsApp Business Scoped User ID grammar", () => {
  const decodeBusinessScopedUserId = Schema.decodeUnknownResult(WhatsAppBusinessScopedUserId);

  expect(Result.isSuccess(decodeBusinessScopedUserId("CO.ab"))).toBe(true);
  for (const invalid of ["xCO.ab", "CO.ab!", "C.ab", "1O.ab", "CO.ab-1"]) {
    expect(Result.isFailure(decodeBusinessScopedUserId(invalid))).toBe(true);
  }
});

it("requires a complete parent Business Scoped User ID grammar", () => {
  const decodeParentBusinessScopedUserId = Schema.decodeUnknownResult(
    WhatsAppParentBusinessScopedUserId
  );

  expect(Result.isSuccess(decodeParentBusinessScopedUserId("CO.ENT.ab"))).toBe(true);
  for (const invalid of ["xCO.ENT.ab", "CO.ENT.ab!", "C.ENT.ab", "1O.ENT.ab", "CO.ENT.ab-1"]) {
    expect(Result.isFailure(decodeParentBusinessScopedUserId(invalid))).toBe(true);
  }
});

it("projects a WhatsApp caller to its stable cross-slice reference", () => {
  const caller = {
    businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-test"),
    businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.caller123"),
  };

  expect(
    Schema.decodeUnknownSync(WhatsAppCallerReference)(whatsAppCallerReference(caller))
  ).toEqual(caller);
});
