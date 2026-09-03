import { expect, layer } from "@effect/vitest";
import { PersistedQueue } from "effect/unstable/persistence";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import {
  BigDecimal,
  type Config,
  Context,
  DateTime,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from "effect";
import { Currency } from "~/core/_shared/money";
import { UserId } from "~/core/identity/reference";
import { StatementSubmissionId } from "~/core/ingestion/reference";
import {
  Base64FileContent,
  StatementColumnMapping,
  StatementIdempotencyKey,
  type SubmitForExtractionInput,
} from "~/core/ingestion/model";
import { TokenBearer } from "~/core/tokens/model";
import { PATId } from "~/core/tokens/reference";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { defaultUserId, seedConsentedPatIdentity } from "~/shell/db/development-seed";
import {
  type ApiClient,
  ApiHarness,
  ApiHarnessClient,
  makeApiClientLive,
} from "~/shell/testing/api-harness";
import { getTransactionUserDecisions, transactionPayload } from "~/shell/transactions/fixtures";
import { StatementColumnMapper, StatementColumnMappingFailed } from "./column-mapper";
import { truncateStatementIngestion } from "./fixtures";
import { completeSubmissionInScope } from "./repo";
import { StatementIngestionPayload, processNextStatement, statementIngestionQueue } from "./worker";

const mapping = StatementColumnMapping.make({
  dateColumn: 0,
  amountColumn: 1,
  counterpartyColumn: Option.some(2),
  currencyColumn: Option.none(),
  currencyLiteral: Option.some(Currency.make("COP")),
  directionColumn: Option.some(3),
  inflowMarkers: ["CREDIT"],
  outflowMarkers: ["DEBIT"],
  positiveDirection: "inflow",
  dateFormat: "yyyy-MM-dd",
  decimalSeparator: ".",
  groupingSeparator: Option.none(),
});

const MapperOnce = Layer.effect(
  StatementColumnMapper,
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    return StatementColumnMapper.of({
      mapColumns: () =>
        Ref.getAndUpdate(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 0
              ? Effect.succeed(mapping)
              : Effect.fail(
                  new StatementColumnMappingFailed({ safeReason: "provider-unavailable" })
                )
          )
        ),
    });
  })
);

const WorkerHarness = Layer.merge(ApiHarness, MapperOnce);
const SucceedingMapper = StatementColumnMapper.of({
  mapColumns: () => Effect.succeed(mapping),
});
const ReviewWorkerHarness = Layer.merge(
  ApiHarness,
  Layer.succeed(StatementColumnMapper, SucceedingMapper)
);
const otherUserId = UserId.make("f1d1a000-0000-4000-8000-00000000e001");
const otherTokenId = PATId.make("f1d1a000-0000-4000-8000-00000000e002");
const otherBearer = TokenBearer.make("fin_worker02_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
class OtherApiClient extends Context.Service<OtherApiClient, ApiClient>()(
  "@fidy/server/shell/ingestion/worker.test/OtherApiClient"
) {}
const IsolationWorkerHarness = makeApiClientLive({ tag: OtherApiClient, bearer: otherBearer }).pipe(
  Layer.provideMerge(ReviewWorkerHarness)
);

const FailingWorkerHarness = Layer.merge(
  ApiHarness,
  Layer.succeed(
    StatementColumnMapper,
    StatementColumnMapper.of({
      mapColumns: () =>
        Effect.fail(new StatementColumnMappingFailed({ safeReason: "provider-unavailable" })),
    })
  )
);

const increment = (count: number): number => count + 1;
const decrement = (count: number): number => count - 1;
const maximumOf =
  (current: number) =>
  (maximum: number): number =>
    Math.max(maximum, current);

const statementPayload = (idempotencyKey: string): SubmitForExtractionInput => ({
  idempotencyKey: StatementIdempotencyKey.make(idempotencyKey),
  file: {
    name: "statement.csv",
    declaredMediaType: "text/csv",
    contentBase64: Base64FileContent.make(
      Encoding.encodeBase64("Date,Amount,Description,Type\n2020-02-05,25000,Mercado,DEBIT\n")
    ),
  },
});

const independentWorker = (
  mapper: StatementColumnMapper["Service"]
): Layer.Layer<
  PersistedQueue.PersistedQueueFactory | StatementColumnMapper,
  Config.ConfigError | SqlError.SqlError
> =>
  Layer.merge(
    PersistedQueue.layer.pipe(
      Layer.provideMerge(PersistedQueue.layerStoreSql({ tableName: "fidy_queue" }))
    ),
    Layer.succeed(StatementColumnMapper, mapper)
  ).pipe(Layer.provideMerge(Layer.fresh(PgLive)));

layer(FailingWorkerHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "statement mapping recovery",
  (it) => {
    it.effect("decodes the revisionless queue envelope", () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeEffect(StatementIngestionPayload)({
          submissionId: StatementSubmissionId.make("f1d1a000-0000-4000-8000-00000000c194"),
          userId: defaultUserId,
        });
        expect(decoded.revision).toBe(1);
      })
    );

    it.effect("requeues transient mapping failures without losing uploaded bytes", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const client = yield* ApiHarnessClient;
        const submitted = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c195"),
        });
        yield* processNextStatement();
        const retry = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(retry.data).toMatchObject({ status: "queued" });
        yield* processNextStatement();
        yield* processNextStatement();
        const exhausted = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(exhausted.data).toMatchObject({
          status: "completed",
          accounting: { inputRows: 1, acceptedRows: 0, needsReviewRows: 1 },
        });
        const review = yield* client.ingestion.listNeedsReviewItems({
          query: { offset: Option.none(), limit: Option.none() },
        });
        expect(review.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ reason: "mapping-unavailable", status: "pending" }),
          ])
        );
      })
    );
  }
);

