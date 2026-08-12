import { type DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Money, encodeMoneyAmount } from "~/core/_shared/money";
import {
  CapturedFieldIssue,
  CapturedStatementContext,
  type CapturedStatementContext as CapturedStatementContextType,
  NeedsReviewItem,
  NeedsReviewReason,
  type NeedsReviewStatementRow,
  NeedsReviewStatus,
  type StatementAccounting,
  StatementColumnMapping,
  StatementFailureReason,
  StatementRowEvidence,
  type StatementSubmission,
  StatementSubmissionStatus,
} from "~/core/ingestion/model";
import {
  NeedsReviewItemId,
  StatementSourceFormat,
  StatementSubmissionId,
} from "~/core/ingestion/reference";
import { UserId } from "~/core/identity/reference";
import { TransactionId } from "~/core/transactions/model";
import { withUserTransaction } from "~/shell/db/user-transaction";

const SubmissionRow = Schema.Struct({
  id: StatementSubmissionId,
  sourceFormat: StatementSourceFormat,
  parserRevision: Schema.String,
  status: StatementSubmissionStatus,
  submittedAt: Schema.DateTimeUtcFromDate,
  startedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  completedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  inputRows: Schema.OptionFromNullOr(Schema.Int),
  acceptedRows: Schema.OptionFromNullOr(Schema.Int),
  needsReviewRows: Schema.OptionFromNullOr(Schema.Int),
  failureReason: Schema.OptionFromNullOr(StatementFailureReason),
});

type SubmissionRow = typeof SubmissionRow.Type;

const submissionColumns = `id, source_format AS "sourceFormat", parser_revision AS "parserRevision",
  status, submitted_at AS "submittedAt", started_at AS "startedAt",
  completed_at AS "completedAt", input_rows AS "inputRows", accepted_rows AS "acceptedRows",
  needs_review_rows AS "needsReviewRows", failure_reason AS "failureReason"`;

const submissionFromRow = (row: SubmissionRow): StatementSubmission => {
  const base = {
    id: row.id,
    sourceFormat: row.sourceFormat,
    parserRevision: row.parserRevision,
    submittedAt: row.submittedAt,
  };
  if (row.status === "queued") return { ...base, status: "queued" };
  const startedAt = Option.getOrThrow(row.startedAt);
  if (row.status === "processing") return { ...base, status: "processing", startedAt };
  if (row.status === "failed") {
    return {
      ...base,
      status: "failed",
      startedAt,
      completedAt: Option.getOrThrow(row.completedAt),
      failureReason: Option.getOrThrow(row.failureReason),
    };
  }
  return {
    ...base,
    status: "completed",
    startedAt,
    completedAt: Option.getOrThrow(row.completedAt),
    accounting: {
      inputRows: Option.getOrThrow(row.inputRows),
      acceptedRows: Option.getOrThrow(row.acceptedRows),
      needsReviewRows: Option.getOrThrow(row.needsReviewRows),
    },
  };
};

const ExistingSubmissionRow = Schema.Struct({
  ...SubmissionRow.fields,
  contentHash: Schema.String,
});

/** Finds a prior idempotent submission while already inside the User transaction. */
export const findSubmissionByIdempotencyKeyInScope = Effect.fn(
  "findSubmissionByIdempotencyKeyInScope"
)(function* (userId: UserId, idempotencyKey: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, idempotencyKey: Schema.String }),
    Result: ExistingSubmissionRow,
    execute: (request) => sql`
      SELECT ${sql.literal(submissionColumns)}, content_hash AS "contentHash"
      FROM statement_submissions
      WHERE user_id = ${request.userId} AND idempotency_key = ${request.idempotencyKey}
    `,
  })({ userId, idempotencyKey }).pipe(
    Effect.map(
      Option.map((row) => ({ submission: submissionFromRow(row), contentHash: row.contentHash }))
    ),
    Effect.orDie
  );
});

