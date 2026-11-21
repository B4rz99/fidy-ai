import {
  type StatementAccounting,
  StatementSubmissionStatus,
} from "../../../src/core/ingestion/contract";
import {
  StatementFailureReason,
  StatementSubmission,
  StatementSubmissionId,
} from "../../../src/shell/ingestion/contract";
import { Data, type DateTime, Effect, Option, Schema } from "effect";

export class StatementStagingUnavailable extends Data.TaggedError("StatementStagingUnavailable")<{
  readonly reason: "authority_unavailable";
}> {}

export type StoredStatementSubmission = Readonly<{
  readonly id: StatementSubmissionId;
  readonly sourceFormat: "csv" | "xlsx";
  readonly parserRevision: string;
  readonly status: typeof StatementSubmissionStatus.Type;
  readonly submittedAt: DateTime.Utc;
  readonly startedAt: Option.Option<DateTime.Utc>;
  readonly completedAt: Option.Option<DateTime.Utc>;
  readonly failureReason: Option.Option<typeof StatementFailureReason.Type>;
  readonly inputRows: Option.Option<number>;
  readonly acceptedRows: Option.Option<number>;
  readonly needsReviewRows: Option.Option<number>;
  readonly skippedRows: number;
  readonly abandonedRows: number;
}>;

const StoredSubmissionRow = Schema.Struct({
  accepted_rows: Schema.OptionFromNullOr(Schema.Int),
  completed_at_ms: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  failure_reason: Schema.OptionFromNullOr(StatementFailureReason),
  id: StatementSubmissionId,
  input_rows: Schema.OptionFromNullOr(Schema.Int),
  needs_review_rows: Schema.OptionFromNullOr(Schema.Int),
  parser_revision: Schema.String,
  source_format: Schema.Literals(["csv", "xlsx"]),
  started_at_ms: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  status: StatementSubmissionStatus,
  skipped_rows: Schema.Int,
  abandoned_rows: Schema.Int,
  submitted_at_ms: Schema.DateTimeUtcFromMillis,
});

const unavailable = (): StatementStagingUnavailable =>
  new StatementStagingUnavailable({ reason: "authority_unavailable" });

type SubmissionBase = Readonly<{
  readonly id: ReturnType<typeof StatementSubmissionId.make>;
  readonly parserRevision: string;
  readonly sourceFormat: "csv" | "xlsx";
  readonly submittedAt: DateTime.Utc;
}>;

const submissionBase = (stored: StoredStatementSubmission): SubmissionBase => ({
  id: stored.id,
  parserRevision: stored.parserRevision,
  sourceFormat: stored.sourceFormat,
  submittedAt: stored.submittedAt,
});

const failedProjection = (
  base: SubmissionBase,
  stored: StoredStatementSubmission
): Option.Option<StatementSubmission> => {
  if (
    Option.isNone(stored.startedAt) ||
    Option.isNone(stored.completedAt) ||
    Option.isNone(stored.failureReason)
  ) {
    return Option.none();
  }

  return Option.some({
    ...base,
    completedAt: stored.completedAt.value,
    failureReason: stored.failureReason.value,
    ...Option.match(
      Option.all({
        inputRows: stored.inputRows,
        acceptedRows: stored.acceptedRows,
        needsReviewRows: stored.needsReviewRows,
      }),
      {
        onNone: () => ({}),
        onSome: (rows) => ({ accounting: { ...rows, ...decisionAccounting(stored) } }),
      }
    ),
    startedAt: stored.startedAt.value,
    status: "failed",
  });
};

const decisionAccounting = (
  stored: StoredStatementSubmission
): Pick<StatementAccounting, "skippedRows" | "abandonedRows"> => ({
  ...Option.match(
    Option.liftPredicate(stored.skippedRows, (rows) => rows > 0),
    { onNone: () => ({}), onSome: (skippedRows) => ({ skippedRows }) }
  ),
  ...Option.match(
    Option.liftPredicate(stored.abandonedRows, (rows) => rows > 0),
    { onNone: () => ({}), onSome: (abandonedRows) => ({ abandonedRows }) }
  ),
});

