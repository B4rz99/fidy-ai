import { expect, it } from "@effect/vitest";
import { DateTime, Result, Schema, SchemaIssue } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import {
  AgentIteration,
  CanonicalToolCallEntry,
  CanonicalToolEvidence,
  ConversationTurn,
  FailedTurnTranscriptEntry,
  ToolCallId,
  TranscriptContentEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  TurnContinuationEntry,
  UserTranscriptEntry,
} from "./model";

const decodeTranscriptText = Schema.decodeUnknownResult(Schema.toType(TranscriptText));

it("rejects Transcript text that PostgreSQL JSONB cannot retain", () => {
  expect(Result.isFailure(decodeTranscriptText("contains\u0000nul"))).toBe(true);
  expect(Result.isFailure(decodeTranscriptText("unpaired-high-\ud800"))).toBe(true);
  expect(Result.isFailure(decodeTranscriptText("unpaired-low-\udc00"))).toBe(true);
});

it("accepts canonical tool evidence exactly at the UTF-8 byte limit", () => {
  const decode = Schema.decodeUnknownResult(CanonicalToolEvidence);

  expect(Result.isSuccess(decode("x".repeat(999_998)))).toBe(true);
  expect(Result.isSuccess(decode("é".repeat(499_999)))).toBe(true);
});

it("distinguishes null and mixed canonical JSON arrays", () => {
  const decode = Schema.decodeUnknownResult(CanonicalToolEvidence);

  expect(Result.isSuccess(decode(null))).toBe(true);
  expect(Result.isFailure(decode(["valid", "contains\u0000nul"]))).toBe(true);
});

it("rejects unpersistable or oversized canonical tool evidence", () => {
  const decode = Schema.decodeUnknownResult(CanonicalToolEvidence);

  expect(Result.isFailure(decode({ nested: ["contains\u0000nul"] }))).toBe(true);
  expect(Result.isFailure(decode({ "unpaired-\ud800": true }))).toBe(true);
  expect(Result.isFailure(decode({ negativeZero: -0 }))).toBe(true);
  expect(Result.isFailure(decode("x".repeat(999_999)))).toBe(true);
  expect(Result.isFailure(decode("é".repeat(500_000)))).toBe(true);
});

it("rejects UUID spellings PostgreSQL would canonicalize", () => {
  const uppercase = "F1D1A000-0000-4000-8000-000000000301";
  expect(Result.isFailure(Schema.decodeResult(TranscriptEntryId)(uppercase))).toBe(true);
  expect(Result.isFailure(Schema.decodeResult(TranscriptTurnId)(uppercase))).toBe(true);
});

it("accepts continuation and content unions at their public seams", () => {
  const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000301");
  const user = UserTranscriptEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000302"),
    turnId,
    text: TranscriptText.make("request"),
    occurredAt: DateTime.makeUnsafe("2026-08-11T12:00:00Z"),
  });
  const call = CanonicalToolCallEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000303"),
    turnId,
    iteration: AgentIteration.make(1),
    toolCallId: ToolCallId.make("call-1"),
    operation: CanonicalOperationId.make("categories.listCategories"),
    input: {},
    occurredAt: DateTime.makeUnsafe("2026-08-11T12:00:00Z"),
  });

  expect(Result.isSuccess(Schema.decodeResult(Schema.toType(TranscriptContentEntry))(user))).toBe(
    true
  );
  expect(Result.isSuccess(Schema.decodeResult(Schema.toType(TurnContinuationEntry))(call))).toBe(
    true
  );
});

it("accepts non-reversed terminal times for every terminal ConversationTurn", () => {
  const id = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000304");
  const startedAt = "2026-08-11T12:00:00Z";
  const terminalAt = "2026-08-11T12:00:00Z";
  const decode = Schema.decodeUnknownResult(ConversationTurn);

  for (const turn of [
    { _tag: "Pending", id, startedAt },
    { _tag: "Completed", id, startedAt, terminalAt },
    { _tag: "Failed", id, startedAt, terminalAt, reason: "DeliveryFailed" },
    { _tag: "Interrupted", id, startedAt, terminalAt },
  ]) {
    expect(Result.isSuccess(decode(turn))).toBe(true);
  }
});

it("models fixed metadata-only failure markers and rejects reversed Turn time", () => {
  const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000301");
  const marker = FailedTurnTranscriptEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000302"),
    turnId,
    reason: "DeliveryFailed",
    occurredAt: DateTime.makeUnsafe("2026-08-11T12:01:00Z"),
  });

  expect(Object.keys(marker).toSorted()).toEqual(["_tag", "id", "occurredAt", "reason", "turnId"]);
  expect(Result.isFailure(Schema.decodeUnknownResult(TranscriptContentEntry)(marker))).toBe(true);
  const reversed = Schema.decodeResult(ConversationTurn)({
    _tag: "Failed",
    id: turnId,
    reason: "DeliveryFailed",
    startedAt: "2026-08-11T12:01:00Z",
    terminalAt: "2026-08-11T12:00:00Z",
  });
  expect(Result.isFailure(reversed)).toBe(true);
  expect(Result.isFailure(reversed) ? String(reversed.failure) : "").toContain("terminalAt");
  expect(
    Result.isFailure(reversed)
      ? SchemaIssue.makeFormatterStandardSchemaV1()(reversed.failure.issue).issues[0]?.path
      : undefined
  ).toEqual(["terminalAt"]);
});