/** Reads stable-User queue and hourly admission pressure under the admission lock. */
export const statementAdmissionPressureInScope = Effect.fn("statementAdmissionPressureInScope")(
  function* (userId: UserId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOne({
      Request: UserId,
      Result: Schema.Struct({ outstanding: Schema.Int, admittedThisHour: Schema.Int }),
      execute: (id) => sql`
      SELECT
        count(*) FILTER (WHERE status IN ('queued', 'processing'))::int AS outstanding,
        count(*) FILTER (WHERE submitted_at >= now() - interval '1 hour')::int AS "admittedThisHour"
      FROM statement_submissions
      WHERE user_id = ${id}
    `,
    })(userId).pipe(Effect.orDie);
  }
);

/** Serializes admission decisions for one User and reports whether the Free grant was consumed. */
export const lockStatementBackfillInScope = Effect.fn("lockStatementBackfillInScope")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO statement_backfill_entitlements (user_id) VALUES (${userId})
    ON CONFLICT (user_id) DO NOTHING
  `.pipe(Effect.orDie);
  return yield* SqlSchema.findOne({
    Request: UserId,
    Result: Schema.Struct({ unavailable: Schema.Boolean }),
    execute: (id) => sql`
      SELECT (consumed_at IS NOT NULL OR submission_id IS NOT NULL) AS unavailable
      FROM statement_backfill_entitlements WHERE user_id = ${id} FOR UPDATE
    `,
  })(userId).pipe(
    Effect.map((row) => row.unavailable),
    Effect.orDie
  );
});

export type InsertSubmissionInput = Readonly<{
  id: StatementSubmissionId;
  userId: UserId;
  idempotencyKey: string;
  contentHash: string;
  sourceFormat: StatementSourceFormat;
  fileContent: Uint8Array;
  context: CapturedStatementContextType;
  parserRevision: string;
  submittedAt: DateTime.Utc;
}>;

/** Inserts one durable queued submission inside authorization's User transaction. */
export const insertSubmissionInScope = Effect.fn("insertSubmissionInScope")(function* (
  input: InsertSubmissionInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Struct({
      id: StatementSubmissionId,
      userId: UserId,
      idempotencyKey: Schema.String,
      contentHash: Schema.String,
      sourceFormat: StatementSourceFormat,
      fileContent: Schema.Uint8Array,
      ...CapturedStatementContext.fields,
      parserRevision: Schema.String,
      submittedAt: Schema.DateTimeUtc,
    }),
    Result: SubmissionRow,
    execute: (row) => sql`
      INSERT INTO statement_submissions (
        id, user_id, idempotency_key, content_hash, source_format, file_content, status,
        service_market, locale, time_zone, parser_revision, submitted_at
      ) VALUES (
        ${row.id}, ${row.userId}, ${row.idempotencyKey}, ${row.contentHash},
        ${row.sourceFormat}, ${row.fileContent}, 'queued', ${row.serviceMarket}, ${row.locale},
        ${row.timeZone}, ${row.parserRevision}, ${row.submittedAt}
      )
      RETURNING ${sql.literal(submissionColumns)}
    `,
  })({ ...input, ...input.context }).pipe(Effect.map(submissionFromRow), Effect.orDie);
});

/** Reserves the one-time Free grant until this submission reaches a useful finalization. */
export const reserveStatementBackfillInScope = Effect.fn("reserveStatementBackfillInScope")(
  function* (userId: UserId, submissionId: StatementSubmissionId) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE statement_backfill_entitlements SET submission_id = ${submissionId}
      WHERE user_id = ${userId} AND consumed_at IS NULL AND submission_id IS NULL
    `.pipe(Effect.orDie);
  }
);

