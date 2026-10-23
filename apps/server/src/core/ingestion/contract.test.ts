import { expect, it } from "vitest";
import { DateTime, Schema } from "effect";
import {
  ReviewStatus,
  StatementStagingFailureReason,
  statementStagingLifetimeMilliseconds,
  statementSubmissionRetentionMilliseconds,
} from "./contract";

it("bounds staged and queued statement retention to exactly one elapsed day", () => {
  const stagedAt = DateTime.makeUnsafe("2026-10-31T12:34:56.000Z").epochMilliseconds;
  expect(
    DateTime.formatIso(DateTime.makeUnsafe(stagedAt + statementStagingLifetimeMilliseconds))
  ).toBe("2026-11-01T12:34:56.000Z");
  expect(
    DateTime.formatIso(DateTime.makeUnsafe(stagedAt + statementSubmissionRetentionMilliseconds))
  ).toBe("2026-11-01T12:34:56.000Z");
});
it("retains safe statement refusal reasons and review settlement states", () => {
  for (const value of [
    "resource-limit",
    "unsupported-format",
    "malformed-file",
    "cancelled",
    "retention-expired",
    "not-found",
    "conflict",
    "paywall",
  ]) {
    expect(Schema.decodeUnknownSync(StatementStagingFailureReason)(value)).toBe(value);
  }
  for (const value of ["pending", "created", "skipped", "expired"]) {
    expect(Schema.decodeUnknownSync(ReviewStatus)(value)).toBe(value);
  }
});
