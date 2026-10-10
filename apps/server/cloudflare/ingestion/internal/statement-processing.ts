import type { CaptureCategoryInput } from "../../categories/contract";
import {
  type ParsedStatement,
  StatementFailureReason,
  StatementParseFailed,
  StatementStagingId,
  maximumStatementBytes,
  statementParserLimits,
} from "../../../src/shell/ingestion/contract";
import { parseStatementFile } from "../../../src/shell/ingestion/operations";

import type { CategoryId } from "../../../src/core/categories/contract";
import { categorizeCaptures } from "../../categories/operations";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import {
  type InterpretedStatementRow,
  ParsedStatementRow,
  StatementRowEvidence,
} from "../../../src/core/ingestion/contract";
import {
  interpretStatementRows,
  mechanicalMappingFor,
  unmappedStatementRow,
} from "../../../src/core/ingestion/operations";
import { TransactionExtraction } from "../../../src/core/transactions/contract";
import { prepareStatementCapture } from "../../transactions/operations";
import { StatementProcessingUnavailable } from "../contract";
import { StatementStaging, newIngestionId } from "./statement-staging";
import { maximumRetainedReviewEvidence } from "./statement-review-retention";
import {
  findMaterializedChunk,
  materializeStatement,
  reserveStatementSourceParse,
} from "./statement-materialization";
import { statementChunkSize } from "./statement-processing-limits";
import { statementReviewAdmission } from "./statement-review-budget";

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
const progressCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: statementParserLimits.maximumRows })
);
const countRow = Schema.Struct({
  total: progressCount,
  accepted: progressCount,
  review: progressCount,
  last_record: progressCount,
});
const outcomeRow = Schema.Struct({ outcome: Schema.Literals(["accepted", "needs-review"]) });
const evidenceCodec = Schema.toCodecJson(StatementRowEvidence);
const extractorRevision = "statement-mechanical-v1";

const newId = newIngestionId;
class StatementProcessingDependencyFailed extends Data.TaggedError(
  "StatementProcessingDependencyFailed"
)<{
  readonly cause: unknown;
}> {}
class StatementReviewBudgetExceeded extends Data.TaggedError("StatementReviewBudgetExceeded") {}
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, StatementProcessingDependencyFailed> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new StatementProcessingDependencyFailed({ cause }),
  });

const findOwned = (
  db: D1Database,
  userId: string,
  submissionId: string
): Effect.Effect<
  Option.Option<SubmissionRow>,
  StatementProcessingDependencyFailed | Schema.SchemaError
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
}>): Effect.Effect<void, StatementProcessingDependencyFailed> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* attempt(() =>
      db.batch([
        db
          .prepare(`UPDATE statement_submissions SET status = 'failed',
      started_at_ms = coalesce(started_at_ms, ?), completed_at_ms = ?, failure_reason = ?,
      input_rows = nullif(processed_rows, 0),
      accepted_rows = CASE WHEN processed_rows > 0 THEN processed_accepted_rows ELSE NULL END,
      needs_review_rows = CASE WHEN processed_rows > 0 THEN processed_review_rows ELSE NULL END
      WHERE id = ? AND user_id = ? AND status IN ('queued', 'processing')`)
          .bind(current, current, reason, submissionId, userId),
        db
          .prepare(`UPDATE statement_backfill_entitlements
      SET submission_id = CASE WHEN consumed_at_ms IS NULL THEN NULL ELSE submission_id END
      WHERE user_id = ? AND submission_id = ? AND changes() = 1`)
          .bind(userId, submissionId),
        db
          .prepare(`DELETE FROM statement_ingestion_outbox
          WHERE submission_id = ? AND user_id = ? AND revision = 1
            AND EXISTS (SELECT 1 FROM statement_submissions
              WHERE id = ? AND user_id = ? AND status IN ('completed', 'failed'))`)
          .bind(submissionId, userId, submissionId, userId),
      ])
    ).pipe(Effect.asVoid, Effect.uninterruptible);
  });