const completedProjection = (
  base: SubmissionBase,
  stored: StoredStatementSubmission
): Option.Option<StatementSubmission> => {
  if (
    Option.isNone(stored.startedAt) ||
    Option.isNone(stored.completedAt) ||
    Option.isNone(stored.inputRows) ||
    Option.isNone(stored.acceptedRows) ||
    Option.isNone(stored.needsReviewRows)
  ) {
    return Option.none();
  }

  const settled = {
    ...base,
    accounting: {
      acceptedRows: stored.acceptedRows.value,
      inputRows: stored.inputRows.value,
      needsReviewRows: stored.needsReviewRows.value,
      ...decisionAccounting(stored),
    },
    startedAt: stored.startedAt.value,
  };

  if (stored.status === "awaiting-clarification") {
    return Option.some({ ...settled, status: "awaiting-clarification" });
  }

  return Option.some({
    ...settled,
    completedAt: stored.completedAt.value,
    status: stored.status === "abandoned" ? "abandoned" : "completed",
  });
};

export const submissionProjection = (
  stored: StoredStatementSubmission
): Option.Option<StatementSubmission> => {
  const base = submissionBase(stored);

  if (stored.status === "queued") return Option.some({ ...base, status: "queued" });

  if (stored.status === "failed") return failedProjection(base, stored);

  if (
    stored.status === "completed" ||
    stored.status === "awaiting-clarification" ||
    stored.status === "abandoned"
  ) {
    return completedProjection(base, stored);
  }

  return Option.map(stored.startedAt, (startedAt) => ({
    ...base,
    startedAt,
    status: "processing",
  }));
};

export const ownedSubmissionSelection = `SELECT s.id, s.source_format, s.parser_revision,
           CASE WHEN s.status = 'failed' THEN s.status ELSE
             CASE WHEN s.clarification_state='awaiting' AND s.needs_review_rows=(SELECT count(*) FROM ingestion_statement_review_decisions d WHERE d.submission_id=s.id) THEN 'completed' ELSE CASE s.clarification_state WHEN 'awaiting' THEN 'awaiting-clarification' WHEN 'abandoned' THEN 'abandoned' ELSE s.status END END END AS status,
           s.submitted_at_ms, s.started_at_ms, coalesce(s.clarification_ended_at_ms, s.completed_at_ms) AS completed_at_ms,
           s.failure_reason, s.input_rows,
           s.accepted_rows + (SELECT count(*) FROM ingestion_statement_review_decisions d WHERE d.submission_id = s.id AND d.decision = 'resolved') AS accepted_rows,
           s.needs_review_rows - (SELECT count(*) FROM ingestion_statement_review_decisions d WHERE d.submission_id = s.id) AS needs_review_rows,
           (SELECT count(*) FROM ingestion_statement_review_decisions d WHERE d.submission_id = s.id AND d.decision = 'skipped') AS skipped_rows,
           (SELECT count(*) FROM ingestion_statement_review_decisions d WHERE d.submission_id = s.id AND d.decision = 'abandoned') AS abandoned_rows
         FROM statement_submission_context s
         WHERE s.id = ? AND s.user_id = ?`;

export const decodeOwnedSubmission = (
  value: unknown
): Effect.Effect<Option.Option<StoredStatementSubmission>, StatementStagingUnavailable> =>
  Schema.decodeUnknownEffect(StoredSubmissionRow)(value).pipe(
    Effect.flatMap((row) => {
      const stored: StoredStatementSubmission = {
        acceptedRows: row.accepted_rows,
        skippedRows: row.skipped_rows,
        abandonedRows: row.abandoned_rows,
        completedAt: row.completed_at_ms,
        failureReason: row.failure_reason,
        id: row.id,
        inputRows: row.input_rows,
        needsReviewRows: row.needs_review_rows,
        parserRevision: row.parser_revision,
        sourceFormat: row.source_format,
        startedAt: row.started_at_ms,
        status: row.status,
        submittedAt: row.submitted_at_ms,
      };

      const projection = submissionProjection(stored);

      return Option.isNone(projection)
        ? Effect.fail(unavailable())
        : Schema.decodeEffect(Schema.toType(StatementSubmission))(projection.value).pipe(
            Effect.as(Option.some(stored)),
            Effect.mapError(unavailable)
          );
    }),
    Effect.mapError(() => unavailable())
  );
