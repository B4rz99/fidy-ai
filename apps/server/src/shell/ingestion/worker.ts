import {
  Cause,
  Config,
  Crypto,
  DateTime,
  Effect,
  Encoding,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from "effect";
import { SqlError } from "effect/unstable/sql";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { InterpretationRevision } from "~/core/interpretation-evidence/contract";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import type {
  InterpretedStatementRow,
  NeedsReviewStatementRow,
  StatementColumnMapping,
} from "~/core/ingestion/model";
import { interpretStatementRows } from "~/core/ingestion/rules";
import { NeedsReviewItemId, StatementSubmissionId } from "~/core/ingestion/reference";
import { UserId } from "~/core/identity/reference";
import { TransactionExtraction } from "~/core/transactions/model";
import { resolveAccessTierInScope } from "~/shell/access-tier/operations";
import type {
  ApplicationPersistedQueueHandlerPolicy,
  PersistedQueueFailureDisposition,
} from "~/shell/persisted-queue/contract";
import { declarePersistedQueue } from "~/shell/persisted-queue/operations";
import { withUserTransaction } from "~/shell/database/operations";
import { durableQueueRetention } from "~/shell/durable-execution-retention";
import { runBestEffortMaintenance } from "~/shell/maintenance-schedule";
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

/** Safe retry marker persisted for a transient mapping or database outage. */
export class StatementIngestionRetry extends Schema.Error<StatementIngestionRetry>(
  "StatementIngestionRetry"
)({
  _tag: Schema.tag("StatementIngestionRetry"),
  reason: Schema.Literals(["mapping-unavailable", "infrastructure-unavailable"]),
}) {}

const classifyStatementFailure = (
  _failure: StatementIngestionRetry
): PersistedQueueFailureDisposition => ({ _tag: "Retry", reason: "transient" });

const statementIngestionOperation = CanonicalOperationId.make("ingestion.submitForExtraction");

const isRetryableSqlCause = function <E>(cause: Cause.Cause<E>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every(
      (reason) =>
        Cause.isDieReason(reason) && SqlError.isSqlError(reason.defect) && reason.defect.isRetryable
    )
  );
};

const classifyRetryableInfrastructure = function <A, E, R>(
  work: Effect.Effect<A, E, R>
): Effect.Effect<A, E | StatementIngestionRetry, R> {
  return Effect.catchCauseIf(work, isRetryableSqlCause, () =>
    Effect.fail(StatementIngestionRetry.make({ reason: "infrastructure-unavailable" }))
  );
};

const statementHandlerDescriptor = {
  component: "api",
  operation: statementIngestionOperation,
} as const;

export const statementIngestionQueueName = "statement-ingestion";
export const maximumStatementIngestionAttempts = 3;
export const statementIngestionQueue = declarePersistedQueue({
  name: statementIngestionQueueName,
  schema: StatementIngestionPayload,
  descriptor: statementHandlerDescriptor,
});