/**
 * Settles exhausted statement work under the User coordinator, atomically releasing a pending
 * Free entitlement and acknowledging its extraction identity. Repeated or late failure cannot
 * regress a completed submission. Only a closed public reason is stored; the Workflow's raw
 * exception must never be passed here.
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
}>): Effect.Effect<void, StatementProcessingUnavailable> =>
  Effect.gen(function* () {
    const safeReason = yield* Schema.decodeEffect(StatementFailureReason)(reason);
    yield* markFailed({ db: DB, userId, submissionId, reason: safeReason });
  }).pipe(Effect.mapError(() => new StatementProcessingUnavailable()));

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
  {
    id,
    activeArgs,
    current,
  }: Readonly<{ id: string; activeArgs: ReadonlyArray<string | number>; current: number }>
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
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(current)),
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
  {
    id,
    activeArgs,
    current,
  }: Readonly<{ id: string; activeArgs: ReadonlyArray<string | number>; current: number }>
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
      current,
      JSON.stringify(evidence),
      JSON.stringify(result.issues),
      maximumRetainedReviewEvidence,
      context.retention_expires_at_ms,
      current,
      context.retention_expires_at_ms,
      current,
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
}>): Effect.Effect<void, StatementProcessingDependencyFailed> =>
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

const rowOutcome = (
  work: RowWork
): Effect.Effect<void, StatementProcessingDependencyFailed | StatementReviewBudgetExceeded> =>
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
        return yield* new StatementProcessingDependencyFailed({
          cause: new Error("Statement outcome unavailable"),
        });
      }
      return;
    }
    const id = newId();
    const current = yield* Clock.currentTimeMillis;
    if (
      result.outcome === "needs-review" &&
      !reviewAdmission(work, work.context, current)(result)
    ) {
      return yield* new StatementReviewBudgetExceeded();
    }
    const activeArgs = [submissionId, userId, current];
    const statements =
      result.outcome === "accepted"
        ? acceptedStatements(
            {
              ...work,
              result,
              categoryId: work.categoryId,
            },
            { id, activeArgs, current }
          )
        : [reviewStatement({ ...work, result }, { id, activeArgs, current })];
    // The unique record identity, its evidence and its Transaction or review commit together.
    yield* commitOutcome({ work, id, activeArgs, statements }).pipe(Effect.uninterruptible);
  });

/**
 * Finalizes an owned submission under its stable User's Durable Object turn. The caller MUST
 * serialize all processing and retention work for this User; an opaque submission id is never
 * authority. D1 atomically commits each row with its evidence, so retry resumes from the unique
 * (submission, record) outcome. Each call commits at most 32 rows, returning `continue` for
 * another named Workflow activity or `completed` for terminal state. Complete derived material
 * is published once and reused within its original retention purpose. Infrastructure
 * failures reject for durable redelivery; unsafe material becomes terminal or visible review.
 */
type ProcessInput = Readonly<{
  DB: D1Database;
  STATEMENT_STAGING_BUCKET: R2Bucket;
  userId: string;
  submissionId: string;
}>;
type Progress = typeof countRow.Type;

const reviewAdmission = (
  input: Pick<ProcessInput, "userId" | "submissionId">,
  context: SubmissionRow,
  current: number
): ReturnType<typeof statementReviewAdmission> =>
  statementReviewAdmission({
    userId: input.userId,
    submissionId: input.submissionId,
    serviceMarket: context.service_market,
    locale: context.locale,
    timeZone: context.time_zone,
    sourceFormat: context.source_format,
    parserRevision: context.parser_revision,
    extractorRevision,
    expiresAt: context.retention_expires_at_ms,
    createdAt: current,
  });