layer(ReviewWorkerHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "statement review finalization",
  (it) => {
    it.effect("conserves rejected rows as visible pending review evidence", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${defaultUserId}`;
        const client = yield* ApiHarnessClient;
        const mixedPayload = (idempotencyKey: string): SubmitForExtractionInput => ({
          ...statementPayload(idempotencyKey),
          file: {
            name: "mixed.csv",
            declaredMediaType: "text/csv" as const,
            contentBase64: Base64FileContent.make(
              Encoding.encodeBase64(
                "Date,Amount,Description,Type\n2020-02-05,25000,Mercado,DEBIT\n2020-02-06,9000,Taxi,UNKNOWN\n"
              )
            ),
          },
        });
        const submitted = yield* client.ingestion.submitForExtraction({
          payload: {
            ...mixedPayload("f1d1a000-0000-4000-8000-00000000c194"),
          },
        });
        yield* processNextStatement();

        const status = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({
          status: "completed",
          accounting: { inputRows: 2, acceptedRows: 1, needsReviewRows: 1 },
        });
        const review = yield* client.ingestion.listNeedsReviewItems({
          query: { offset: Option.none(), limit: Option.none() },
        });
        expect(review.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: "pending",
              reason: "ambiguous-direction",
              recordNumber: 2,
            }),
          ])
        );
        const pending = Option.getOrThrow(
          Option.fromUndefinedOr(
            review.data.find(
              (item) =>
                item.sourceChannel === "statement-upload" && item.reason === "ambiguous-direction"
            )
          )
        );
        const changedMoney = yield* Effect.result(
          client.ingestion.resolveNeedsReviewItem({
            params: { id: pending.id },
            payload: {
              extraction: {
                money: transactionPayload().money,
                counterparty: transactionPayload().counterparty,
                direction: transactionPayload().direction,
                occurredAt: transactionPayload().occurredAt,
              },
            },
          })
        );
        expect(Result.isFailure(changedMoney)).toBe(true);
        const resolved = yield* client.ingestion.resolveNeedsReviewItem({
          params: { id: pending.id },
          payload: {
            extraction: {
              money: {
                amount: BigDecimal.fromStringUnsafe("9000"),
                currency: Currency.make("COP"),
              },
              counterparty: transactionPayload().counterparty,
              direction: transactionPayload().direction,
              occurredAt: transactionPayload().occurredAt,
            },
          },
        });
        expect(resolved.data).toMatchObject({ direction: transactionPayload().direction });
        const afterResolution = yield* client.ingestion.listNeedsReviewItems({
          query: { offset: Option.none(), limit: Option.none() },
        });
        expect(afterResolution.data).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: pending.id, status: "resolved" })])
        );

        yield* client.ingestion.submitForExtraction({
          payload: mixedPayload("f1d1a000-0000-4000-8000-00000000c195"),
        });
        yield* processNextStatement();
        yield* sql`
          UPDATE needs_review_items SET created_at = now() - interval '31 days'
          WHERE status = 'pending'
        `;
        yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c196"),
        });
        yield* processNextStatement();
        const afterExpiry = yield* client.ingestion.listNeedsReviewItems({
          query: { offset: Option.none(), limit: Option.none() },
        });
        expect(
          afterExpiry.data
            .filter((item) => item.sourceChannel === "statement-upload")
            .map((item) => item.status)
            .sort()
        ).toEqual(["expired", "resolved"]);
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${defaultUserId}`;
      })
    );
  }
);

