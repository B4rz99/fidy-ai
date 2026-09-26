import {
  type ParsedStatement,
  StatementParseFailed,
  parseStatementFile,
  statementParserLimits,
} from "@fidy/server/statement-parser";
import {
  StatementFailureReason,
  StatementStagingId,
  maximumStatementBytes,
} from "@fidy/server/statement-staging";
import {
  type CategoryId,
  type KeywordRule,
  fallbackCaptureCategory,
  findKeywordCategory,
  keywordRulesFromRows,
  keywordRulesQuery,
} from "@fidy/server/categories";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  type InterpretedStatementRow,
  ParsedStatementRow,
  StatementRowEvidence,
} from "../../src/core/ingestion/model";
import {
  interpretStatementRows,
  mechanicalMappingFor,
  unmappedStatementRow,
} from "../../src/core/ingestion/rules";
import { TransactionExtraction, encodeMoneyAmount } from "../../src/core/transactions/model";
import { currentMillis } from "../pats/pat-shared";
import { StatementStaging, newIngestionId } from "./statement-staging";
import { maximumRetainedReviewEvidence } from "./statement-review-retention";
import { statementChunkSize } from "./statement-processing-limits";

const submissionRow = Schema.Struct({
  staging_id: StatementStagingId,
  source_format: Schema.Literals(["csv", "xlsx"]),
  parser_revision: Schema.NonEmptyString,
  service_market: Schema.Literal("CO"),
  locale: Schema.Literal("es-CO"),
  time_zone: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  retention_expires_at_ms: Schema.Int,
  status: Schema.Literals(["queued", "processing", "completed", "failed"]),
});
type SubmissionRow = typeof submissionRow.Type;
const countRow = Schema.Struct({ total: Schema.Int, accepted: Schema.Int, review: Schema.Int });
const outcomeRow = Schema.Struct({ outcome: Schema.Literals(["accepted", "needs-review"]) });
const evidenceCodec = Schema.toCodecJson(StatementRowEvidence);
const extractorRevision = "statement-mechanical-v1";

const newId = newIngestionId;
const nowMs = currentMillis;
const iso = (): string => DateTime.formatIso(DateTime.makeUnsafe(nowMs()));

// @effect-diagnostics-next-line asyncFunction:off
const findOwned = async (
  db: D1Database,
  userId: string,
  submissionId: string
): Promise<Option.Option<SubmissionRow>> => {
  const raw = await db
    .prepare(`SELECT s.staging_id, s.source_format, s.parser_revision,
    s.service_market, s.locale, s.time_zone, o.sha256, s.retention_expires_at_ms, s.status
    FROM statement_submissions s JOIN statement_staging_objects o
      ON o.id = s.staging_id AND o.user_id = s.user_id AND o.published_submission_id = s.id
    WHERE s.id = ? AND s.user_id = ?`)
    .bind(submissionId, userId)
    .first();
  if (raw === null) return Option.none();
  return Option.some(Schema.decodeUnknownSync(submissionRow)(raw));
};