/** Reads one owned submission through the public query seam. */
export const findSubmission = Effect.fn("findSubmission")(function* (
  userId: UserId,
  id: StatementSubmissionId
) {
  return yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findOneOption({
        Request: Schema.Struct({ userId: UserId, id: StatementSubmissionId }),
        Result: SubmissionRow,
        execute: (request) => sql`
          SELECT ${sql.literal(submissionColumns)} FROM statement_submissions
          WHERE id = ${request.id} AND user_id = ${request.userId}
        `,
      })({ userId, id })
    ).pipe(Effect.map(Option.map(submissionFromRow)), Effect.orDie)
  );
});

const StatementClaimId = Schema.NonEmptyString;

export const ClaimedStatement = Schema.Struct({
  id: StatementSubmissionId,
  userId: UserId,
  claimId: StatementClaimId,
  contentHash: Schema.String,
  sourceFormat: StatementSourceFormat,
  fileContent: Schema.Uint8Array,
  ...CapturedStatementContext.fields,
  parserRevision: Schema.String,
  attemptCount: Schema.Int,
});
export type ClaimedStatement = typeof ClaimedStatement.Type;

/** Claims one queued submission through the narrow RLS-bypassing gateway function. */
export const claimStatementSubmission = Effect.fn("claimStatementSubmission")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: ClaimedStatement,
    execute: () => sql`
      SELECT id, user_id AS "userId", claim_id AS "claimId", content_hash AS "contentHash",
        source_format AS "sourceFormat", file_content AS "fileContent",
        service_market AS "serviceMarket", locale, time_zone AS "timeZone",
        parser_revision AS "parserRevision", attempt_count AS "attemptCount"
      FROM fidy_claim_statement_submission()
    `,
  })(undefined).pipe(Effect.orDie);
});

/** Locks a claim before finalization so a stale worker cannot duplicate row outcomes. */
export const ownsStatementClaimInScope = Effect.fn("ownsStatementClaimInScope")(function* (
  userId: UserId,
  id: StatementSubmissionId,
  claimId: string
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      userId: UserId,
      id: StatementSubmissionId,
      claimId: StatementClaimId,
    }),
    Result: Schema.Struct({ id: StatementSubmissionId }),
    execute: (input) => sql`
      SELECT id FROM statement_submissions
      WHERE id = ${input.id} AND user_id = ${input.userId} AND claim_id = ${input.claimId}
        AND status = 'processing'
      FOR UPDATE
    `,
  })({ userId, id, claimId }).pipe(Effect.map(Option.isSome), Effect.orDie);
});

/** Loads one versioned mapping profile within the claimed User context. */
export const findStatementMappingInScope = Effect.fn("findStatementMappingInScope")(function* (
  userId: UserId,
  fingerprint: string
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, fingerprint: Schema.String }),
    Result: Schema.Struct({ mapping: Schema.Unknown }),
    execute: (request) => sql`
      SELECT mapping FROM statement_format_profiles
      WHERE user_id = ${request.userId} AND fingerprint = ${request.fingerprint}
    `,
  })({ userId, fingerprint }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none()),
        onSome: ({ mapping }) =>
          Schema.decodeUnknownEffect(StatementColumnMapping)(mapping).pipe(
            Effect.map(Option.some),
            Effect.orDie
          ),
      })
    ),
    Effect.orDie
  );
});

/** Retains a successful mapping with the row outcomes that first used it. */
export const insertStatementMappingInScope = Effect.fn("insertStatementMappingInScope")(function* (
  input: Readonly<{
    userId: UserId;
    fingerprint: string;
    mapping: StatementColumnMapping;
    extractorRevision: string;
  }>
) {
  const { userId, fingerprint, mapping, extractorRevision } = input;
  const sql = yield* SqlClient.SqlClient;
  const encoded = yield* Schema.encodeUnknownEffect(StatementColumnMapping)(mapping).pipe(
    Effect.orDie
  );
  yield* sql`
    INSERT INTO statement_format_profiles (user_id, fingerprint, mapping, extractor_revision)
    VALUES (${userId}, ${fingerprint}, ${encoded}, ${extractorRevision})
    ON CONFLICT (user_id, fingerprint) DO NOTHING
  `.pipe(Effect.orDie);
});

