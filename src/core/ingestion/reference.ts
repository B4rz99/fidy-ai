import { Schema } from "effect";

/** Stable kind code for deterministic tabular statement formats. */
export const StatementSourceFormat = Schema.Literals(["csv", "xlsx"]);
export type StatementSourceFormat = typeof StatementSourceFormat.Type;

/** Stable identity of one durable statement submission. */
export const StatementSubmissionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("StatementSubmissionId"))
  .annotate({ identifier: "StatementSubmissionId" });
export type StatementSubmissionId = typeof StatementSubmissionId.Type;

/** Stable identity of one visible statement row awaiting or retaining resolution metadata. */
export const NeedsReviewItemId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("NeedsReviewItemId"))
  .annotate({ identifier: "NeedsReviewItemId" });
export type NeedsReviewItemId = typeof NeedsReviewItemId.Type;
