import type { CaptureCategoryInput } from "../categories/contract";
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
import type { CategoryId } from "@fidy/server/categories";
import { categorizeCaptures } from "../categories/operations";
import { Data, DateTime, Effect, Option, Schema } from "effect";
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
import { TransactionExtraction } from "../../src/core/transactions/contract";
import { prepareStatementCapture } from "../transactions/operations";
import { currentMillis } from "../runtime/clock";
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
class StatementProcessingUnavailable extends Data.TaggedError("StatementProcessingUnavailable")<{
  readonly cause: unknown;
}> {}
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, StatementProcessingUnavailable> =>
  Effect.tryPromise({ try: run, catch: (cause) => new StatementProcessingUnavailable({ cause }) });
const restoreRejection = <A>(promise: Promise<A>): Promise<A> =>
  promise.catch((error: unknown) => {
    if (error instanceof StatementProcessingUnavailable) throw error.cause;
    throw error;
  });

const findOwned = (
  db: D1Database,
  userId: string,
  submissionId: string
): Effect.Effect<
  Option.Option<SubmissionRow>,
  StatementProcessingUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const raw = yield* attempt(() =>
      db
        .prepare(`SELECT s.staging_id, s.source_format, s.parser_revision,
    s.service_market, s.locale, s.time_zone, o.sha256, s.retention_expires_at_ms, s.status
    FROM statement_submissions s JOIN statement_staging_objects o
      ON o.id = s.staging_id AND o.user_id = s.user_id AND o.published_submission_id = s.id
    WHERE s.id = ? AND s.user_id = ?`)
        .bind(submissionId, userId)
        .first()
    );
    if (raw === null) return Option.none();
    return Option.some(yield* Schema.decodeUnknownEffect(submissionRow)(raw));
  });

const markFailed = ({
  db,
  userId,
  submissionId,
  reason,
}: Readonly<{
  db: D1Database;
  userId: string;
  submissionId: string;
  reason: typeof StatementFailureReason.Type;
}>): Effect.Effect<void, StatementProcessingUnavailable> =>
  attempt(() =>
    db.batch([
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
    ])
  ).pipe(Effect.asVoid);

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
  restoreRejection(
    Effect.runPromise(
      markFailed({
        db: DB,
        userId,
        submissionId,
        reason: Schema.decodeSync(StatementFailureReason)(reason),
      })
    )
  );

type RowWork = Readonly<{
  db: D1Database;
  userId: string;
  submissionId: string;
  row: ParsedStatementRow;
  result: InterpretedStatementRow<TransactionExtraction>;
  context: SubmissionRow;
  categoryId: CategoryId;
}>;
const activeSource = `SELECT user_id FROM statement_submissions WHERE id = ? AND user_id = ?
    AND status = 'processing' AND retention_expires_at_ms > ?`;
const active = `EXISTS (${activeSource})`;

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
): ReadonlyArray<D1PreparedStatement> =>
  prepareStatementCapture({
    db,
    userId,
    transactionId: id,
    extraction: result.extraction,
    categoryId,
    attestation: {
      id: newId(),
      serviceMarket: context.service_market,
      locale: context.locale,
      timeZone: context.time_zone,
      interpretationRevision: context.parser_revision,
      createdAt: iso(),
      statementSubmissionId: submissionId,
      statementRecordNumber: row.recordNumber,
      statementContentHash: context.sha256,
      sourceFormat: context.source_format,
    },
    sourceGuard: { sql: activeSource, params: activeArgs },
  });

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

const commitOutcome = ({
  work,
  id,
  activeArgs,
  statements,
}: Readonly<{
  work: RowWork;
  id: string;
  activeArgs: ReadonlyArray<string | number>;
  statements: ReadonlyArray<D1PreparedStatement>;
}>): Effect.Effect<void, StatementProcessingUnavailable> =>
  attempt(() =>
    work.db.batch([
      ...statements,
      work.db
        .prepare(`INSERT INTO statement_record_outcomes
      (user_id, submission_id, record_number, outcome, transaction_id)
      SELECT ?, ?, ?, ?, ? WHERE ${active}`)
        .bind(
          work.userId,
          work.submissionId,
          work.row.recordNumber,
          work.result.outcome,
          work.result.outcome === "accepted" ? id : null,
          ...activeArgs
        ),
      work.db.prepare(`INSERT INTO statement_submission_assertion (id, accepted)
      VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
      ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`),
    ])
  ).pipe(Effect.asVoid);

