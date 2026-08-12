import { expect, layer } from "@effect/vitest";
import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { type SqlClient } from "effect/unstable/sql";
import { AgentTokenId } from "~/core/tokens/reference";
import { IanaTimeZone } from "~/core/_shared/context";
import { MemoryText } from "~/core/memory/model";
import { UserId } from "~/core/identity/reference";
import { CategoryKeyword } from "~/core/categories/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { TransactionId } from "~/core/transactions/model";
import { AgentBearerToken, type AgentScope } from "~/core/tokens/model";
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
import { seedConsentedAgentIdentity } from "~/shell/db/development-seed";
import { truncateInsights, weeklySummaryInput } from "~/shell/insights/fixtures";
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

  "memory.remember": (client) =>
    Effect.map(
      client.memory.remember({ payload: { text: MemoryText.make("Contexto explícito") } }),
      (response) => [response]
    ),

  "memory.recall": (client) => Effect.map(client.memory.recall(), (response) => [response]),

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
const readOnlyTokenId = AgentTokenId.make("f1d1a000-0000-4000-8000-0000000005b2");
const readOnlyBearer = AgentBearerToken.make(
  "fin_readgrd1_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const readOwnerWriterTokenId = AgentTokenId.make("f1d1a000-0000-4000-8000-0000000005b3");
const readOwnerWriterBearer = AgentBearerToken.make(
  "fin_readwrit_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const dashboardOnlyUser = UserId.make("f1d1a000-0000-4000-8000-0000000005c1");
const dashboardOnlyTokenId = AgentTokenId.make("f1d1a000-0000-4000-8000-0000000005c2");
const dashboardOnlyBearer = AgentBearerToken.make(
  "fin_dashgrd1_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const writeOnlyUser = UserId.make("f1d1a000-0000-4000-8000-0000000005a1");
const writeOnlyTokenId = AgentTokenId.make("f1d1a000-0000-4000-8000-0000000005a2");
const writeOnlyBearer = AgentBearerToken.make(
  "fin_write001_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
class ReadOnlyApiClient extends Context.Service<ReadOnlyApiClient, ApiClient>()(
  "fidy-ai/shell/testing/suggested-operations.test/ReadOnlyApiClient"
) {}
class ReadOwnerWriterApiClient extends Context.Service<ReadOwnerWriterApiClient, ApiClient>()(
  "fidy-ai/shell/testing/suggested-operations.test/ReadOwnerWriterApiClient"
) {}
class WriteOnlyApiClient extends Context.Service<WriteOnlyApiClient, ApiClient>()(
  "fidy-ai/shell/testing/suggested-operations.test/WriteOnlyApiClient"
) {}
class DashboardOnlyApiClient extends Context.Service<DashboardOnlyApiClient, ApiClient>()(
  "fidy-ai/shell/testing/suggested-operations.test/DashboardOnlyApiClient"
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
        yield* seedConsentedAgentIdentity({
          userId: readOnlyUser,
          bearer: readOnlyBearer,
          tokenId: readOnlyTokenId,
          scopes: ["read"],
        });
        yield* seedConsentedAgentIdentity({
          userId: readOnlyUser,
          bearer: readOwnerWriterBearer,
          tokenId: readOwnerWriterTokenId,
          scopes: ["write"],
        });
        yield* seedConsentedAgentIdentity({
          userId: writeOnlyUser,
          bearer: writeOnlyBearer,
          tokenId: writeOnlyTokenId,
          scopes: ["write"],
        });
        yield* seedConsentedAgentIdentity({
          userId: dashboardOnlyUser,
          bearer: dashboardOnlyBearer,
          tokenId: dashboardOnlyTokenId,
          scopes: ["dashboard"],
        });
        const clientsByScope: Record<AgentScope, ApiClient> = {
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
          yield* truncateInsights;
          yield* truncateDashboards;
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
        yield* seedConsentedAgentIdentity({
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
