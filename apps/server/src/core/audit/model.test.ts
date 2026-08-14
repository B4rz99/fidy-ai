import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { AuditOutcome, CanonicalOperationId } from "./model";

it("accepts only complete canonical operation ids", () => {
  const decodeOperation = Schema.decodeUnknownResult(CanonicalOperationId);

  expect(Result.isSuccess(decodeOperation("identity.getCurrentUser"))).toBe(true);
  expect(Result.isFailure(decodeOperation("_identity.getCurrentUser"))).toBe(true);
  expect(Result.isFailure(decodeOperation("identity.getCurrentUser!"))).toBe(true);
  expect(Result.isFailure(decodeOperation("identity"))).toBe(true);
});

it("accepts exactly the canonical call outcome vocabulary", () => {
  const decodeOutcome = Schema.decodeUnknownResult(AuditOutcome);

  expect(Result.isSuccess(decodeOutcome("succeeded"))).toBe(true);
  expect(Result.isSuccess(decodeOutcome("rejected"))).toBe(true);
  expect(Result.isSuccess(decodeOutcome("failed"))).toBe(true);
  expect(Result.isFailure(decodeOutcome("unknown"))).toBe(true);
});