const reviewEvidence = (evidence: StatementRowEvidence): Effect.Effect<unknown> =>
  Schema.encodeUnknownEffect(StatementRowEvidence)(evidence).pipe(Effect.orDie);
const CapturedFieldIssuesJson = Schema.fromJsonString(Schema.Array(CapturedFieldIssue));

/** Inserts one rejected row while finalizing its submission. */
export const insertNeedsReviewItemInScope = Effect.fn("insertNeedsReviewItemInScope")(function* (
  input: Readonly<{
    id: NeedsReviewItemId;
    userId: UserId;
    submissionId: StatementSubmissionId;
    outcome: NeedsReviewStatementRow;
    context: CapturedStatementContextType;
    sourceFormat: StatementSourceFormat;
    parserRevision: string;
    extractorRevision: string;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  const evidence = yield* reviewEvidence(input.outcome.evidence);
  const known = Option.map(input.outcome.knownMoney, (money) => ({
    amount: encodeMoneyAmount(money.amount),
    currency: money.currency,
  }));
  const knownAmount = Option.getOrNull(Option.map(known, (money) => money.amount));
  const knownCurrency = Option.getOrNull(Option.map(known, (money) => money.currency));
  const issues = yield* Schema.encodeEffect(CapturedFieldIssuesJson)(input.outcome.issues).pipe(
    Effect.orDie
  );
  yield* sql`
    INSERT INTO needs_review_items (
      id, user_id, submission_id, record_number, reason, known_amount, known_currency,
      service_market, locale, time_zone, source_format, source_channel, parser_revision,
      extractor_revision, original_evidence, issues, status
    ) VALUES (
      ${input.id}, ${input.userId}, ${input.submissionId}, ${input.outcome.recordNumber},
      ${input.outcome.reason}, ${knownAmount}, ${knownCurrency}, ${input.context.serviceMarket},
      ${input.context.locale}, ${input.context.timeZone}, ${input.sourceFormat},
      'statement-upload', ${input.parserRevision}, ${input.extractorRevision}, ${evidence},
      ${issues}, 'pending'
    )
  `.pipe(Effect.orDie);
});

/** Completes one submission and deletes its uploaded bytes in the same transaction as outcomes. */
export const completeSubmissionInScope = Effect.fn("completeSubmissionInScope")(function* (
  input: Readonly<{
    userId: UserId;
    id: StatementSubmissionId;
    claimId: string;
    accounting: StatementAccounting;
    completedAt: DateTime.Utc;
  }>
) {
  const { userId, id, accounting, completedAt } = input;
  const usefulOutcome = accounting.inputRows > 0;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH completed AS (
      UPDATE statement_submissions SET status = 'completed', file_content = NULL, claim_id = NULL,
        input_rows = ${accounting.inputRows}, accepted_rows = ${accounting.acceptedRows},
        needs_review_rows = ${accounting.needsReviewRows}, completed_at = ${completedAt}
      WHERE id = ${id} AND user_id = ${userId} AND claim_id = ${input.claimId}
        AND status = 'processing'
      RETURNING id
    )
    UPDATE statement_backfill_entitlements SET
      consumed_at = CASE WHEN ${usefulOutcome} THEN ${completedAt} ELSE consumed_at END,
      submission_id = CASE WHEN ${usefulOutcome} THEN submission_id ELSE NULL END
    WHERE user_id = ${userId} AND submission_id = ${id} AND consumed_at IS NULL
      AND EXISTS (SELECT 1 FROM completed)
  `.pipe(Effect.orDie);
});

/** Releases a claimed submission after a transient adapter failure. */
export const requeueSubmission = Effect.fn("requeueSubmission")(function* (
  userId: UserId,
  id: StatementSubmissionId,
  claimId: string
) {
  yield* withUserTransaction(
    userId,
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`
        UPDATE statement_submissions SET
          status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'queued' END,
          started_at = CASE WHEN attempt_count >= 3 THEN started_at ELSE NULL END,
          completed_at = CASE WHEN attempt_count >= 3 THEN now() ELSE NULL END,
          failure_reason = CASE WHEN attempt_count >= 3 THEN 'mapping-unavailable' ELSE NULL END,
          file_content = CASE WHEN attempt_count >= 3 THEN NULL ELSE file_content END,
          claim_id = NULL
        WHERE id = ${id} AND user_id = ${userId} AND claim_id = ${claimId}
          AND status = 'processing'
      `
    ).pipe(Effect.orDie)
  );
});

/** Records a safe terminal failure and erases the uploaded bytes. */
export const failSubmission = Effect.fn("failSubmission")(function* (
  input: Readonly<{
    userId: UserId;
    id: StatementSubmissionId;
    failureReason:
      | "unsupported-format"
      | "resource-limit"
      | "malformed-file"
      | "mapping-unavailable";
    claimId: string;
    completedAt: DateTime.Utc;
  }>
) {
  yield* withUserTransaction(
    input.userId,
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`
        WITH failed AS (
          UPDATE statement_submissions SET status = 'failed', file_content = NULL, claim_id = NULL,
            failure_reason = ${input.failureReason}, completed_at = ${input.completedAt}
          WHERE id = ${input.id} AND user_id = ${input.userId} AND claim_id = ${input.claimId}
            AND status = 'processing'
          RETURNING id
        )
        UPDATE statement_backfill_entitlements SET submission_id = NULL
        WHERE user_id = ${input.userId} AND submission_id = ${input.id}
          AND consumed_at IS NULL
          AND EXISTS (SELECT 1 FROM failed)
      `
    ).pipe(Effect.orDie)
  );
});

const ReviewRow = Schema.Struct({
  id: NeedsReviewItemId,
  submissionId: StatementSubmissionId,
  recordNumber: Schema.Int,
  reason: NeedsReviewReason,
  knownAmount: Schema.OptionFromNullOr(Money.fields.amount),
  knownCurrency: Schema.OptionFromNullOr(Money.fields.currency),
  ...CapturedStatementContext.fields,
  sourceFormat: StatementSourceFormat,
  sourceProvider: Schema.OptionFromNullOr(Schema.String),
  parserRevision: Schema.String,
  extractorRevision: Schema.String,
  originalEvidence: Schema.OptionFromNullOr(Schema.Unknown),
  issues: Schema.Unknown,
  status: NeedsReviewStatus,
  transactionId: Schema.OptionFromNullOr(TransactionId),
  createdAt: Schema.DateTimeUtcFromDate,
  resolvedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
});

const reviewColumns = (qualifier: "" | "review."): string =>
  [
    `${qualifier}id`,
    `${qualifier}submission_id AS "submissionId"`,
    `${qualifier}record_number AS "recordNumber"`,
    `${qualifier}reason`,
    `${qualifier}known_amount AS "knownAmount"`,
    `${qualifier}known_currency AS "knownCurrency"`,
    `${qualifier}service_market AS "serviceMarket"`,
    `${qualifier}locale`,
    `${qualifier}time_zone AS "timeZone"`,
    `${qualifier}source_format AS "sourceFormat"`,
    `${qualifier}source_provider AS "sourceProvider"`,
    `${qualifier}parser_revision AS "parserRevision"`,
    `${qualifier}extractor_revision AS "extractorRevision"`,
    `${qualifier}original_evidence AS "originalEvidence"`,
    `${qualifier}issues`,
    `${qualifier}status`,
    `${qualifier}transaction_id AS "transactionId"`,
    `${qualifier}created_at AS "createdAt"`,
    `${qualifier}resolved_at AS "resolvedAt"`,
  ].join(", ");

const reviewFromRow = Effect.fn("reviewFromRow")(function* (row: typeof ReviewRow.Type) {
  const knownMoney =
    Option.isSome(row.knownAmount) && Option.isSome(row.knownCurrency)
      ? Option.some(
          Money.make({ amount: row.knownAmount.value, currency: row.knownCurrency.value })
        )
      : Option.none<Money>();
  const issues = yield* Schema.decodeUnknownEffect(Schema.Array(CapturedFieldIssue))(row.issues);
  const base = {
    id: row.id,
    submissionId: row.submissionId,
    recordNumber: row.recordNumber,
    reason: row.reason,
    knownMoney,
    serviceMarket: row.serviceMarket,
    locale: row.locale,
    timeZone: row.timeZone,
    sourceFormat: row.sourceFormat,
    sourceChannel: "statement-upload" as const,
    sourceProvider: row.sourceProvider,
    parserRevision: row.parserRevision,
    extractorRevision: row.extractorRevision,
    issues,
    createdAt: row.createdAt,
  };
  if (row.status === "pending") {
    const evidence = yield* Schema.decodeUnknownEffect(StatementRowEvidence)(
      Option.getOrThrow(row.originalEvidence)
    );
    return NeedsReviewItem.make({ ...base, status: "pending", originalEvidence: evidence });
  }
  if (row.status === "expired") return NeedsReviewItem.make({ ...base, status: "expired" });
  return NeedsReviewItem.make({
    ...base,
    status: "resolved",
    transactionId: Option.getOrThrow(row.transactionId),
    resolvedAt: Option.getOrThrow(row.resolvedAt),
  });
});

/** Lists one bounded page of visible review items, pending first. */
export const listNeedsReviewItems = Effect.fn("listNeedsReviewItems")(function* (
  userId: UserId,
  page: { readonly offset: number; readonly limit: number }
) {
  return yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findAll({
        Request: Schema.Struct({ userId: UserId, offset: Schema.Int, limit: Schema.Int }),
        Result: ReviewRow,
        execute: (request) => sql`
          SELECT ${sql.literal(reviewColumns(""))} FROM needs_review_items
          WHERE user_id = ${request.userId}
          ORDER BY (status = 'pending') DESC, created_at, id
          OFFSET ${request.offset} LIMIT ${request.limit}
        `,
      })({ userId, ...page })
    ).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, reviewFromRow)),
      Effect.orDie
    )
  );
});

/** Locks one pending item and includes immutable submission provenance for resolution. */
export const findPendingReviewItemInScope = Effect.fn("findPendingReviewItemInScope")(function* (
  userId: UserId,
  id: NeedsReviewItemId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, id: NeedsReviewItemId }),
    Result: Schema.Struct({ ...ReviewRow.fields, contentHash: Schema.String }),
    execute: (request) => sql`
      SELECT ${sql.literal(reviewColumns("review."))}, submission.content_hash AS "contentHash"
      FROM needs_review_items review
      JOIN statement_submissions submission ON submission.id = review.submission_id
      WHERE review.id = ${request.id} AND review.user_id = ${request.userId}
        AND review.status = 'pending'
      FOR UPDATE OF review
    `,
  })({ userId, id }).pipe(Effect.orDie);
});

/** Resolves one item and erases original evidence after its Transaction provenance exists. */
export const resolveNeedsReviewItemInScope = Effect.fn("resolveNeedsReviewItemInScope")(function* (
  input: Readonly<{
    userId: UserId;
    id: NeedsReviewItemId;
    transactionId: TransactionId;
    resolvedAt: DateTime.Utc;
  }>
) {
  const { userId, id, transactionId, resolvedAt } = input;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE needs_review_items SET status = 'resolved', transaction_id = ${transactionId},
      resolved_at = ${resolvedAt}, original_evidence = NULL
    WHERE id = ${id} AND user_id = ${userId} AND status = 'pending'
  `.pipe(Effect.orDie);
});
