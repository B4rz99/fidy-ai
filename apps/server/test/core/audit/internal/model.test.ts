import { expect, it } from "@effect/vitest";
import { Result, Schema, Struct } from "effect";
import { AuditCaller, AuditLogEntry } from "~/core/audit/contract";

const Caller = AuditCaller.pipe(Schema.toTaggedUnion("_tag")).cases;

const encodeCaller = Schema.encodeSync(AuditCaller);

it("attributes a held canonical call to its exact Turn without fabricating a WebSession", () => {
  const decodeCaller = Schema.decodeUnknownResult(AuditCaller, { onExcessProperty: "error" });
  const turnId = "f1d1a000-0000-4000-8000-000000000004";

  const hostedTurn = Schema.encodeSync(Caller.HostedTurn)(
    Caller.HostedTurn.make({ turnId: Caller.HostedTurn.fields.turnId.make(turnId) })
  );

  expect(Result.isSuccess(decodeCaller(hostedTurn))).toBe(true);
  expect(Result.isFailure(decodeCaller(Struct.omit(hostedTurn, ["turnId"])))).toBe(true);
  expect(Result.isFailure(decodeCaller({ ...hostedTurn, turnId: "not-a-uuid" }))).toBe(true);
  expect(Result.isFailure(decodeCaller({ ...hostedTurn, webSessionId: turnId }))).toBe(true);
});

it("attributes evidence to exactly one PAT, WebSession, or Hosted Agent Session caller", () => {
  const decodeCaller = Schema.decodeUnknownResult(AuditCaller, { onExcessProperty: "error" });
  const patId = "f1d1a000-0000-4000-8000-000000000001";

  const pat = Schema.encodeSync(Caller.PAT)(
    Caller.PAT.make({ patId: Caller.PAT.fields.patId.make(patId) })
  );

  const webSession = encodeCaller(
    Caller.WebSession.make({
      webSessionId: Caller.WebSession.fields.webSessionId.make(
        "f1d1a000-0000-4000-8000-000000000003"
      ),
    })
  );

  const hostedAgentSession = encodeCaller(
    Caller.HostedAgentSession.make({
      hostedAgentSessionId: Caller.HostedAgentSession.fields.hostedAgentSessionId.make(
        "f1d1a000-0000-4000-8000-000000000002"
      ),
    })
  );

  expect(Result.isSuccess(decodeCaller(pat))).toBe(true);
  expect(Result.isSuccess(decodeCaller(webSession))).toBe(true);
  expect(Result.isSuccess(decodeCaller(hostedAgentSession))).toBe(true);
  expect(Result.isFailure(decodeCaller(Struct.omit(pat, ["patId"])))).toBe(true);
  expect(Result.isFailure(decodeCaller({ ...webSession, webSessionId: "not-a-uuid" }))).toBe(true);
  expect(Result.isFailure(decodeCaller({ ...webSession, patId }))).toBe(true);
  expect(Result.isFailure(decodeCaller({ ...hostedAgentSession, patId }))).toBe(true);
});

it("preserves accountable canonical-call metadata without publishing request bodies", () => {
  const id = "10000000-0000-4000-8000-000000000001";

  const value = {
    id,
    subjectUserId: id,
    caller: encodeCaller(Caller.PAT.make({ patId: Caller.PAT.fields.patId.make(id) })),
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