layer(IsolationWorkerHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "statement worker isolation",
  (it) => {
    it.effect("keeps interleaved durable outcomes attributed to their owning Users", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        yield* seedConsentedPatIdentity({
          userId: otherUserId,
          bearer: otherBearer,
          tokenId: otherTokenId,
          scopes: ["read", "write"],
        });
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE users SET paid_tier = 'pro'
          WHERE id IN (${defaultUserId}, ${otherUserId})
        `;
        const ownerClient = yield* ApiHarnessClient;
        const otherClient = yield* OtherApiClient;
        yield* ownerClient.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000e003"),
        });
        yield* otherClient.ingestion.submitForExtraction({
          payload: {
            ...statementPayload("f1d1a000-0000-4000-8000-00000000e004"),
            file: {
              name: "other.csv",
              declaredMediaType: "text/csv",
              contentBase64: Base64FileContent.make(
                Encoding.encodeBase64("Date,Amount,Description,Type\n2020-02-05,999,Other,DEBIT\n")
              ),
            },
          },
        });
        yield* processNextStatement();
        yield* processNextStatement();

        const ownerTransactions = yield* ownerClient.transactions.listTransactions({ query: {} });
        const otherTransactions = yield* otherClient.transactions.listTransactions({ query: {} });
        expect(ownerTransactions.data).toHaveLength(1);
        expect(otherTransactions.data).toHaveLength(1);
        expect(
          BigDecimal.equals(
            Option.getOrThrow(Option.fromUndefinedOr(ownerTransactions.data[0])).money.amount,
            BigDecimal.fromStringUnsafe("25000")
          )
        ).toBe(true);
        expect(
          BigDecimal.equals(
            Option.getOrThrow(Option.fromUndefinedOr(otherTransactions.data[0])).money.amount,
            BigDecimal.fromStringUnsafe("999")
          )
        ).toBe(true);
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id IN (${defaultUserId}, ${otherUserId})`;
      })
    );

    it.effect("skips stale queue work before processing an owning submission", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${defaultUserId}`;
        const staleId = StatementSubmissionId.make("f1d1a000-0000-4000-8000-00000000e003");
        const queue = yield* statementIngestionQueue;
        yield* queue.offer(
          { submissionId: staleId, userId: defaultUserId, revision: 1 },
          { id: staleId }
        );
        const client = yield* ApiHarnessClient;
        const submitted = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000e004"),
        });

        expect(yield* processNextStatement()).toBe(true);

        const status = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({ status: "completed" });
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${defaultUserId}`;
      })
    );

    it.effect("rejects queue metadata that mismatches its payload submission", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${defaultUserId}`;
        const client = yield* ApiHarnessClient;
        const submitted = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000e006"),
        });
        const mismatchedId = StatementSubmissionId.make("f1d1a000-0000-4000-8000-00000000e007");
        yield* sql`
          UPDATE fidy_durable.fidy_queue
          SET id = ${mismatchedId}
          WHERE queue_name = 'statement-ingestion' AND id = ${submitted.data.id}
        `;

        expect(yield* processNextStatement()).toBe(false);

        const status = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({ status: "queued" });
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${defaultUserId}`;
      })
    );

    it.effect("rejects queue routing metadata that mismatches the submission User", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        yield* seedConsentedPatIdentity({
          userId: otherUserId,
          bearer: otherBearer,
          tokenId: otherTokenId,
          scopes: ["read", "write"],
        });
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${defaultUserId}`;
        const ownerClient = yield* ApiHarnessClient;
        const submitted = yield* ownerClient.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000e005"),
        });
        yield* sql`
          UPDATE fidy_durable.fidy_queue
          SET element = json_build_object(
            'submissionId', ${submitted.data.id}::text,
            'userId', ${otherUserId}::text,
            'revision', 1
          )::text
          WHERE queue_name = 'statement-ingestion' AND id = ${submitted.data.id}
        `;

        yield* processNextStatement();

        const status = yield* ownerClient.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({ status: "queued" });
        const effects = yield* sql`
          SELECT
            (SELECT count(*)::int FROM transactions) AS transactions,
            (SELECT count(*)::int FROM needs_review_items) AS reviews,
            (SELECT attempts FROM fidy_durable.fidy_queue
              WHERE queue_name = 'statement-ingestion' AND id = ${submitted.data.id})
              AS queue_attempts
        `;
        expect(effects).toEqual([{ transactions: 0, reviews: 0, queue_attempts: 1 }]);
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${defaultUserId}`;
      })
    );
  }
);

