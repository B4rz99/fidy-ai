import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { AccessTier } from "./contract";

it("keeps AccessTier closed to Free and Pro", () => {
  expect(Result.isSuccess(Schema.decodeResult(AccessTier)("free"))).toBe(true);
  expect(Result.isSuccess(Schema.decodeResult(AccessTier)("pro"))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(AccessTier)("trial"))).toBe(true);
});