/** Native queue primary key: the submission this work belongs to. */
export const statementIngestionQueueId = (payload: StatementIngestionPayload): string =>
  payload.submissionId;

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
  const tier = yield* resolveAccessTierInScope(statement.userId, yield* DateTime.now);
  const captured = yield* Effect.result(
    captureStatementTransactionInScope({
      userId: statement.userId,
      caller: { accessCaller: { _tag: "PAT", capabilities: ["write"] }, tier },
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
  // Conflicting routing metadata has no trustworthy owning submission to mutate. Completing this
  // item is its terminal queue disposition; any valid submission remains unchanged.
  if (queueId !== payload.submissionId) return "stale-routing" as const;
  const authoritativeUserId = yield* resolveStatementSubmissionUser(payload.submissionId);
  if (Option.isNone(authoritativeUserId)) return "stale" as const;
  if (authoritativeUserId.value !== payload.userId) return "stale-routing" as const;
  const startedAt = yield* DateTime.now;
  const queued = yield* startQueuedStatement(
    authoritativeUserId.value,
    payload.submissionId,
    startedAt
  );
  if (Option.isNone(queued)) return "stale" as const;
  const statement = queued.value;
  const parsed = yield* parseStatementFile(statement.fileContent).pipe(
    Effect.asSome,
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
    Effect.asSome,
    Effect.catchTag("StatementColumnMappingFailed", (failure) =>
      (failure.safeReason === "permanent-failure" ||
      attempts + 1 >= maximumStatementIngestionAttempts
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

type StatementQueueOutcome = "processed" | "stale" | "stale-routing";
type StatementQueueWork = Readonly<{
  queueId: string;
  payload: StatementIngestionPayload;
  attempts: number;
  /** Preserves the successful outcome that the redaction boundary intentionally erases. */
  observeOutcome: (outcome: StatementQueueOutcome) => Effect.Effect<void>;
}>;

const statementQueueHandlerPolicy: ApplicationPersistedQueueHandlerPolicy<
  StatementIngestionPayload,
  StatementIngestionRetry,
  never,
  never
> = {
  classify: classifyStatementFailure,
  // A future terminal classification must add an owning persisted disposition first.
  recordTerminal: () => Effect.die("unexpected terminal classification"),
};

const processQueuedWork = Effect.fn("StatementIngestion.processWork")(function* (
  work: StatementQueueWork
) {
  return yield* processQueued(work.queueId, work.payload, work.attempts).pipe(
    Effect.tap(work.observeOutcome),
    classifyRetryableInfrastructure,
    Effect.withSpan("ingestion.processStatementSubmission")
  );
});

/** Transaction-composable publication; duplicate submissions converge on one durable queue item. */
export const publishStatementIngestion = Effect.fn("StatementIngestion.publish")(function* (
  userId: UserId,
  submissionId: StatementSubmissionId
) {
  const queue = statementIngestionQueue;
  const payload = { userId, submissionId, revision: 1 } as const;
  yield* queue.offer(payload, { id: statementIngestionQueueId(payload) }).pipe(Effect.orDie);
});

const observeStatementOutcome =
  (outcome: Ref.Ref<StatementQueueOutcome>) =>
  (current: StatementQueueOutcome): Effect.Effect<void> =>
    Ref.set(outcome, current);

/** Processes one submission; skips absent items and returns false on retry, stale routing, or timeout. */
export const processNextStatement = Effect.fn("processNextStatement")(function* () {
  yield* expireStatementIngestion();
  const queue = statementIngestionQueue;
  const takeCurrent = Effect.gen(function* () {
    const outcome = yield* Ref.make<StatementQueueOutcome>("stale");
    yield* queue.handleNext(
      (payload, { id, attempts }) =>
        processQueuedWork({
          queueId: id,
          payload,
          attempts,
          observeOutcome: observeStatementOutcome(outcome),
        }),
      statementQueueHandlerPolicy,
      { maxAttempts: maximumStatementIngestionAttempts }
    );
    return yield* Ref.get(outcome);
  }).pipe(Effect.orElseSucceed(() => "retrying" as const));
  const completed = yield* Effect.gen(function* () {
    for (;;) {
      const result = yield* takeCurrent;
      if (result === "processed") return true;
      if (result === "retrying" || result === "stale-routing") return false;
    }
  }).pipe(Effect.timeoutOption("2 seconds"));
  return Option.getOrElse(completed, () => false);
});

const publishQueuedPage = Effect.fn("StatementIngestion.publishPage")(function* (
  cursor: Option.Option<QueuedSubmissionCursor>
) {
  const queue = statementIngestionQueue;
  const pending = yield* findQueuedStatementSubmissions(cursor);
  yield* Effect.forEach(
    pending,
    ({ id, userId }) => {
      const payload = { submissionId: id, userId, revision: 1 } as const;
      return queue.offer(payload, { id: statementIngestionQueueId(payload) }).pipe(Effect.orDie);
    },
    { discard: true }
  );
  return Option.fromUndefinedOr(pending.at(-1));
});

const removeTerminalPage = Effect.fn("StatementIngestion.removeTerminalPage")(function* (
  cursor: Option.Option<TerminalExecutionCursor>
) {
  const terminal = yield* findTerminalStatementExecutions(cursor);
  yield* durableQueueRetention.removeCompleted(
    statementIngestionQueueName,
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
  const queue = statementIngestionQueue;
  return yield* queue
    .handleNext(
      (payload, { id, attempts }) =>
        processQueuedWork({
          queueId: id,
          payload,
          attempts,
          observeOutcome: () => Effect.void,
        }),
      statementQueueHandlerPolicy,
      { maxAttempts: maximumStatementIngestionAttempts }
    )
    .pipe(
      Effect.catchTag("PersistedQueueHandlerFailure", () => Effect.void),
      Effect.forever
    );
});

const retainTerminalExecutions = Effect.fn("StatementIngestion.retainTerminalExecutions")(
  function* () {
    yield* expireStatementIngestion();
    let cursor = yield* removeTerminalPage(Option.none());
    while (Option.isSome(cursor)) {
      yield* Effect.sleep("1 minute");
      cursor = yield* removeTerminalPage(cursor);
    }
  }
);

const runStatementIngestionWorker = Effect.gen(function* () {
  const firstQueuedPage = yield* publishQueuedPage(Option.none());
  yield* Effect.forEach(
    [consumeStatementQueue, continueQueuedRecovery(firstQueuedPage)],
    (loop) => Effect.forkScoped(loop),
    { concurrency: "unbounded", discard: true }
  );
});

/** Best-effort evidence and completed queue retention; expiry is independently enforced on use. */
export const StatementIngestionRetentionLive = Layer.effectDiscard(
  runBestEffortMaintenance({
    timing: "best-effort",
    cadence: "1 day",
    work: retainTerminalExecutions().pipe(
      Effect.catchCause(() => Effect.logError("Statement ingestion retention failed"))
    ),
  }).pipe(Effect.forkScoped)
);

/** Runs SQL queue consumption and bounded startup recovery. */
export const StatementIngestionWorkerLive = Layer.effectDiscard(
  Config.String("NODE_ENV").pipe(
    Config.withDefault("development"),
    Effect.flatMap((environment) =>
      runStatementIngestionWorker.pipe(
        Effect.when(Effect.succeed(environment === "production")),
        Effect.asVoid
      )
    )
  )
);