layer(WorkerHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "statement ingestion worker",
  (it) => {
    it.effect("deletes bytes and exposes a safe terminal parser failure", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const sql = yield* MigrationSqlClient;
        const client = yield* ApiHarnessClient;
        const submitted = yield* client.ingestion.submitForExtraction({
          payload: {
            idempotencyKey: StatementIdempotencyKey.make("f1d1a000-0000-4000-8000-00000000c193"),
            file: {
              name: "broken.csv",
              declaredMediaType: "text/csv",
              contentBase64: Base64FileContent.make(Encoding.encodeBase64(Uint8Array.from([0xff]))),
            },
          },
        });
        yield* processNextStatement();

        const status = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({ status: "failed", failureReason: "malformed-file" });
        const effects = yield* sql`
          SELECT
            (SELECT file_content IS NULL FROM statement_submissions WHERE id = ${submitted.data.id}) AS "bytesDeleted",
            (SELECT count(*)::int FROM transactions) AS transactions,
            (SELECT count(*)::int FROM source_attestations) AS attestations,
            (SELECT count(*)::int FROM statement_format_profiles) AS mappings,
            (SELECT count(*)::int FROM needs_review_items) AS reviews
        `;
        expect(effects).toEqual([
          { bytesDeleted: true, transactions: 0, attestations: 0, mappings: 0, reviews: 0 },
        ]);
        const empty = yield* client.ingestion.submitForExtraction({
          payload: {
            idempotencyKey: StatementIdempotencyKey.make("f1d1a000-0000-4000-8000-00000000c197"),
            file: {
              name: "empty.csv",
              declaredMediaType: "text/csv",
              contentBase64: Base64FileContent.make(
                Encoding.encodeBase64("Date,Amount,Description,Type\n")
              ),
            },
          },
        });
        yield* completeSubmissionInScope({
          userId: defaultUserId,
          id: empty.data.id,
          accounting: { inputRows: 0, acceptedRows: 0, needsReviewRows: 0 },
          completedAt: yield* DateTime.now,
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const emptyStatus = yield* client.ingestion.getStatementSubmission({
          params: { id: empty.data.id },
        });
        expect(emptyStatus.data).toMatchObject({
          status: "completed",
          accounting: { inputRows: 0, acceptedRows: 0, needsReviewRows: 0 },
        });
        const useful = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c200"),
        });
        expect(useful.data).toMatchObject({ status: "queued" });
        yield* sql`
          UPDATE statement_backfill_entitlements SET submission_id = NULL
          WHERE user_id = ${defaultUserId}
        `;
        yield* sql`DELETE FROM statement_submissions WHERE id = ${useful.data.id}`;
      })
    );

    it.effect("expires stale queued bytes independently of successful processing", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const sql = yield* MigrationSqlClient;
        const client = yield* ApiHarnessClient;
        const submitted = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c194"),
        });
        yield* sql`
          UPDATE statement_submissions
          SET submitted_at = now() - interval '25 hours'
          WHERE id = ${submitted.data.id}
        `;

        yield* processNextStatement();
        const status = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({
          status: "failed",
          failureReason: "retention-expired",
        });
        const stored = yield* sql`
          SELECT file_content AS "fileContent" FROM statement_submissions
          WHERE id = ${submitted.data.id}
        `;
        expect(stored).toEqual([{ fileContent: null }]);
        const replacement = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c198"),
        });
        expect(replacement.data).toMatchObject({ status: "queued" });
        yield* sql`
          UPDATE statement_backfill_entitlements SET submission_id = NULL
          WHERE user_id = ${defaultUserId}
        `;
        yield* sql`DELETE FROM statement_submissions WHERE id = ${replacement.data.id}`;
      })
    );

    it.effect("reuses one format mapping and finalizes each file atomically", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${defaultUserId}`;
        const client = yield* ApiHarnessClient;
        const first = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c191"),
        });
        yield* processNextStatement();
        const second = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c192"),
        });
        yield* processNextStatement();

        const firstStatus = yield* client.ingestion.getStatementSubmission({
          params: { id: first.data.id },
        });
        const secondStatus = yield* client.ingestion.getStatementSubmission({
          params: { id: second.data.id },
        });
        expect(firstStatus.data).toMatchObject({
          status: "completed",
          accounting: { inputRows: 1, acceptedRows: 1, needsReviewRows: 0 },
        });
        expect(secondStatus.data).toMatchObject({
          status: "completed",
          accounting: { inputRows: 1, acceptedRows: 1, needsReviewRows: 0 },
        });
        const transactions = yield* client.transactions.listTransactions({ query: {} });
        expect(transactions.data).toHaveLength(2);
        const captured = Option.getOrThrow(Option.fromUndefinedOr(transactions.data[0]));
        const attestations = yield* client.transactions.listSourceAttestations({
          params: { id: captured.id },
        });
        expect(attestations.data[0]).toMatchObject({ kind: "statement-line" });
        expect(yield* getTransactionUserDecisions(captured.id)).toEqual({
          category: false,
          counterparty: false,
          notes: false,
        });
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${defaultUserId}`;
      })
    );

    it.effect("coordinates one accepted submission across independent runtime workers", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${defaultUserId}`;
        const active = yield* Ref.make(0);
        const maximumActive = yield* Ref.make(0);
        const calls = yield* Ref.make(0);
        const mapper = StatementColumnMapper.of({
          mapColumns: () =>
            Effect.gen(function* () {
              const current = yield* Ref.updateAndGet(active, increment);
              yield* Ref.update(maximumActive, maximumOf(current));
              yield* Ref.update(calls, increment);
              yield* Effect.sleep("200 millis");
              return mapping;
            }).pipe(Effect.ensuring(Ref.update(active, decrement))),
        });
        const client = yield* ApiHarnessClient;
        const submitted = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c202"),
        });
        const workerA = yield* Layer.build(Layer.fresh(independentWorker(mapper)));
        const workerB = yield* Layer.build(Layer.fresh(independentWorker(mapper)));
        yield* Effect.all(
          [
            processNextStatement().pipe(Effect.provide(workerA)),
            processNextStatement().pipe(Effect.provide(workerB)),
          ],
          { concurrency: "unbounded" }
        );
        expect(yield* Ref.get(calls)).toBe(1);
        expect(yield* Ref.get(maximumActive)).toBe(1);
        const status = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({ status: "completed" });
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${defaultUserId}`;
      })
    );

    it.effect("recovers a lease left by process loss after expiry", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${defaultUserId}`;
        const client = yield* ApiHarnessClient;
        const submitted = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c204"),
        });
        yield* sql`
          UPDATE fidy_durable.fidy_queue
          SET acquired_by = 'f1d1a000-0000-4000-8000-00000000dead',
              acquired_at = now() - interval '3 minutes'
          WHERE queue_name = 'statement-ingestion' AND id = ${submitted.data.id}
        `;
        const replacementContext = yield* Layer.build(
          Layer.fresh(independentWorker(SucceedingMapper))
        );

        yield* processNextStatement().pipe(Effect.provide(replacementContext));

        const status = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({ status: "completed" });
        yield* sql`UPDATE users SET paid_tier = 'free' WHERE id = ${defaultUserId}`;
      })
    );

    it.effect("releases interrupted work for a replacement runtime", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const entered = yield* Deferred.make<void>();
        const interruptedMapper = StatementColumnMapper.of({
          mapColumns: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const client = yield* ApiHarnessClient;
        const submitted = yield* client.ingestion.submitForExtraction({
          payload: statementPayload("f1d1a000-0000-4000-8000-00000000c203"),
        });
        const interruptedContext = yield* Layer.build(
          Layer.fresh(independentWorker(interruptedMapper))
        );
        const worker = yield* processNextStatement().pipe(
          Effect.provide(interruptedContext),
          Effect.forkChild
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(worker);
        const sql = yield* MigrationSqlClient;
        const released = yield* sql`
          SELECT attempts, completed, acquired_by IS NULL AS "released"
          FROM fidy_durable.fidy_queue
          WHERE queue_name = 'statement-ingestion' AND id = ${submitted.data.id}
        `;
        expect(released).toEqual([{ attempts: 0, completed: false, released: true }]);
        const replacementContext = yield* Layer.build(
          Layer.fresh(
            independentWorker(
              StatementColumnMapper.of({ mapColumns: () => Effect.succeed(mapping) })
            )
          )
        );
        yield* processNextStatement().pipe(Effect.provide(replacementContext));
        const status = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({ status: "completed" });
        const completed = yield* sql`
          SELECT attempts, completed FROM fidy_durable.fidy_queue
          WHERE queue_name = 'statement-ingestion' AND id = ${submitted.data.id}
        `;
        expect(completed).toEqual([{ attempts: 1, completed: true }]);
      })
    );
  }
);
