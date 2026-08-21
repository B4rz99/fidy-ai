import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { AuditCaller, AuditOutcome, CanonicalOperationId } from "./model";

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

it("attributes evidence to exactly one PAT, WebSession, or Hosted Agent Session caller", () => {
  const decodeCaller = Schema.decodeUnknownResult(AuditCaller, { onExcessProperty: "error" });

  expect(
    Result.isSuccess(decodeCaller({ _tag: "PAT", patId: "f1d1a000-0000-4000-8000-000000000001" }))
  ).toBe(true);
  expect(
    Result.isSuccess(
      decodeCaller({
        _tag: "WebSession",
        webSessionId: "f1d1a000-0000-4000-8000-000000000003",
      })
    )
  ).toBe(true);
  expect(
    Result.isSuccess(
      decodeCaller({
        _tag: "HostedAgentSession",
        hostedAgentSessionId: "f1d1a000-0000-4000-8000-000000000002",
      })
    )
  ).toBe(true);
  expect(Result.isFailure(decodeCaller({ _tag: "PAT" }))).toBe(true);
  expect(Result.isFailure(decodeCaller({ _tag: "WebSession", webSessionId: "not-a-uuid" }))).toBe(
    true
  );
  expect(
    Result.isFailure(
      decodeCaller({
        _tag: "WebSession",
        patId: "f1d1a000-0000-4000-8000-000000000001",
        webSessionId: "f1d1a000-0000-4000-8000-000000000003",
      })
    )
  ).toBe(true);
  expect(
    Result.isFailure(
      decodeCaller({
        _tag: "HostedAgentSession",
        patId: "f1d1a000-0000-4000-8000-000000000001",
        hostedAgentSessionId: "f1d1a000-0000-4000-8000-000000000002",
      })
    )
  ).toBe(true);
});