// @effect-diagnostics-next-line asyncFunction:off
const markFailed = async ({
  db,
  userId,
  submissionId,
  reason,
}: Readonly<{
  db: D1Database;
  userId: string;
  submissionId: string;
  reason: typeof StatementFailureReason.Type;
}>): Promise<void> => {
  // Failed submissions retain conserved counts for every row committed before interruption.
  await db.batch([
    db
      .prepare(`UPDATE statement_submissions SET status = 'failed',
      started_at_ms = coalesce(started_at_ms, ?), completed_at_ms = ?, failure_reason = ?,
      input_rows = (SELECT nullif(count(*), 0) FROM statement_record_outcomes
        WHERE submission_id = ? AND user_id = ?),
      accepted_rows = CASE WHEN EXISTS (SELECT 1 FROM statement_record_outcomes
        WHERE submission_id = ? AND user_id = ?) THEN
        (SELECT count(*) FROM statement_record_outcomes WHERE submission_id = ? AND user_id = ?
          AND outcome = 'accepted') ELSE NULL END,
      needs_review_rows = CASE WHEN EXISTS (SELECT 1 FROM statement_record_outcomes
        WHERE submission_id = ? AND user_id = ?) THEN
        (SELECT count(*) FROM statement_record_outcomes WHERE submission_id = ? AND user_id = ?
          AND outcome = 'needs-review') ELSE NULL END
      WHERE id = ? AND user_id = ? AND status IN ('queued', 'processing')`)
      .bind(
        nowMs(),
        nowMs(),
        reason,
        submissionId,
        userId,
        submissionId,
        userId,
        submissionId,
        userId,
        submissionId,
        userId,
        submissionId,
        userId,
        submissionId,
        userId
      ),
    db
      .prepare(`UPDATE statement_backfill_entitlements
      SET consumed_at_ms = CASE WHEN EXISTS (
        SELECT 1 FROM statement_record_outcomes WHERE submission_id = ? AND user_id = ?)
        THEN coalesce(consumed_at_ms, ?) ELSE consumed_at_ms END,
        submission_id = CASE WHEN EXISTS (
        SELECT 1 FROM statement_record_outcomes WHERE submission_id = ? AND user_id = ?)
        THEN submission_id ELSE NULL END
      WHERE user_id = ? AND submission_id = ? AND changes() = 1`)
      .bind(submissionId, userId, nowMs(), submissionId, userId, userId, submissionId),
  ]);
};

/**
 * Settles exhausted statement work under the User coordinator, atomically releasing a pending
 * Free entitlement. Repeated or late failure cannot regress a completed submission. Only a
 * closed public reason is stored; the Workflow's raw exception must never be passed here.
 */
export const failStatementSubmission = ({
  DB,
  userId,
  submissionId,
  reason,
}: Readonly<{
  DB: D1Database;
  userId: string;
  submissionId: string;
  reason: typeof StatementFailureReason.Type;
}>): Promise<void> =>
  markFailed({
    db: DB,
    userId,
    submissionId,
    reason: Schema.decodeSync(StatementFailureReason)(reason),
  });

type RowWork = Readonly<{
  db: D1Database;
  userId: string;
  submissionId: string;
  row: ParsedStatementRow;
  result: InterpretedStatementRow<TransactionExtraction>;
  context: SubmissionRow;
  rules: ReadonlyArray<KeywordRule>;
}>;
const active = `EXISTS (SELECT 1 FROM statement_submissions WHERE id = ? AND user_id = ?
    AND status = 'processing' AND retention_expires_at_ms > ?)`;

const acceptedStatements = (
  {
    db,
    userId,
    submissionId,
    row,
    result,
    context,
    categoryId,
  }: RowWork &
    Readonly<{
      result: Extract<RowWork["result"], { outcome: "accepted" }>;
      categoryId: CategoryId;
    }>,
  id: string,
  activeArgs: ReadonlyArray<string | number>
): ReadonlyArray<D1PreparedStatement> => {
  const extraction = result.extraction;
  const when = iso();
  return [
    db
      .prepare(`INSERT INTO transactions (id, user_id, amount, currency,
      direction, counterparty, category_id, notes, occurred_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ? WHERE ${active}`)
      .bind(
        id,
        userId,
        encodeMoneyAmount(extraction.money.amount),
        extraction.money.currency,
        extraction.direction,
        Option.getOrNull(extraction.counterparty),
        categoryId,
        DateTime.formatIso(extraction.occurredAt),
        when,
        ...activeArgs
      ),
    db
      .prepare(`INSERT INTO source_attestations (id, user_id, transaction_id,
      kind, service_market, locale, time_zone, interpretation_revision, created_at,
      statement_submission_id, statement_record_number, statement_content_hash, source_format)
      SELECT ?, ?, ?, 'statement-line', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${active}`)
      .bind(
        newId(),
        userId,
        id,
        context.service_market,
        context.locale,
        context.time_zone,
        context.parser_revision,
        when,
        submissionId,
        row.recordNumber,
        context.sha256,
        context.source_format,
        ...activeArgs
      ),
  ];
};

