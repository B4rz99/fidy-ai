import { expect, layer } from "@effect/vitest";
import { BigDecimal, Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { type SqlClient } from "effect/unstable/sql";
import { PATId } from "~/core/tokens/reference";
import { IanaTimeZone } from "~/core/_shared/context";
import { Money } from "~/core/_shared/money";
import { BudgetId } from "~/core/budgets/reference";
import { MemoryText } from "~/core/memory/model";
import { UserId } from "~/core/identity/reference";
import { Base64FileContent, StatementIdempotencyKey } from "~/core/ingestion/model";
import { NeedsReviewItemId, StatementSubmissionId } from "~/core/ingestion/reference";
import { CategoryKeyword } from "~/core/categories/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { TransactionId } from "~/core/transactions/model";
import { type PatScope, TokenBearer } from "~/core/tokens/model";
import { NotFound } from "~/shell/_shared/errors";
import {
  type SuggestedOperationCaller,
  canCallOperation,
} from "~/shell/_shared/suggested-operations";
import {
  SuggestedOperation,
  type SuggestedOperation as SuggestedOperationValue,
} from "~/shell/_shared/response";
import { type OperationId, operationCatalog } from "~/shell/api";
import { AtomicBatchCallId } from "~/shell/operations/operations";
import { truncateDashboards } from "~/shell/dashboard/fixtures";
import { MigrationSqlClient } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { truncateInsights, weeklySummaryInput } from "~/shell/insights/fixtures";
import { truncateStatementIngestion } from "~/shell/ingestion/fixtures";
import { generateInsightEvent } from "~/shell/insights/repo";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";
import { type ApiCallFailure, type ApiClient, ApiHarness, makeApiClientLive } from "./api-harness";

type NavigableResponse = {
  readonly next: ReadonlyArray<SuggestedOperationValue>;
};

type SuggestedOperationProbe = (
  client: ApiClient,
  setupClient: ApiClient
) => Effect.Effect<ReadonlyArray<NavigableResponse>, ApiCallFailure, SqlClient.SqlClient>;

const absentId = TransactionId.make("f1d1a000-0000-4000-8000-00000000dead");
const absentBudgetId = BudgetId.make("f1d1a000-0000-4000-8000-00000000dea4");
const budgetCap = Money.make({
  amount: BigDecimal.fromStringUnsafe("1000000"),
  currency: "COP",
});

/**
 * One probe per canonical operation, keyed by the `OperationId` union derived
 * from `FidyApi`. Adding or renaming an operation makes this record fail to
 * compile until its success and useful declared-failure responses participate
 * in the guard.
 */
const probes: Record<OperationId, SuggestedOperationProbe> = {
  "identity.getCurrentUser": (client) =>
    Effect.map(client.identity.getCurrentUser(), (response) => [response]),

  "identity.updateUserPreferences": (client) =>
    Effect.map(
      client.identity.updateUserPreferences({
        payload: { locale: "es-CO", timeZone: IanaTimeZone.make("America/Bogota") },
      }),
      (response) => [response]
    ),

  "subscription.getUpgradeUrl": (client) =>
    Effect.map(client.subscription.getUpgradeUrl(), (response) => [response]),

  "budgets.createBudget": (client) =>
    Effect.map(
      client.budgets.createBudget({
        payload: { categoryId: categoryIds.restaurantes, cap: budgetCap },
      }),
      (response) => [response]
    ),

  "budgets.listBudgets": (client) =>
    Effect.map(client.budgets.listBudgets(), (response) => [response]),

  "budgets.getBudget": (client) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        client.budgets.getBudget({ params: { id: absentBudgetId } })
      );
      if (Result.isSuccess(result)) {
        return yield* Effect.die("expected the absent Budget to fail");
      }
      return [yield* Schema.decodeUnknownEffect(NotFound)(result.failure)];
    }),

  "budgets.updateBudget": (client) =>
    Effect.gen(function* () {
      const created = yield* client.budgets.createBudget({
        payload: { categoryId: categoryIds.restaurantes, cap: budgetCap },
      });
      const updated = yield* client.budgets.updateBudget({
        params: { id: created.data.id },
        payload: { categoryId: categoryIds.mercado, cap: budgetCap },
      });
      return [updated];
    }),

  "budgets.deleteBudget": (client) =>
    Effect.gen(function* () {
      const created = yield* client.budgets.createBudget({
        payload: { categoryId: categoryIds.restaurantes, cap: budgetCap },
      });
      return [yield* client.budgets.deleteBudget({ params: { id: created.data.id } })];
    }),

  "budgets.getBudgetStatus": (client) =>
    Effect.map(
      client.budgets.getBudgetStatus({
        query: { timeZone: IanaTimeZone.make("America/Bogota") },
      }),
      (response) => [response]
    ),

  "memory.remember": (client) =>
    Effect.map(
      client.memory.remember({ payload: { text: MemoryText.make("Contexto explícito") } }),
      (response) => [response]
    ),

  "memory.revise": (client) =>
    Effect.gen(function* () {
      const created = yield* client.memory.remember({
        payload: { text: MemoryText.make("Contexto antes") },
      });
      const revised = yield* client.memory.revise({
        params: { id: created.data.id },
        payload: { text: MemoryText.make("Contexto después") },
      });
      return [revised];
    }),

  "memory.forget": (client) =>
    Effect.gen(function* () {
      const created = yield* client.memory.remember({
        payload: { text: MemoryText.make("Contexto eliminable") },
      });
      const forgotten = yield* client.memory.forget({ params: { id: created.data.id } });
      return [forgotten];
    }),

  "memory.recall": (client) => Effect.map(client.memory.recall(), (response) => [response]),

  "ingestion.submitForExtraction": (client) =>
    Effect.map(
      client.ingestion.submitForExtraction({
        payload: {
          idempotencyKey: StatementIdempotencyKey.make("f1d1a000-0000-4000-8000-00000000dea2"),
          file: {
            name: "statement.csv",
            declaredMediaType: "text/csv",
            contentBase64: Base64FileContent.make("RGF0ZSxBbW91bnQKMjAyNi0wMS0wMSwxLjAw"),
          },
        },
      }),
      (response) => [response]
    ),

  "ingestion.getStatementSubmission": (client) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        client.ingestion.getStatementSubmission({
          params: { id: StatementSubmissionId.make("f1d1a000-0000-4000-8000-00000000dea3") },
        })
      );
      if (Result.isSuccess(result)) {
        return yield* Effect.die("expected the absent StatementSubmission to fail");
      }
      return [yield* Schema.decodeUnknownEffect(NotFound)(result.failure)];
    }),

  "ingestion.listNeedsReviewItems": (client) =>
    Effect.map(
      client.ingestion.listNeedsReviewItems({
        query: { offset: Option.none(), limit: Option.none() },
      }),
      (response) => [response]
    ),

  "ingestion.resolveNeedsReviewItem": (client) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        client.ingestion.resolveNeedsReviewItem({
          params: { id: NeedsReviewItemId.make("f1d1a000-0000-4000-8000-00000000dea1") },
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
      if (Result.isSuccess(result)) {
        return yield* Effect.die("expected the absent NeedsReviewItem to fail");
      }
      return [yield* Schema.decodeUnknownEffect(NotFound)(result.failure)];
    }),

  "categories.listCategories": (client) =>
    Effect.map(client.categories.listCategories(), (response) => [response]),

  "categories.listKeywordRules": (client) =>
    Effect.map(client.categories.listKeywordRules(), (response) => [response]),

  "categories.createKeywordRule": (client) =>
    Effect.map(
      client.categories.createKeywordRule({
        payload: {
          keyword: CategoryKeyword.make("probe-create"),
          categoryId: categoryIds.otros,
        },
      }),
      (response) => [response]
    ),

  "categories.updateKeywordRule": (client) =>
    Effect.gen(function* () {
      const created = yield* client.categories.createKeywordRule({
        payload: {
          keyword: CategoryKeyword.make("probe-update-before"),
          categoryId: categoryIds.otros,
        },
      });
      const updated = yield* client.categories.updateKeywordRule({
        params: { id: created.data.id },
        payload: {
          keyword: CategoryKeyword.make("probe-update-after"),
          categoryId: categoryIds.transporte,
        },
      });
      return [updated];
    }),

  "categories.deleteKeywordRule": (client) =>
    Effect.gen(function* () {
      const created = yield* client.categories.createKeywordRule({
        payload: {
          keyword: CategoryKeyword.make("probe-delete"),
          categoryId: categoryIds.otros,
        },
      });
      const deleted = yield* client.categories.deleteKeywordRule({
        params: { id: created.data.id },
      });
      return [deleted];
    }),

  "dashboard.getDashboard": (client) =>
    Effect.map(client.dashboard.getDashboard(), (response) => [response]),

  "dashboard.listDashboardCatalog": (client) =>
    Effect.map(client.dashboard.listDashboardCatalog(), (response) => [response]),

  "dashboard.applyDashboardEdit": (client) =>
    Effect.map(
      client.dashboard.applyDashboardEdit({
        payload: { op: "set-title", title: "Panel de prueba" },
      }),
      (response) => [response]
    ),

  "operations.executeAtomicBatch": (client) =>
    Effect.map(
      client.operations.executeAtomicBatch({
        payload: {
          calls: [
            {
              callId: AtomicBatchCallId.make("f1d1a000-0000-4000-8000-00000000ba71"),
              operation: "identity.updateUserPreferences",
              input: {
                payload: { locale: "es-CO", timeZone: IanaTimeZone.make("America/Bogota") },
              },
            },
          ],
        },
      }),
      (response) => [response]
    ),

  "transactions.createTransaction": (client) =>
    Effect.map(
      client.transactions.createTransaction({ payload: transactionPayload() }),
      (response) => [response]
    ),

  "transactions.listTransactions": (client) =>
    Effect.map(client.transactions.listTransactions({ query: {} }), (response) => [response]),

  "transactions.getTransaction": (client, setupClient) =>
    Effect.gen(function* () {
      const created = yield* setupClient.transactions.createTransaction({
        payload: transactionPayload(),
      });
      const succeeded = yield* client.transactions.getTransaction({
        params: { id: created.data.id },
      });
      const result = yield* Effect.result(
        client.transactions.getTransaction({ params: { id: absentId } })
      );
      if (Result.isSuccess(result)) {
        return yield* Effect.die("expected the absent Transaction to fail");
      }
      const notFound = yield* Schema.decodeUnknownEffect(NotFound)(result.failure);
      return [succeeded, notFound];
    }),

  "transactions.updateTransaction": (client) =>
    Effect.gen(function* () {
      const created = yield* client.transactions.createTransaction({
        payload: transactionPayload(),
      });
      const updated = yield* client.transactions.updateTransaction({
        params: { id: created.data.id },
        payload: { ...transactionPayload(), categoryId: categoryIds.otros },
      });
      return [updated];
    }),

  "transactions.deleteTransaction": (client) =>
    Effect.gen(function* () {
      const created = yield* client.transactions.createTransaction({
        payload: transactionPayload(),
      });
      const deleted = yield* client.transactions.deleteTransaction({
        params: { id: created.data.id },
      });
      return [deleted];
    }),

  "transactions.listSourceAttestations": (client, setupClient) =>
    Effect.gen(function* () {
      const created = yield* setupClient.transactions.createTransaction({
        payload: transactionPayload(),
      });
      const listed = yield* client.transactions.listSourceAttestations({
        params: { id: created.data.id },
      });
      return [listed];
    }),

  "insights.listPendingInsights": (client) =>
    Effect.gen(function* () {
      yield* generateInsightEvent(readOnlyUser, weeklySummaryInput());
      return [yield* client.insights.listPendingInsights()];
    }),

  "recurring.listRecurringSeries": (client) =>
    Effect.gen(function* () {
      return [yield* client.recurring.listRecurringSeries()];
    }),

  "recurring.detectRecurringSeries": (client) =>
    Effect.gen(function* () {
      return [yield* client.recurring.detectRecurringSeries()];
    }),

  "insights.markInsightDelivered": (client) =>
    Effect.gen(function* () {
      const insight = yield* generateInsightEvent(writeOnlyUser, weeklySummaryInput());
      return [
        yield* client.insights.markInsightDelivered({
          params: { id: insight.id },
          payload: {
            sentAt: DateTime.makeUnsafe("2026-08-09T23:00:08Z"),
            channel: "whatsapp",
            provider: "meta",
            providerMessageId: "wamid.suggested-operations",
          },
        }),
      ];
    }),

  "insights.markInsightRead": (client) =>
    Effect.gen(function* () {
      const insight = yield* generateInsightEvent(writeOnlyUser, weeklySummaryInput());
      return [yield* client.insights.markInsightRead({ params: { id: insight.id } })];
    }),

  "insights.dismissInsight": (client) =>
    Effect.gen(function* () {
      const insight = yield* generateInsightEvent(writeOnlyUser, weeklySummaryInput());
      return [yield* client.insights.dismissInsight({ params: { id: insight.id } })];
    }),
};