const rowOutcome = (work: RowWork): Effect.Effect<void, StatementProcessingUnavailable> =>
  Effect.gen(function* () {
    const { db, userId, submissionId, row, result } = work;
    const existing = yield* attempt(() =>
      db
        .prepare(`SELECT outcome FROM statement_record_outcomes
    WHERE submission_id = ? AND user_id = ? AND record_number = ?`)
        .bind(submissionId, userId, row.recordNumber)
        .first()
    );
    if (existing !== null) {
      if (Option.isNone(Schema.decodeUnknownOption(outcomeRow)(existing))) {
        return yield* new StatementProcessingUnavailable({
          cause: new Error("Statement outcome unavailable"),
        });
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
              categoryId: work.categoryId,
            },
            id,
            activeArgs
          )
        : [reviewStatement({ ...work, result }, id, activeArgs)];
    // The unique record identity, its evidence and its Transaction or review commit together.
    yield* commitOutcome({ work, id, activeArgs, statements });
  });

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

const readParsed = (
  input: ProcessInput,
  context: SubmissionRow
): Effect.Effect<Option.Option<ParsedStatement>, StatementProcessingUnavailable> =>
  Effect.gen(function* () {
    const { DB, STATEMENT_STAGING_BUCKET, userId, submissionId } = input;
    const staging = StatementStaging.make({
      database: DB,
      bucket: STATEMENT_STAGING_BUCKET,
      nowEpochMs: nowMs,
    });
    const bytes = yield* Effect.result(
      staging.readOwnedStagedBytes({ userId, stagingId: context.staging_id })
    );
    if (bytes._tag === "Failure") {
      if (bytes.failure._tag === "StatementStagingUnavailable") {
        return yield* new StatementProcessingUnavailable({
          cause: new Error("Statement storage unavailable"),
        });
      }
      yield* markFailed({
        db: DB,
        userId,
        submissionId,
        reason:
          bytes.failure.reason === "retention-expired" ? "retention-expired" : "malformed-file",
      });
      return Option.none();
    }
    if (bytes.success.length > maximumStatementBytes) {
      yield* markFailed({ db: DB, userId, submissionId, reason: "resource-limit" });
      return Option.none();
    }
    const parsed = yield* Effect.result(parseStatementFile(bytes.success));
    if (parsed._tag === "Failure") {
      yield* markFailed({
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
    return yield* validateParsed(input, context, parsed.success);
  });

const validateParsed = (
  input: ProcessInput,
  context: SubmissionRow,
  parsed: ParsedStatement
): Effect.Effect<Option.Option<ParsedStatement>, StatementProcessingUnavailable> =>
  Effect.gen(function* () {
    if (parsed.sourceFormat !== context.source_format) {
      yield* markFailed({
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
      yield* markFailed({
        db: input.DB,
        userId: input.userId,
        submissionId: input.submissionId,
        reason: "malformed-file",
      });
      return Option.none();
    }
    if (parsed.rows.length > statementParserLimits.maximumRows) {
      yield* markFailed({
        db: input.DB,
        userId: input.userId,
        submissionId: input.submissionId,
        reason: "resource-limit",
      });
      return Option.none();
    }
    return Option.some(parsed);
  });

const readProgress = (
  input: ProcessInput
): Effect.Effect<Progress, StatementProcessingUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const raw = yield* attempt(() =>
      input.DB.prepare(`SELECT count(*) AS total,
    coalesce(sum(outcome = 'accepted'), 0) AS accepted,
    coalesce(sum(outcome = 'needs-review'), 0) AS review
    FROM statement_record_outcomes WHERE submission_id = ? AND user_id = ?`)
        .bind(input.submissionId, input.userId)
        .first()
    );
    return yield* Schema.decodeUnknownEffect(countRow)(raw);
  });

const captureCategoryInput = (
  outcome: Option.Option<InterpretedStatementRow<TransactionExtraction>>
): CaptureCategoryInput =>
  Option.isSome(outcome) && outcome.value.outcome === "accepted"
    ? {
        caller: Option.none<CategoryId>(),
        counterparty: outcome.value.extraction.counterparty,
        direction: outcome.value.extraction.direction,
      }
    : {
        caller: Option.none<CategoryId>(),
        counterparty: Option.none<string>(),
        direction: "outflow",
      };

const finalizeChunk = ({
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
}>): Effect.Effect<void, StatementProcessingUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const chunk = rows.slice(progress.total, progress.total + statementChunkSize);
    const mapping = mechanicalMappingFor(parsed.headers);
    const interpreted = Option.isSome(mapping)
      ? yield* interpretStatementRows(
          { rows: chunk, mapping: mapping.value, timeZone: context.time_zone },
          Schema.decodeUnknownEffect(Schema.toCodecJson(TransactionExtraction))
        )
      : undefined;
    const categories = yield* categorizeCaptures({
      db: input.DB,
      userId: input.userId,
      captures: chunk.map((_, index) =>
        captureCategoryInput(Option.fromUndefinedOr(interpreted?.outcomes[index]))
      ),
    }).pipe(
      Effect.mapError(
        () =>
          new StatementProcessingUnavailable({
            cause: new Error("Statement categorization unavailable"),
          })
      )
    );
    // D1 batches must settle sequentially; a parallel batch could reorder this durable cursor.
    for (const [index, row] of chunk.entries()) {
      const categoryId = yield* Effect.fromOption(
        Option.fromUndefinedOr(categories[index]),
        () =>
          new StatementProcessingUnavailable({
            cause: new Error("Statement categorization unavailable"),
          })
      );
      yield* rowOutcome({
        db: input.DB,
        userId: input.userId,
        submissionId: input.submissionId,
        row,
        context,
        categoryId,
        result: interpreted?.outcomes[index] ?? unmappedStatementRow(row),
      });
    }
  });

const completeSubmission = (
  input: ProcessInput,
  rows: number,
  counts: Progress
): Effect.Effect<void, StatementProcessingUnavailable> =>
  Effect.gen(function* () {
    const { DB, userId, submissionId } = input;
    const finished = yield* attempt(() =>
      DB.batch([
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
      ])
    );
    if (finished[0]?.meta.changes !== 1) {
      return yield* new StatementProcessingUnavailable({
        cause: new Error("Statement finalization unavailable"),
      });
    }
  });

const advanceSubmission = (
  input: ProcessInput,
  context: SubmissionRow,
  parsed: ParsedStatement
): Effect.Effect<"continue" | "completed", StatementProcessingUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ParsedStatementRow))(parsed.rows);
    yield* attempt(() =>
      input.DB.prepare(`UPDATE statement_submissions SET status = 'processing',
    started_at_ms = coalesce(started_at_ms, ?) WHERE id = ? AND user_id = ? AND status = 'queued'`)
        .bind(nowMs(), input.submissionId, input.userId)
        .run()
    );
    const progress = yield* readProgress(input);
    if (progress.total > rows.length || progress.accepted + progress.review !== progress.total) {
      return yield* new StatementProcessingUnavailable({
        cause: new Error("Statement accounting unavailable"),
      });
    }
    if (progress.total < rows.length) {
      yield* finalizeChunk({ input, context, parsed, rows, progress });
    }
    const counts = yield* readProgress(input);
    if (counts.total < rows.length) return "continue";
    if (counts.total !== rows.length || counts.accepted + counts.review !== rows.length) {
      return yield* new StatementProcessingUnavailable({
        cause: new Error("Statement accounting unavailable"),
      });
    }
    yield* completeSubmission(input, rows.length, counts);
    return "completed";
  });

export const processStatementSubmission = (
  input: ProcessInput
): Promise<"continue" | "completed"> =>
  restoreRejection(
    Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* findOwned(input.DB, input.userId, input.submissionId);
        if (Option.isNone(context)) return "completed";
        if (context.value.status === "completed" || context.value.status === "failed") {
          return "completed";
        }
        if (context.value.retention_expires_at_ms <= nowMs()) {
          yield* markFailed({
            db: input.DB,
            userId: input.userId,
            submissionId: input.submissionId,
            reason: "retention-expired",
          });
          return "completed";
        }
        const parsed = yield* readParsed(input, context.value);
        return Option.isSome(parsed)
          ? yield* advanceSubmission(input, context.value, parsed.value)
          : "completed";
      })
    )
  );