const reviewStatement = (
  {
    db,
    userId,
    submissionId,
    row,
    result,
    context,
  }: RowWork & Readonly<{ result: Extract<RowWork["result"], { outcome: "needs-review" }> }>,
  id: string,
  activeArgs: ReadonlyArray<string | number>
): D1PreparedStatement => {
  const evidence = Schema.encodeUnknownSync(evidenceCodec)(result.evidence);
  return db
    .prepare(`INSERT INTO statement_needs_review
      (id, user_id, submission_id, record_number, reason, original_evidence, known_money,
       issues, status, evidence_expires_at_ms, created_at_ms, service_market, locale,
       time_zone, source_format, parser_revision, extractor_revision)
      SELECT ?, ?, ?, ?, ?,
        CASE WHEN (SELECT count(*) FROM statement_needs_review WHERE status = 'pending') < ?
          AND ? > ? THEN ? ELSE NULL END,
        NULL, ?,
        CASE WHEN (SELECT count(*) FROM statement_needs_review WHERE status = 'pending') < ?
          AND ? > ? THEN 'pending' ELSE 'expired' END,
        ?, ?, ?, ?, ?, ?, ?, ? WHERE ${active}`)
    .bind(
      id,
      userId,
      submissionId,
      row.recordNumber,
      result.reason,
      maximumRetainedReviewEvidence,
      context.retention_expires_at_ms,
      nowMs(),
      JSON.stringify(evidence),
      JSON.stringify(result.issues),
      maximumRetainedReviewEvidence,
      context.retention_expires_at_ms,
      nowMs(),
      context.retention_expires_at_ms,
      nowMs(),
      context.service_market,
      context.locale,
      context.time_zone,
      context.source_format,
      context.parser_revision,
      extractorRevision,
      ...activeArgs
    );
};

// @effect-diagnostics-next-line asyncFunction:off
const rowOutcome = async (work: RowWork): Promise<void> => {
  const { db, userId, submissionId, row, result } = work;
  const existing = await db
    .prepare(`SELECT outcome FROM statement_record_outcomes
    WHERE submission_id = ? AND user_id = ? AND record_number = ?`)
    .bind(submissionId, userId, row.recordNumber)
    .first();
  if (existing !== null) {
    if (Option.isNone(Schema.decodeUnknownOption(outcomeRow)(existing))) {
      throw new Error("Statement outcome unavailable");
    }
    return;
  }
  const id = newId();
  const activeArgs = [submissionId, userId, nowMs()];
  const statements =
    result.outcome === "accepted"
      ? acceptedStatements(
          {
            ...work,
            result,
            categoryId: Option.isSome(result.extraction.counterparty)
              ? Option.getOrElse(
                  await Effect.runPromise(
                    findKeywordCategory({
                      counterparty: result.extraction.counterparty.value,
                      rules: work.rules,
                    })
                  ),
                  () => fallbackCaptureCategory(result.extraction.direction)
                )
              : fallbackCaptureCategory(result.extraction.direction),
          },
          id,
          activeArgs
        )
      : [reviewStatement({ ...work, result }, id, activeArgs)];
  // The unique record identity, its evidence and its Transaction or review commit together.
  await db.batch([
    ...statements,
    db
      .prepare(`INSERT INTO statement_record_outcomes
      (user_id, submission_id, record_number, outcome, transaction_id)
      SELECT ?, ?, ?, ?, ? WHERE ${active}`)
      .bind(
        userId,
        submissionId,
        row.recordNumber,
        result.outcome,
        result.outcome === "accepted" ? id : null,
        ...activeArgs
      ),
    db.prepare(`INSERT INTO statement_submission_assertion (id, accepted)
      VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
      ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`),
  ]);
};

/**
 * Finalizes an owned submission under its stable User's Durable Object turn. The caller MUST
 * serialize all processing and retention work for this User; an opaque submission id is never
 * authority. D1 atomically commits each row with its evidence, so retry resumes from the unique
 * (submission, record) outcome. Each call commits at most 32 rows, returning `continue` for
 * another named Workflow activity or `completed` for terminal state. Every reread stays below
 * the parser's 5 MiB input ceiling and the Workflow's admitted row/step ceiling. Infrastructure
 * failures reject for durable redelivery; unsafe material becomes terminal or visible review.
 */
type ProcessInput = Readonly<{
  DB: D1Database;
  STATEMENT_STAGING_BUCKET: R2Bucket;
  userId: string;
  submissionId: string;
}>;
type Progress = typeof countRow.Type;

