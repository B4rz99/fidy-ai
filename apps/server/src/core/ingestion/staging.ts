import { Schema } from "effect";
import { InterpretationRevision } from "~/core/interpretation-evidence/contract";

export {
  maximumStatementBytes,
  StatementContentDigest,
  StatementFailureReason,
  StatementIdempotencyKey,
  StatementStagingId,
  StagedStatementBytes,
  StagedStatementReference,
  SubmitForExtractionInput,
} from "./model";
export { StatementSubmissionId } from "./reference";
export { StatementSourceFormat } from "./reference";
export { StatementSubmission } from "./model";

const hoursPerDay = 24;
const minutesPerHour = 60;
const secondsPerMinute = 60;
const millisecondsPerSecond = 1000;
const maximumSweepRows = 200;
const maximumOutstandingSubmissions = 5;
const maximumSubmissionsPerHour = 20;

/**
 * How long unpublished staged statement bytes stay readable. Expiry is a hard bound, not a
 * retention preference: an expired staging row is neither publishable nor readable, and the
 * bounded sweep may delete its R2 object at any point after it.
 */
export const statementStagingLifetimeMilliseconds =
  hoursPerDay * minutesPerHour * secondsPerMinute * millisecondsPerSecond;

/**
 * How long one published submission may retain its staged material before extraction must have
 * consumed it. A queued submission past this bound becomes a visible `retention-expired` failure
 * and its bytes are reclaimed, so a submission that never runs cannot retain material forever.
 */
export const statementSubmissionRetentionMilliseconds = statementStagingLifetimeMilliseconds;

/** Largest number of expired staging rows one cleanup sweep will act on. */
export const maximumStatementStagingSweep = maximumSweepRows;

/** Largest number of a User's own submissions that may await or run extraction at once. */
export const maximumOutstandingStatementSubmissions = maximumOutstandingSubmissions;

/** Largest number of submissions one User may publish in a rolling hour. */
export const maximumStatementSubmissionsPerHour = maximumSubmissionsPerHour;

/** Stable revision of the statement interpretation pipeline recorded on every submission. */
export const statementParserRevision = InterpretationRevision.make("statement-parser-v1");

/**
 * Closed statement-material refusal vocabulary. Reasons are safe to map to canonical failures:
 * none contains statement contents, a filename, a digest, or platform detail. `cancelled` means the
 * caller's own request ended before the bytes were complete; `paywall` means the User's Free
 * statement backfill is already reserved or consumed; `unsupported-format` means the actual bytes
 * were not a tabular statement.
 */
export const StatementStagingFailureReason = Schema.Literals([
  "resource-limit",
  "unsupported-format",
  "malformed-file",
  "cancelled",
  "retention-expired",
  "not-found",
  "conflict",
  "paywall",
]);
export type StatementStagingFailureReason = typeof StatementStagingFailureReason.Type;