const strictEncoding = { errors: "all", onExcessProperty: "error" } as const;

const readOnlyUser = UserId.make("f1d1a000-0000-4000-8000-0000000005b1");
const readOnlyTokenId = PATId.make("f1d1a000-0000-4000-8000-0000000005b2");
const readOnlyBearer = TokenBearer.make("fin_readgrd1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const readOwnerWriterTokenId = PATId.make("f1d1a000-0000-4000-8000-0000000005b3");
const readOwnerWriterBearer = TokenBearer.make(
  "fin_readwrit_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const dashboardOnlyUser = UserId.make("f1d1a000-0000-4000-8000-0000000005c1");
const dashboardOnlyTokenId = PATId.make("f1d1a000-0000-4000-8000-0000000005c2");
const dashboardOnlyBearer = TokenBearer.make(
  "fin_dashgrd1_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const writeOnlyUser = UserId.make("f1d1a000-0000-4000-8000-0000000005a1");
const writeOnlyTokenId = PATId.make("f1d1a000-0000-4000-8000-0000000005a2");
const writeOnlyBearer = TokenBearer.make("fin_write001_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
class ReadOnlyApiClient extends Context.Service<ReadOnlyApiClient, ApiClient>()(
  "@fidy/server/shell/testing/suggested-operations.test/ReadOnlyApiClient"
) {}
class ReadOwnerWriterApiClient extends Context.Service<ReadOwnerWriterApiClient, ApiClient>()(
  "@fidy/server/shell/testing/suggested-operations.test/ReadOwnerWriterApiClient"
) {}
class WriteOnlyApiClient extends Context.Service<WriteOnlyApiClient, ApiClient>()(
  "@fidy/server/shell/testing/suggested-operations.test/WriteOnlyApiClient"
) {}
class DashboardOnlyApiClient extends Context.Service<DashboardOnlyApiClient, ApiClient>()(
  "@fidy/server/shell/testing/suggested-operations.test/DashboardOnlyApiClient"
) {}
const SuggestedOperationsHarness = Layer.mergeAll(
  makeApiClientLive({ tag: ReadOnlyApiClient, bearer: readOnlyBearer }),
  makeApiClientLive({ tag: ReadOwnerWriterApiClient, bearer: readOwnerWriterBearer }),
  makeApiClientLive({ tag: WriteOnlyApiClient, bearer: writeOnlyBearer }),
  makeApiClientLive({ tag: DashboardOnlyApiClient, bearer: dashboardOnlyBearer })
).pipe(Layer.provideMerge(ApiHarness));

layer(SuggestedOperationsHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "operation-derived SuggestedOperation guard",
  (it) => {
    it.effect("every returned SuggestedOperation names a callable canonical operation", () =>
      Effect.gen(function* () {
        yield* seedConsentedPatIdentity({
          userId: readOnlyUser,
          bearer: readOnlyBearer,
          tokenId: readOnlyTokenId,
          scopes: ["read"],
        });
        yield* seedConsentedPatIdentity({
          userId: readOnlyUser,
          bearer: readOwnerWriterBearer,
          tokenId: readOwnerWriterTokenId,
          scopes: ["write"],
        });
        yield* seedConsentedPatIdentity({
          userId: writeOnlyUser,
          bearer: writeOnlyBearer,
          tokenId: writeOnlyTokenId,
          scopes: ["write"],
        });
        yield* seedConsentedPatIdentity({
          userId: dashboardOnlyUser,
          bearer: dashboardOnlyBearer,
          tokenId: dashboardOnlyTokenId,
          scopes: ["dashboard"],
        });
        const clientsByScope: Record<PatScope, ApiClient> = {
          read: yield* ReadOnlyApiClient,
          write: yield* WriteOnlyApiClient,
          dashboard: yield* DashboardOnlyApiClient,
        };
        const readOwnerWriter = yield* ReadOwnerWriterApiClient;
        const catalogIds = operationCatalog.operations.map((operation) => operation.id).sort();

        expect(catalogIds).toEqual(Object.keys(probes).sort());

        let returnedSuggestedOperations = 0;
        for (const [sourceOperation, probe] of Object.entries(probes)) {
          yield* truncateTransactions;
          yield* truncateStatementIngestion;
          yield* truncateInsights;
          yield* truncateDashboards;
          const sql = yield* MigrationSqlClient;
          yield* sql`TRUNCATE budget_month_latches, budgets`;
          const source = Option.getOrThrow(
            Option.fromUndefinedOr(operationCatalog.byId.get(sourceOperation))
          );
          const sourceCaller: SuggestedOperationCaller = {
            scopes: [source.policy.requiredScope],
            tier: source.policy.requiredTier,
          };
          const responses = yield* probe(
            clientsByScope[source.policy.requiredScope],
            readOwnerWriter
          );

          for (const response of responses) {
            for (const suggestedOperation of response.next) {
              returnedSuggestedOperations += 1;
              expect(
                Result.isSuccess(
                  Schema.encodeUnknownResult(SuggestedOperation, strictEncoding)(suggestedOperation)
                ),
                `${sourceOperation} returned an invalid SuggestedOperation`
              ).toBe(true);

              const target = Option.getOrThrow(
                Option.fromUndefinedOr(operationCatalog.byId.get(suggestedOperation.tool))
              );
              expect(
                canCallOperation(target.policy, sourceCaller),
                `${sourceOperation} advertised unavailable ${suggestedOperation.tool}`
              ).toBe(true);
            }
          }
        }

        expect(returnedSuggestedOperations).toBeGreaterThan(0);
      })
    );

    it.effect("filters SuggestedOperations unavailable to the resolved caller", () =>
      Effect.gen(function* () {
        yield* seedConsentedPatIdentity({
          userId: writeOnlyUser,
          bearer: writeOnlyBearer,
          tokenId: writeOnlyTokenId,
          scopes: ["write"],
        });
        const client = yield* WriteOnlyApiClient;
        const response = yield* client.transactions.createTransaction({
          payload: transactionPayload(),
        });

        expect(response.next).toEqual([]);
      })
    );
  }
);