// @effect-diagnostics-next-line asyncFunction:off
const readParsed = async (
  input: ProcessInput,
  context: SubmissionRow
): Promise<Option.Option<ParsedStatement>> => {
  const { DB, STATEMENT_STAGING_BUCKET, userId, submissionId } = input;
  const staging = StatementStaging.make({
    database: DB,
    bucket: STATEMENT_STAGING_BUCKET,
    nowEpochMs: nowMs,
  });
  const bytes = await Effect.runPromise(
    Effect.result(
      staging.readOwnedStagedBytes({
        userId,
        stagingId: context.staging_id,
      })
    )
  );
  if (bytes._tag === "Failure") {
    if (bytes.failure._tag === "StatementStagingUnavailable") {
      throw new Error("Statement storage unavailable");
    }
    await markFailed({
      db: DB,
      userId,
      submissionId,
      reason: bytes.failure.reason === "retention-expired" ? "retention-expired" : "malformed-file",
    });
    return Option.none();
  }
  if (bytes.success.length > maximumStatementBytes) {
    await markFailed({ db: DB, userId, submissionId, reason: "resource-limit" });
    return Option.none();
  }
  const parsed = await Effect.runPromise(Effect.result(parseStatementFile(bytes.success)));
  if (parsed._tag === "Failure") {
    await markFailed({
      db: DB,
      userId,
      submissionId,
      reason:
        parsed.failure instanceof StatementParseFailed
          ? parsed.failure.safeReason
          : "malformed-file",
    });
    return Option.none();
  }
  return validateParsed(input, context, parsed.success);
};

// @effect-diagnostics-next-line asyncFunction:off
const validateParsed = async (
  input: ProcessInput,
  context: SubmissionRow,
  parsed: ParsedStatement
): Promise<Option.Option<ParsedStatement>> => {
  if (parsed.sourceFormat !== context.source_format) {
    await markFailed({
      db: input.DB,
      userId: input.userId,
      submissionId: input.submissionId,
      reason: "malformed-file",
    });
    return Option.none();
  }
  // A header-only or other zero-row document has no Transaction or review outcome to conserve.
  // It is not a successfully finalized statement, even if its bytes passed the staging gate.
  if (parsed.rows.length === 0) {
    await markFailed({
      db: input.DB,
      userId: input.userId,
      submissionId: input.submissionId,
      reason: "malformed-file",
    });
    return Option.none();
  }
  if (parsed.rows.length > statementParserLimits.maximumRows) {
    await markFailed({
      db: input.DB,
      userId: input.userId,
      submissionId: input.submissionId,
      reason: "resource-limit",
    });
    return Option.none();
  }
  return Option.some(parsed);
};

// @effect-diagnostics-next-line asyncFunction:off
const readProgress = async (input: ProcessInput): Promise<Progress> => {
  const raw = await input.DB.prepare(`SELECT count(*) AS total,
    coalesce(sum(outcome = 'accepted'), 0) AS accepted,
    coalesce(sum(outcome = 'needs-review'), 0) AS review
    FROM statement_record_outcomes WHERE submission_id = ? AND user_id = ?`)
    .bind(input.submissionId, input.userId)
    .first();
  return Schema.decodeUnknownSync(countRow)(raw);
};

// @effect-diagnostics-next-line asyncFunction:off
const ownedStatementRules = async (
  db: D1Database,
  userId: string
): Promise<ReadonlyArray<KeywordRule>> => {
  const query = keywordRulesQuery({ userId });
  const rows = await db
    .prepare(query.sql)
    .bind(...query.params)
    .all();
  const decoded = keywordRulesFromRows(rows.results);
  if (Option.isNone(decoded)) throw new Error("Statement keyword rules unavailable");
  return decoded.value;
};

