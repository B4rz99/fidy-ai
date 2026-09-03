import { Config, Crypto, DateTime, Effect, Encoding, Layer, Option, Result, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { UnknownJsonString } from "~/schema-compatibility";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import type {
  InterpretedStatementRow,
  NeedsReviewStatementRow,
  StatementColumnMapping,
} from "~/core/ingestion/model";
import { interpretStatementRows } from "~/core/ingestion/rules";
import { NeedsReviewItemId, StatementSubmissionId } from "~/core/ingestion/reference";
import { UserId } from "~/core/identity/reference";
import { TransactionExtraction } from "~/core/transactions/model";
import { freePatCaller } from "~/shell/_shared/suggested-operations";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { durableQueueRetention } from "~/shell/durable-execution-retention";
import { captureStatementTransactionInScope } from "~/shell/transactions/mutations";
import { StatementColumnMapper } from "./column-mapper";
import { type ParsedStatement, type StatementParseFailed, parseStatementFile } from "./parser";
import {
  type QueuedStatement,
  type QueuedSubmissionCursor,
  type TerminalExecutionCursor,
  completeSubmissionInScope,
  expireStatementIngestion,
  failSubmission,
  findQueuedStatementSubmissions,
  findStatementMappingInScope,
  findTerminalStatementExecutions,
  insertNeedsReviewItemInScope,
  insertStatementMappingInScope,
  lockQueuedStatementInScope,
  resolveStatementSubmissionUser,
  startQueuedStatement,
} from "./repo";

/** Backward-readable identifier-only work accepted by statement Ingestion. */
export const StatementIngestionPayload = Schema.Struct({
  submissionId: StatementSubmissionId,
  userId: UserId,
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
}).annotate({ identifier: "StatementIngestionPayload" });
export type StatementIngestionPayload = typeof StatementIngestionPayload.Type;

/** Safe retry marker persisted when statement mapping is temporarily unavailable. */
export class StatementIngestionRetry extends Schema.Error<StatementIngestionRetry>(
  "StatementIngestionRetry"
)({
  _tag: Schema.tag("StatementIngestionRetry"),
  reason: Schema.Literal("mapping-unavailable"),
}) {}

/** Fail-closed signal for queue routing metadata that disagrees with durable ownership. */
class StatementIngestionPayloadMismatch extends Schema.Error<StatementIngestionPayloadMismatch>(
  "StatementIngestionPayloadMismatch"
)({
  _tag: Schema.tag("StatementIngestionPayloadMismatch"),
  reason: Schema.Literal("routing-identity-mismatch"),
}) {}

const queueName = "statement-ingestion";
const maximumAttempts = 3;
export const statementIngestionQueue = PersistedQueue.make({
  name: queueName,
  schema: StatementIngestionPayload,
});

/** Stable revision recorded on extracted outcomes and cached mappings. */
export const statementExtractorRevision = "statement-extractor-v1";
const valueShape = (value: string): string =>
  value
    .trim()
    .replace(/[0-9]+/gu, "D")
    .replace(/[\p{L}]+/gu, "A");

/** Fingerprints table structure without retaining account values in the mapping cache key. */
const formatFingerprint = (parsed: ParsedStatement): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const encoded = yield* Schema.encodeEffect(UnknownJsonString)({
      sourceFormat: parsed.sourceFormat,
      headers: parsed.headers.map((header) => header.trim().toLocaleLowerCase("en-US")),
      shapes: parsed.sampleRows.map((row) => row.map(valueShape)),
    }).pipe(Effect.orDie);
    const bytes = new TextEncoder().encode(encoded);
    const digest = yield* crypto.digest("SHA-256", bytes).pipe(Effect.orDie);
    return Encoding.encodeHex(digest);
  });

const cachedMapping = (
  statement: QueuedStatement,
  fingerprint: string
): ReturnType<typeof findStatementMappingInScope> =>
  withUserTransaction(statement.userId, findStatementMappingInScope(statement.userId, fingerprint));

