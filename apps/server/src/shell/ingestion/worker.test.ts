import { expect, layer } from "@effect/vitest";
import {
  BigDecimal,
  Context,
  DateTime,
  Effect,
  Encoding,
  Layer,
  Option,
  Ref,
  Result,
} from "effect";
import { Currency } from "~/core/_shared/money";
import { UserId } from "~/core/identity/reference";
import {
  Base64FileContent,
  StatementColumnMapping,
  StatementIdempotencyKey,
  type SubmitForExtractionInput,
} from "~/core/ingestion/model";
import { TokenBearer } from "~/core/tokens/model";
import { PATId } from "~/core/tokens/reference";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultUserId, seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
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
import { processNextStatement } from "./worker";

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
const ReviewWorkerHarness = Layer.merge(
  ApiHarness,
  Layer.succeed(
    StatementColumnMapper,
    StatementColumnMapper.of({ mapColumns: () => Effect.succeed(mapping) })
  )
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

layer(FailingWorkerHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "statement mapping recovery",
  (it) => {
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
    it.effect("keeps interleaved claimed outcomes attributed to their owning Users", () =>
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
        const claimId = "f1d1a000-0000-4000-8000-00000000c201";
        yield* sql`
          UPDATE statement_submissions SET status = 'processing', claim_id = ${claimId},
            started_at = now(), attempt_count = 1
          WHERE id = ${empty.data.id}
        `;
        yield* withUserTransaction(
          defaultUserId,
          completeSubmissionInScope({
            userId: defaultUserId,
            id: empty.data.id,
            claimId,
            accounting: { inputRows: 0, acceptedRows: 0, needsReviewRows: 0 },
            completedAt: yield* DateTime.now,
          })
        );
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
  }
);