// @effect-diagnostics-next-line asyncFunction:off
const finalizeChunk = async ({
  input,
  context,
  parsed,
  rows,
  progress,
}: Readonly<{
  input: ProcessInput;
  context: SubmissionRow;
  parsed: ParsedStatement;
  rows: ReadonlyArray<ParsedStatementRow>;
  progress: Progress;
}>): Promise<void> => {
  const chunk = rows.slice(progress.total, progress.total + statementChunkSize);
  const mapping = mechanicalMappingFor(parsed.headers);
  const rules = Option.isSome(mapping) ? await ownedStatementRules(input.DB, input.userId) : [];
  const interpreted = Option.isSome(mapping)
    ? await Effect.runPromise(
        interpretStatementRows(
          { rows: chunk, mapping: mapping.value, timeZone: context.time_zone },
          Schema.decodeUnknownEffect(Schema.toCodecJson(TransactionExtraction))
        )
      )
    : undefined;
  // D1 batches must settle sequentially; a parallel batch could reorder this durable cursor.
  await chunk.reduce<Promise<void>>(
    (previous, row, index) =>
      previous.then(() =>
        rowOutcome({
          db: input.DB,
          userId: input.userId,
          submissionId: input.submissionId,
          row,
          context,
          rules,
          result: interpreted?.outcomes[index] ?? unmappedStatementRow(row),
        })
      ),
    Promise.resolve()
  );
};

// @effect-diagnostics-next-line asyncFunction:off
const completeSubmission = async (
  input: ProcessInput,
  rows: number,
  counts: Progress
): Promise<void> => {
  const { DB, userId, submissionId } = input;
  const finished = await DB.batch([
    DB.prepare(`UPDATE statement_submissions
    SET status = 'completed', completed_at_ms = ?, input_rows = ?,
      accepted_rows = ?, needs_review_rows = ?
    WHERE id = ? AND user_id = ? AND status = 'processing'
      AND (SELECT count(*) FROM statement_record_outcomes
        WHERE submission_id = ? AND user_id = ?) = ?`).bind(
      nowMs(),
      rows,
      counts.accepted,
      counts.review,
      submissionId,
      userId,
      submissionId,
      userId,
      rows
    ),
    DB.prepare(`UPDATE statement_backfill_entitlements
      SET consumed_at_ms = CASE WHEN ? > 0 THEN ? ELSE NULL END,
          submission_id = CASE WHEN ? > 0 THEN submission_id ELSE NULL END
      WHERE user_id = ? AND submission_id = ? AND changes() = 1`).bind(
      rows,
      nowMs(),
      rows,
      userId,
      submissionId
    ),
  ]);
  if (finished[0]?.meta.changes !== 1) throw new Error("Statement finalization unavailable");
};

// @effect-diagnostics-next-line asyncFunction:off
const advanceSubmission = async (
  input: ProcessInput,
  context: SubmissionRow,
  parsed: ParsedStatement
): Promise<"continue" | "completed"> => {
  const rows = Schema.decodeUnknownSync(Schema.Array(ParsedStatementRow))(parsed.rows);
  await input.DB.prepare(`UPDATE statement_submissions SET status = 'processing',
    started_at_ms = coalesce(started_at_ms, ?) WHERE id = ? AND user_id = ? AND status = 'queued'`)
    .bind(nowMs(), input.submissionId, input.userId)
    .run();
  const progress = await readProgress(input);
  if (progress.total > rows.length || progress.accepted + progress.review !== progress.total) {
    throw new Error("Statement accounting unavailable");
  }
  if (progress.total < rows.length) await finalizeChunk({ input, context, parsed, rows, progress });
  const counts = await readProgress(input);
  if (counts.total < rows.length) return "continue";
  if (counts.total !== rows.length || counts.accepted + counts.review !== rows.length) {
    throw new Error("Statement accounting unavailable");
  }
  await completeSubmission(input, rows.length, counts);
  return "completed";
};

// @effect-diagnostics-next-line asyncFunction:off
export const processStatementSubmission = async (
  input: ProcessInput
): Promise<"continue" | "completed"> => {
  const context = await findOwned(input.DB, input.userId, input.submissionId);
  if (Option.isNone(context)) return "completed";
  if (context.value.status === "completed" || context.value.status === "failed") return "completed";
  if (context.value.retention_expires_at_ms <= nowMs()) {
    await markFailed({
      db: input.DB,
      userId: input.userId,
      submissionId: input.submissionId,
      reason: "retention-expired",
    });
    return "completed";
  }
  const parsed = await readParsed(input, context.value);
  return Option.isSome(parsed)
    ? advanceSubmission(input, context.value, parsed.value)
    : "completed";
};
