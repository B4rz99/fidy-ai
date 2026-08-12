import { expect, it } from "@effect/vitest";
import { DateTime, Result, Schema } from "effect";
import {
  CanonicalToolEvidence,
  ConversationTurn,
  FailedTurnTranscriptEntry,
  TranscriptContentEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
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
  expect(Result.isFailure(Schema.decodeUnknownResult(TranscriptEntryId)(uppercase))).toBe(true);
  expect(Result.isFailure(Schema.decodeUnknownResult(TranscriptTurnId)(uppercase))).toBe(true);
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
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(ConversationTurn)({
        _tag: "Failed",
        id: turnId,
        reason: "DeliveryFailed",
        startedAt: "2026-08-11T12:01:00Z",
        terminalAt: "2026-08-11T12:00:00Z",
      })
    )
  ).toBe(true);
});