const mappingFor = Effect.fn(function* (statement: QueuedStatement, parsed: ParsedStatement) {
  const fingerprint = yield* formatFingerprint(parsed);
  const cached = yield* cachedMapping(statement, fingerprint);
  if (Option.isSome(cached)) return { fingerprint, mapping: cached.value };
  const mapper = yield* StatementColumnMapper;
  return { fingerprint, mapping: yield* mapper.mapColumns(parsed) };
});

const captureFailureReview = (
  outcome: Extract<InterpretedStatementRow<TransactionExtraction>, { outcome: "accepted" }>
): NeedsReviewStatementRow => ({
  outcome: "needs-review",
  recordNumber: outcome.recordNumber,
  reason: "canonical-validation-failed",
  knownMoney: Option.some(outcome.extraction.money),
  issues: [
    {
      path: "occurredAt",
      message: "The extracted row could not be captured as a canonical Transaction.",
    },
  ],
  evidence: outcome.evidence,
});

const insertReview = Effect.fnUntraced(function* (
  statement: QueuedStatement,
  outcome: NeedsReviewStatementRow
) {
  const crypto = yield* Crypto.Crypto;
  return yield* insertNeedsReviewItemInScope({
    id: NeedsReviewItemId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
    userId: statement.userId,
    submissionId: statement.id,
    outcome,
    context: {
      serviceMarket: statement.serviceMarket,
      locale: statement.locale,
      timeZone: statement.timeZone,
    },
    sourceFormat: statement.sourceFormat,
    parserRevision: statement.parserRevision,
    extractorRevision: statementExtractorRevision,
  });
});

const finalizeOutcome = Effect.fn(function* (
  statement: QueuedStatement,
  outcome: InterpretedStatementRow<TransactionExtraction>
) {
  if (outcome.outcome === "needs-review") {
    yield* insertReview(statement, outcome);
    return false;
  }
  const captured = yield* Effect.result(
    captureStatementTransactionInScope({
      userId: statement.userId,
      caller: freePatCaller(["write"]),
      extraction: outcome.extraction,
      context: {
        serviceMarket: statement.serviceMarket,
        locale: statement.locale,
        timeZone: statement.timeZone,
      },
      attestation: {
        statementSubmissionId: statement.id,
        statementRecordNumber: outcome.recordNumber,
        statementContentHash: statement.contentHash,
        sourceFormat: statement.sourceFormat,
        parserRevision: InterpretationRevision.make(statement.parserRevision),
        extractorRevision: InterpretationRevision.make(statementExtractorRevision),
      },
    })
  );
  if (Result.isSuccess(captured)) return true;
  yield* insertReview(statement, captureFailureReview(outcome));
  return false;
});

type FinalizationInput = Readonly<{
  statement: QueuedStatement;
  parsed: ParsedStatement;
  fingerprint: string;
  mapping: StatementColumnMapping;
}>;

const finalize = Effect.fn(function* (input: FinalizationInput) {
  const { statement, parsed, fingerprint, mapping } = input;
  const interpreted = yield* interpretStatementRows(
    { rows: parsed.rows, mapping, timeZone: statement.timeZone },
    Schema.decodeUnknownEffect(TransactionExtraction)
  );
  yield* withUserTransaction(
    statement.userId,
    Effect.gen(function* () {
      if (!(yield* lockQueuedStatementInScope(statement.userId, statement.id))) return;
      yield* insertStatementMappingInScope({
        userId: statement.userId,
        fingerprint,
        mapping,
        extractorRevision: statementExtractorRevision,
      });
      let acceptedRows = 0;
      for (const outcome of interpreted.outcomes) {
        if (yield* finalizeOutcome(statement, outcome)) acceptedRows += 1;
      }
      yield* completeSubmissionInScope({
        userId: statement.userId,
        id: statement.id,
        accounting: {
          inputRows: interpreted.outcomes.length,
          acceptedRows,
          needsReviewRows: interpreted.outcomes.length - acceptedRows,
        },
        completedAt: yield* DateTime.now,
      });
    })
  );
});

