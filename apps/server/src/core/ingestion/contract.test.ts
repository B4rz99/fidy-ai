import { expect, it } from "vitest";
import { DateTime } from "effect";
import {
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
