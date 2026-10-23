import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { AuditCaller, AuditLogEntry } from "~/core/audit/contract";

it("attributes a held canonical call to its exact Turn without fabricating a WebSession", () => {
  const decodeCaller = Schema.decodeUnknownResult(AuditCaller, { onExcessProperty: "error" });
  const turnId = "f1d1a000-0000-4000-8000-000000000004";
  expect(Result.isSuccess(decodeCaller({ _tag: "HostedTurn", turnId }))).toBe(true);
  expect(Result.isFailure(decodeCaller({ _tag: "HostedTurn" }))).toBe(true);
  expect(Result.isFailure(decodeCaller({ _tag: "HostedTurn", turnId: "not-a-uuid" }))).toBe(true);
  expect(Result.isFailure(decodeCaller({ _tag: "HostedTurn", turnId, webSessionId: turnId }))).toBe(
    true
  );
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

it("preserves accountable canonical-call metadata without publishing request bodies", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const value = {
    id,
    subjectUserId: id,
    caller: { _tag: "PAT", patId: id },
    operation: "transactions.list",
    outcome: "succeeded",
    occurredAt: "2026-10-22T12:00:00.000Z",
  };
  const decoded = Schema.decodeUnknownSync(AuditLogEntry)({
    ...value,
    requestBody: "private financial text",
  });
  expect(Schema.encodeSync(AuditLogEntry)(decoded)).toEqual(value);
});