const finalizeUnmappedRows = Effect.fn(function* (
  statement: QueuedStatement,
  parsed: ParsedStatement
) {
  yield* withUserTransaction(
    statement.userId,
    Effect.gen(function* () {
      if (!(yield* lockQueuedStatementInScope(statement.userId, statement.id))) return;
      for (const row of parsed.rows) {
        yield* insertReview(statement, {
          outcome: "needs-review",
          recordNumber: row.recordNumber,
          reason: "mapping-unavailable",
          knownMoney: Option.none(),
          issues: [
            {
              path: "",
              message: "The statement format could not be mapped after bounded retries.",
            },
          ],
          evidence: row.evidence,
        });
      }
      yield* completeSubmissionInScope({
        userId: statement.userId,
        id: statement.id,
        accounting: {
          inputRows: parsed.rows.length,
          acceptedRows: 0,
          needsReviewRows: parsed.rows.length,
        },
        completedAt: yield* DateTime.now,
      });
    })
  );
});

const processQueued = Effect.fn("StatementIngestion.process")(function* (
  queueId: string,
  payload: StatementIngestionPayload,
  attempts: number
) {
  if (queueId !== payload.submissionId) {
    return yield* StatementIngestionPayloadMismatch.make({
      reason: "routing-identity-mismatch",
    });
  }
  const authoritativeUserId = yield* resolveStatementSubmissionUser(payload.submissionId);
  if (Option.isNone(authoritativeUserId)) return "stale" as const;
  if (authoritativeUserId.value !== payload.userId) {
    return yield* StatementIngestionPayloadMismatch.make({
      reason: "routing-identity-mismatch",
    });
  }
  yield* Effect.annotateCurrentSpan("fidy.user.id", authoritativeUserId.value);
  const startedAt = yield* DateTime.now;
  const queued = yield* startQueuedStatement(
    authoritativeUserId.value,
    payload.submissionId,
    startedAt
  );
  if (Option.isNone(queued)) return "stale" as const;
  const statement = queued.value;
  const parsed = yield* parseStatementFile(statement.fileContent).pipe(
    Effect.map(Option.some),
    Effect.catchTag("StatementParseFailed", (failure: StatementParseFailed) =>
      failSubmission({
        userId: statement.userId,
        id: statement.id,
        failureReason: failure.safeReason,
        completedAt: startedAt,
      }).pipe(Effect.as(Option.none<ParsedStatement>()))
    )
  );
  if (Option.isNone(parsed)) return "processed" as const;

  const mapping = yield* mappingFor(statement, parsed.value).pipe(
    Effect.map(Option.some),
    Effect.catchTag("StatementColumnMappingFailed", () =>
      (attempts + 1 >= maximumAttempts
        ? finalizeUnmappedRows(statement, parsed.value)
        : StatementIngestionRetry.make({ reason: "mapping-unavailable" })
      ).pipe(Effect.as(Option.none<{ fingerprint: string; mapping: StatementColumnMapping }>()))
    )
  );
  if (Option.isNone(mapping)) return "processed" as const;
  yield* finalize({
    statement,
    parsed: parsed.value,
    fingerprint: mapping.value.fingerprint,
    mapping: mapping.value.mapping,
  });
  return "processed" as const;
});

const processQueuedWork = Effect.fn("StatementIngestion.processWork")(function* (
  queueId: string,
  payload: StatementIngestionPayload,
  attempts: number
) {
  return yield* processQueued(queueId, payload, attempts).pipe(
    Effect.withSpan("ingestion.processStatementSubmission", {
      attributes: { "fidy.statement_submission.id": payload.submissionId },
    })
  );
});

/** Transaction-composable publication; duplicate submissions converge on one durable queue item. */
export const publishStatementIngestion = Effect.fn("StatementIngestion.publish")(function* (
  userId: UserId,
  submissionId: StatementSubmissionId
) {
  const queue = yield* statementIngestionQueue;
  yield* queue
    .offer({ userId, submissionId, revision: 1 }, { id: submissionId })
    .pipe(Effect.orDie);
});

