import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { AccessTier } from "./contract";
import { deriveAccessTier } from "./operations";

it("keeps AccessTier closed to Free and Pro", () => {
  expect(Result.isSuccess(Schema.decodeResult(AccessTier)("free"))).toBe(true);
  expect(Result.isSuccess(Schema.decodeResult(AccessTier)("pro"))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(AccessTier)("trial"))).toBe(true);
});

it("grants Pro from either current basis and Free without either", () => {
  expect(deriveAccessTier({ trialActive: true, paidProActive: false })).toBe("pro");
  expect(deriveAccessTier({ trialActive: false, paidProActive: true })).toBe("pro");
  expect(deriveAccessTier({ trialActive: false, paidProActive: false })).toBe("free");
});
