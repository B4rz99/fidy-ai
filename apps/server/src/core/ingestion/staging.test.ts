import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  StagedStatementBytes,
  StagedStatementReference,
  StatementStagingId,
  maximumStatementBytes,
} from "./staging";

const stagingId = "f1d1a000-0000-4000-8000-000000000501";
const sha256 = "a".repeat(64);

it("rejects a staging identity that is not an unpredictable branded UUID", () => {
  const decode = Schema.decodeUnknownResult(StatementStagingId);
  expect(Result.isSuccess(decode(stagingId))).toBe(true);
  for (const value of ["staging-1", "f1d1a00000004000800000000000501", ""]) {
    expect(Result.isFailure(decode(value))).toBe(true);
  }
});

it("accepts only a full lowercase SHA-256 digest", () => {
  const decode = Schema.decodeUnknownResult(StagedStatementReference);
  expect(Result.isSuccess(decode({ stagingId, byteLength: 1, sha256 }))).toBe(true);
  for (const digest of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
    expect(Result.isFailure(decode({ stagingId, byteLength: 1, sha256: digest }))).toBe(true);
  }
});

it("rejects staged bytes that are empty or above the platform statement bound", () => {
  const decode = Schema.decodeUnknownResult(StagedStatementBytes);
  const bytes = (byteLength: number): unknown => ({
    stagingId,
    byteLength,
    sha256,
    sourceFormat: "csv" as const,
    expiresAt: "2026-08-01T12:00:00Z",
  });
  expect(Result.isSuccess(decode(bytes(maximumStatementBytes)))).toBe(true);
  for (const byteLength of [0, -1, maximumStatementBytes + 1, 1.5]) {
    expect(Result.isFailure(decode(bytes(byteLength)))).toBe(true);
  }
});

it("requires a reference to carry identity, actual size, and digest together", () => {
  const decode = Schema.decodeUnknownResult(StagedStatementReference);
  expect(Result.isSuccess(decode({ stagingId, byteLength: 1, sha256 }))).toBe(true);
  const { stagingId: _stagingId, ...withoutIdentity } = { stagingId, byteLength: 1, sha256 };
  const { byteLength: _byteLength, ...withoutSize } = { stagingId, byteLength: 1, sha256 };
  const { sha256: _sha256, ...withoutDigest } = { stagingId, byteLength: 1, sha256 };
  for (const value of [withoutIdentity, withoutSize, withoutDigest, {}]) {
    expect(Result.isFailure(decode(value))).toBe(true);
  }
});