/** Processes one owning submission, skipping stale items until work succeeds or two seconds pass. */
export const processNextStatement = Effect.fn("processNextStatement")(function* () {
  yield* expireStatementIngestion();
  const queue = yield* statementIngestionQueue;
  const takeCurrent = queue
    .take((payload, { id, attempts }) => processQueuedWork(id, payload, attempts), {
      maxAttempts: maximumAttempts,
    })
    .pipe(Effect.orElseSucceed(() => "retrying" as const));
  const completed = yield* Effect.gen(function* () {
    for (;;) {
      const result = yield* takeCurrent;
      if (result === "processed") return true;
      if (result === "retrying") return false;
    }
  }).pipe(Effect.timeoutOption("2 seconds"));
  return Option.getOrElse(completed, () => false);
});

const publishQueuedPage = Effect.fn("StatementIngestion.publishPage")(function* (
  cursor: Option.Option<QueuedSubmissionCursor>
) {
  const queue = yield* statementIngestionQueue;
  const pending = yield* findQueuedStatementSubmissions(cursor);
  yield* Effect.forEach(
    pending,
    ({ id, userId }) =>
      queue.offer({ submissionId: id, userId, revision: 1 }, { id }).pipe(Effect.orDie),
    { discard: true }
  );
  return Option.fromUndefinedOr(pending.at(-1));
});

const removeTerminalPage = Effect.fn("StatementIngestion.removeTerminalPage")(function* (
  cursor: Option.Option<TerminalExecutionCursor>
) {
  const terminal = yield* findTerminalStatementExecutions(cursor);
  yield* durableQueueRetention.removeCompleted(
    queueName,
    terminal.map(({ id }) => id)
  );
  return Option.fromUndefinedOr(terminal.at(-1));
});

const continueQueuedRecovery = Effect.fn("StatementIngestion.continueRecovery")(function* (
  firstPage: Option.Option<QueuedSubmissionCursor>
) {
  let cursor = firstPage;
  yield* Option.match(firstPage, {
    onNone: () => Effect.void,
    onSome: () =>
      Effect.gen(function* () {
        yield* Effect.sleep("1 minute");
        cursor = yield* publishQueuedPage(cursor);
        return cursor;
      }).pipe(Effect.repeat({ while: Option.isSome }), Effect.asVoid),
  });
});

const consumeStatementQueue = Effect.gen(function* () {
  const queue = yield* statementIngestionQueue;
  return yield* queue
    .take((payload, { id, attempts }) => processQueuedWork(id, payload, attempts), {
      maxAttempts: maximumAttempts,
    })
    .pipe(
      Effect.catchTag("StatementIngestionRetry", () => Effect.void),
      Effect.catchCause((cause) => Effect.logError("Statement ingestion iteration failed", cause)),
      Effect.forever
    );
});

const retainTerminalExecutions = Effect.fn("StatementIngestion.retainTerminalExecutions")(
  function* (firstPage: Option.Option<TerminalExecutionCursor>) {
    let cursor = firstPage;
    return yield* Effect.gen(function* () {
      yield* Effect.sleep(
        Option.match(cursor, { onNone: () => "1 day" as const, onSome: () => "1 minute" as const })
      );
      yield* Option.match(cursor, {
        onNone: () => expireStatementIngestion(),
        onSome: () => Effect.void,
      });
      cursor = yield* removeTerminalPage(cursor);
    }).pipe(Effect.forever);
  }
);

const runStatementIngestionWorker = Effect.gen(function* () {
  yield* expireStatementIngestion();
  const firstQueuedPage = yield* publishQueuedPage(Option.none());
  const firstTerminalPage = yield* removeTerminalPage(Option.none());
  yield* Effect.all(
    [
      consumeStatementQueue,
      retainTerminalExecutions(firstTerminalPage),
      continueQueuedRecovery(firstQueuedPage),
    ].map((loop) => Effect.forkScoped(loop)),
    { concurrency: "unbounded", discard: true }
  );
});

/** Runs SQL queue consumption, bounded startup recovery, and repeat-safe evidence retention. */
export const StatementIngestionWorkerLive = Layer.effectDiscard(
  Config.string("NODE_ENV").pipe(
    Config.withDefault("development"),
    Effect.flatMap((environment) =>
      runStatementIngestionWorker.pipe(
        Effect.when(Effect.succeed(environment === "production")),
        Effect.asVoid
      )
    )
  )
);