const readParsed = (
  input: ProcessInput,
  context: SubmissionRow
): Effect.Effect<Option.Option<ParsedStatement>, StatementProcessingDependencyFailed> =>
  Effect.gen(function* () {
    const { DB, STATEMENT_STAGING_BUCKET, userId, submissionId } = input;
    const clock = yield* Clock.Clock;
    const staging = StatementStaging.make({
      database: DB,
      bucket: STATEMENT_STAGING_BUCKET,
      nowEpochMs: () => clock.currentTimeMillisUnsafe(),
    });
    const bytes = yield* Effect.result(
      staging.readOwnedStagedBytes({ userId, stagingId: context.staging_id })
    );
    if (bytes._tag === "Failure") {
      if (bytes.failure._tag === "StatementStagingUnavailable") {
        return yield* new StatementProcessingDependencyFailed({
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
): Effect.Effect<Option.Option<ParsedStatement>, StatementProcessingDependencyFailed> =>
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
): Effect.Effect<Progress, StatementProcessingDependencyFailed | Schema.SchemaError> =>
  Effect.gen(function* () {
    const raw = yield* attempt(() =>
      input.DB.prepare(`SELECT processed_rows AS total, processed_accepted_rows AS accepted,
    processed_review_rows AS review,
    coalesce((SELECT record_number FROM statement_record_outcomes
      WHERE submission_id = s.id ORDER BY record_number DESC LIMIT 1), 0) AS last_record
    FROM statement_submissions s WHERE id = ? AND user_id = ?`)
        .bind(input.submissionId, input.userId)
        .first()
    );
    const progress = yield* Schema.decodeUnknownEffect(countRow)(raw);
    if (
      progress.total !== progress.last_record ||
      progress.accepted + progress.review !== progress.total
    ) {
      return yield* new StatementProcessingDependencyFailed({
        cause: new Error("Statement accounting unavailable"),
      });
    }
    return progress;
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
}: Readonly<{
  input: ProcessInput;
  context: SubmissionRow;
  parsed: ParsedStatement;
  rows: ReadonlyArray<ParsedStatementRow>;
}>): Effect.Effect<
  void,
  StatementProcessingDependencyFailed | StatementReviewBudgetExceeded | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const chunk = rows.slice(0, statementChunkSize);
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
          new StatementProcessingDependencyFailed({
            cause: new Error("Statement categorization unavailable"),
          })
      )
    );
    // D1 batches must settle sequentially; a parallel batch could reorder this durable cursor.
    for (const [index, row] of chunk.entries()) {
      const categoryId = yield* Effect.fromOption(
        Option.fromUndefinedOr(categories[index]),
        () =>
          new StatementProcessingDependencyFailed({
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
): Effect.Effect<void, StatementProcessingDependencyFailed> =>
  Effect.gen(function* () {
    const { DB, userId, submissionId } = input;
    const current = yield* Clock.currentTimeMillis;
    const finished = yield* attempt(() =>
      DB.batch([
        DB.prepare(`UPDATE statement_submissions
    SET status = 'completed', completed_at_ms = ?, input_rows = ?,
      accepted_rows = ?, needs_review_rows = ?
    WHERE id = ? AND user_id = ? AND status = 'processing'
      AND processed_rows = ? AND processed_accepted_rows = ? AND processed_review_rows = ?`).bind(
          current,
          rows,
          counts.accepted,
          counts.review,
          submissionId,
          userId,
          rows,
          counts.accepted,
          counts.review
        ),
        DB.prepare(`UPDATE statement_backfill_entitlements
      SET submission_id = CASE WHEN consumed_at_ms IS NULL THEN NULL ELSE submission_id END
      WHERE user_id = ? AND submission_id = ? AND changes() = 1
        AND NOT EXISTS (SELECT 1 FROM statement_clarifications
          WHERE submission_id = ? AND state = 'awaiting')`).bind(
          userId,
          submissionId,
          submissionId
        ),
        DB.prepare(`DELETE FROM statement_ingestion_outbox
          WHERE submission_id = ? AND user_id = ? AND revision = 1
            AND EXISTS (SELECT 1 FROM statement_submissions
              WHERE id = ? AND user_id = ? AND status = 'completed')`).bind(
          submissionId,
          userId,
          submissionId,
          userId
        ),
      ])
    );
    if ((finished[0]?.meta.changes ?? 0) < 1) {
      return yield* new StatementProcessingDependencyFailed({
        cause: new Error("Statement finalization unavailable"),
      });
    }
  });

const advanceSubmission = (
  input: ProcessInput,
  context: SubmissionRow,
  parsed: ParsedStatement & Readonly<{ totalRows: number }>
): Effect.Effect<
  "continue" | "completed",
  StatementProcessingDependencyFailed | StatementReviewBudgetExceeded | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeEffect(Schema.toType(Schema.Array(ParsedStatementRow)))(
      parsed.rows
    );
    const current = yield* Clock.currentTimeMillis;
    yield* attempt(() =>
      input.DB.prepare(`UPDATE statement_submissions SET status = 'processing',
    started_at_ms = coalesce(started_at_ms, ?) WHERE id = ? AND user_id = ? AND status = 'queued'`)
        .bind(current, input.submissionId, input.userId)
        .run()
    );
    const progress = yield* readProgress(input);
    if (
      progress.total > parsed.totalRows ||
      progress.accepted + progress.review !== progress.total
    ) {
      return yield* new StatementProcessingDependencyFailed({
        cause: new Error("Statement accounting unavailable"),
      });
    }
    if (progress.total < parsed.totalRows) {
      yield* finalizeChunk({ input, context, parsed, rows });
    }
    const counts = yield* readProgress(input);
    if (counts.total < parsed.totalRows) return "continue";
    if (counts.total !== parsed.totalRows || counts.accepted + counts.review !== parsed.totalRows) {
      return yield* new StatementProcessingDependencyFailed({
        cause: new Error("Statement accounting unavailable"),
      });
    }
    yield* completeSubmission(input, parsed.totalRows, counts);
    return "completed";
  });

const materializationIdentity = (
  input: ProcessInput,
  context: SubmissionRow
): Parameters<typeof reserveStatementSourceParse>[0] => ({
  DB: input.DB,
  userId: input.userId,
  submissionId: input.submissionId,
  sourceHash: context.sha256,
  parserRevision: context.parser_revision,
  sourceFormat: context.source_format,
  expiresAtMs: context.retention_expires_at_ms,
  serviceMarket: context.service_market,
  locale: context.locale,
  timeZone: context.time_zone,
});
export const processStatementSubmission = (
  input: ProcessInput
): Effect.Effect<"continue" | "completed", StatementProcessingUnavailable> =>
  Effect.gen(function* () {
    const context = yield* findOwned(input.DB, input.userId, input.submissionId);
    if (Option.isNone(context)) return "completed";
    if (context.value.status === "completed" || context.value.status === "failed") {
      return "completed";
    }
    const current = yield* Clock.currentTimeMillis;
    if (context.value.retention_expires_at_ms <= current) {
      yield* markFailed({
        db: input.DB,
        userId: input.userId,
        submissionId: input.submissionId,
        reason: "retention-expired",
      });
      return "completed";
    }
    const identity = materializationIdentity(input, context.value);
    const progress = yield* readProgress(input);
    let chunk = yield* findMaterializedChunk({ ...identity, offset: progress.total });
    if (Option.isNone(chunk)) {
      yield* reserveStatementSourceParse(identity);
      const parsed = yield* readParsed(input, context.value);
      if (Option.isNone(parsed)) return "completed";
      yield* materializeStatement({ ...identity, parsed: parsed.value });
      chunk = yield* findMaterializedChunk({ ...identity, offset: progress.total });
    }
    return Option.isSome(chunk)
      ? yield* advanceSubmission(input, context.value, chunk.value)
      : "completed";
  }).pipe(
    Effect.catchTags({
      StatementMaterializationUnavailable: () => Effect.fail(new StatementProcessingUnavailable()),
      StatementMaterializationFailed: (error) =>
        markFailed({
          db: input.DB,
          userId: input.userId,
          submissionId: input.submissionId,
          reason: error.reason,
        }).pipe(Effect.as("completed" as const)),
      StatementReviewBudgetExceeded: () =>
        markFailed({
          db: input.DB,
          userId: input.userId,
          submissionId: input.submissionId,
          reason: "resource-limit",
        }).pipe(Effect.as("completed" as const)),
    }),
    Effect.mapError(() => new StatementProcessingUnavailable())
  );
