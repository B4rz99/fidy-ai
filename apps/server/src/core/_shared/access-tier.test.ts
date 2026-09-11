import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { AccessTier, decideAccessTier } from "./access-tier";

it("keeps AccessTier closed to Free and Pro", () => {
  expect(Result.isSuccess(Schema.decodeResult(AccessTier)("free"))).toBe(true);
  expect(Result.isSuccess(Schema.decodeResult(AccessTier)("pro"))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(AccessTier)("trial"))).toBe(true);
});

it.effect("grants Pro from either current basis and Free without either", () =>
  Effect.gen(function* () {
    expect(yield* decideAccessTier({ trialActive: true, paidProActive: false })).toBe("pro");
    expect(yield* decideAccessTier({ trialActive: false, paidProActive: true })).toBe("pro");
    expect(yield* decideAccessTier({ trialActive: false, paidProActive: false })).toBe("free");
  })
);
