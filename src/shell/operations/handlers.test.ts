import { expect, layer } from "@effect/vitest";
import { Effect, Option } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { CategoryKeyword } from "~/core/categories/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { TransactionId } from "~/core/transactions/model";
import { truncateAuditLogEntries } from "~/shell/audit/fixtures";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness, ApiHarnessClient, headersFor } from "~/shell/testing/api-harness";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import { AtomicBatchCallId, maximumAtomicBatchCalls } from "./operations";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "atomic mutation batch",
  (it) => {
    it.effect("commits ordered Category and Transaction mutations together", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        yield* truncateAuditLogEntries;
        const client = yield* ApiHarnessClient;

        const batch = yield* client.operations.executeAtomicBatch({
          payload: {
            calls: [
              {
                callId: AtomicBatchCallId.make("f1d1a000-0000-4000-8000-000000000101"),
                operation: "categories.createKeywordRule",
                input: {
                  payload: {
                    keyword: CategoryKeyword.make("Rappi"),
                    categoryId: categoryIds.domicilios,
                  },
                },
              },
              {
                callId: AtomicBatchCallId.make("f1d1a000-0000-4000-8000-000000000102"),
                operation: "transactions.createTransaction",
                input: {
                  payload: transactionPayload({
                    counterparty: "Rappi Turbo",
                    categoryId: Option.none(),
                  }),
                },
              },
            ],
          },
        });

        const rules = yield* client.categories.listKeywordRules({});
        const transactions = yield* client.transactions.listTransactions({ query: {} });

        expect(batch.data.results.map(({ operation }) => operation)).toEqual([
          "categories.createKeywordRule",
          "transactions.createTransaction",
        ]);
        expect(rules.data).toHaveLength(1);
        expect(transactions.data).toHaveLength(1);
        expect(transactions.data[0]?.categoryId).toBe(categoryIds.domicilios);
      })
    );

    it.effect("rolls back every database effect and retains indexed child audit evidence", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        yield* truncateAuditLogEntries;
        const client = yield* ApiHarnessClient;

        const failed = yield* Effect.result(
          client.operations.executeAtomicBatch({
            payload: {
              calls: [
                {
                  callId: AtomicBatchCallId.make("f1d1a000-0000-4000-8000-000000000201"),
                  operation: "categories.createKeywordRule",
                  input: {
                    payload: {
                      keyword: CategoryKeyword.make("rollback"),
                      categoryId: categoryIds.otros,
                    },
                  },
                },
                {
                  callId: AtomicBatchCallId.make("f1d1a000-0000-4000-8000-000000000202"),
                  operation: "transactions.deleteTransaction",
                  input: {
                    params: {
                      id: TransactionId.make("f1d1a000-0000-4000-8000-00000000dead"),
                    },
                  },
                },
              ],
            },
          })
        );

        const rules = yield* client.categories.listKeywordRules({});
        const audit = yield* observeAuditLogEntries(defaultUserId);

        expect(failed).toMatchObject({
          _tag: "Failure",
          failure: {
            error: {
              code: "not_found",
              failedCallIndex: 1,
              operation: "transactions.deleteTransaction",
            },
          },
        });
        expect(rules.data).toEqual([]);
        expect(audit).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              operation: "categories.createKeywordRule",
              outcome: "failed",
            }),
            expect.objectContaining({
              operation: "transactions.deleteTransaction",
              outcome: "failed",
            }),
          ])
        );
      })
    );

    it.effect("rejects oversized, query, and nested children at the public API boundary", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const validCall = {
          callId: "f1d1a000-0000-4000-8000-000000000401",
          operation: "transactions.createTransaction",
          input: { payload: transactionPayload({ counterparty: "Must not be stored" }) },
        };
        const payloads = [
          {
            calls: Array.from({ length: maximumAtomicBatchCalls + 1 }, () => validCall),
          },
          {
            calls: [
              {
                callId: "f1d1a000-0000-4000-8000-000000000402",
                operation: "transactions.listTransactions",
                input: { query: {} },
              },
            ],
          },
          {
            calls: [
              {
                callId: "f1d1a000-0000-4000-8000-000000000403",
                operation: "operations.executeAtomicBatch",
                input: { payload: { calls: [validCall] } },
              },
            ],
          },
        ];

        const responses = yield* Effect.forEach(payloads, (payload) =>
          HttpClient.post("/operations/atomic-batch", {
            headers: headersFor(defaultAgentBearer),
            body: HttpBody.jsonUnsafe(payload),
          })
        );
        const client = yield* ApiHarnessClient;
        const transactions = yield* client.transactions.listTransactions({ query: {} });

        expect(responses.map(({ status }) => status)).toEqual([400, 400, 400]);
        expect(transactions.data).toEqual([]);
      })
    );
  }
);
