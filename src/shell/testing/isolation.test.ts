import { expect, layer } from "@effect/vitest";
import { Context, DateTime, Effect, Layer } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { IanaTimeZone } from "~/core/_shared/context";
import { UserId } from "~/core/identity/reference";
import { CategoryKeyword } from "~/core/categories/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { type InsightEvent } from "~/core/insights/model";
import { type Transaction } from "~/core/transactions/model";
import { AgentBearerToken } from "~/core/tokens/model";
import type { OperationId } from "~/shell/api";
import { truncateInsights, weeklySummaryInput } from "~/shell/insights/fixtures";
import { generateInsightEvent } from "~/shell/insights/repo";
import { AtomicBatchCallId } from "~/shell/operations/operations";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";
import {
  type ApiCallFailure,
  type ApiClient,
  ApiHarness,
  headersFor,
  makeApiClientLive,
} from "./api-harness";
import { truncateDashboards } from "~/shell/dashboard/fixtures";
import { seedConsentedAgentIdentity } from "~/shell/db/development-seed";
import { publishedOperationIds } from "./openapi";

const owner = UserId.make("f1d1a000-0000-4000-8000-0000000000a1");
const stranger = UserId.make("f1d1a000-0000-4000-8000-0000000000b2");
const ownerBearer = AgentBearerToken.make("fin_owner001_0123456789abcdefghijklmnopqrstuvwxyzABCD");
const strangerBearer = AgentBearerToken.make(
  "fin_strange1_ABCDabcdefghijklmnopqrstuvwxyz0123456789"
);

class OwnerApiClient extends Context.Service<OwnerApiClient, ApiClient>()(
  "fidy-ai/shell/testing/isolation.test/OwnerApiClient"
) {}

class StrangerApiClient extends Context.Service<StrangerApiClient, ApiClient>()(
  "fidy-ai/shell/testing/isolation.test/StrangerApiClient"
) {}

const IsolationHarness = Layer.merge(
  makeApiClientLive({ tag: OwnerApiClient, bearer: ownerBearer }),
  makeApiClientLive({ tag: StrangerApiClient, bearer: strangerBearer })
).pipe(Layer.provideMerge(ApiHarness));

/**
 * What one operation, invoked by a stranger, is handed: a client for each user
 * and the transaction the owner already logged.
 */
type IsolationAttempt = {
  readonly ownerClient: ApiClient;
  readonly strangerClient: ApiClient;
  readonly ownedTransaction: Transaction;
  readonly ownedInsight: InsightEvent;
};

type IsolationProbe = (
  attempt: IsolationAttempt
) => Effect.Effect<void, ApiCallFailure, HttpClient.HttpClient>;

/**
 * One probe per canonical operation: invoke it as the stranger, then assert the
 * owner's transaction is neither visible in the answer nor changed by it.
 *
 * Keyed by `OperationId`, which is derived from the assembled `HttpApi`, so an
 * operation added without a probe fails to compile here, and the test below
 * catches the runtime case — a published operation this union never heard of.
 */
const probes: Record<OperationId, IsolationProbe> = {
  "identity.getCurrentUser": (attempt) =>
    Effect.gen(function* () {
      const current = yield* attempt.strangerClient.identity.getCurrentUser();

      expect(current.data.id).toBe(stranger);
      expect(current.data.id).not.toBe(owner);
    }),

  "identity.updateUserPreferences": (attempt) =>
    Effect.gen(function* () {
      const updated = yield* attempt.strangerClient.identity.updateUserPreferences({
        payload: {
          locale: "es-CO",
          timeZone: IanaTimeZone.make("America/New_York"),
        },
      });
      const ownersUser = yield* attempt.ownerClient.identity.getCurrentUser();

      expect(updated.data.id).toBe(stranger);
      expect(updated.data.timeZone).toBe("America/New_York");
      expect(ownersUser.data.timeZone).toBe("America/Bogota");
    }),

  "categories.listCategories": (attempt) =>
    Effect.gen(function* () {
      const listed = yield* attempt.strangerClient.categories.listCategories({});
      expect(listed.data).toHaveLength(16);
    }),

  "categories.listKeywordRules": (attempt) =>
    Effect.gen(function* () {
      const listed = yield* attempt.strangerClient.categories.listKeywordRules({});
      expect(listed.data).toEqual([]);
    }),

  "categories.createKeywordRule": (attempt) =>
    Effect.gen(function* () {
      yield* attempt.strangerClient.categories.createKeywordRule({
        payload: {
          keyword: CategoryKeyword.make("privado"),
          categoryId: categoryIds.otros,
        },
      });
      const owners = yield* attempt.ownerClient.categories.listKeywordRules({});
      expect(owners.data).toEqual([]);
    }),

  "categories.updateKeywordRule": (attempt) =>
    Effect.gen(function* () {
      const ownerRule = yield* attempt.ownerClient.categories.createKeywordRule({
        payload: {
          keyword: CategoryKeyword.make("dueño"),
          categoryId: categoryIds.mercado,
        },
      });
      const denied = yield* Effect.result(
        attempt.strangerClient.categories.updateKeywordRule({
          params: { id: ownerRule.data.id },
          payload: {
            keyword: CategoryKeyword.make("intruso"),
            categoryId: categoryIds.otros,
          },
        })
      );
      const retained = yield* attempt.ownerClient.categories.listKeywordRules({});
      expect(denied).toMatchObject({ _tag: "Failure", failure: { error: { code: "not_found" } } });
      expect(retained.data).toEqual([ownerRule.data]);
    }),

  "dashboard.getDashboard": (attempt) =>
    Effect.gen(function* () {
      const strangers = yield* attempt.strangerClient.dashboard.getDashboard();
      const owners = yield* attempt.ownerClient.dashboard.getDashboard();

      expect(strangers.data.title).toBe("Mi tablero");
      expect(owners.data.title).toBe("Panel privado del dueño");
    }),

  "dashboard.listDashboardCatalog": (attempt) =>
    Effect.gen(function* () {
      const strangers = yield* attempt.strangerClient.dashboard.listDashboardCatalog();
      const owners = yield* attempt.ownerClient.dashboard.listDashboardCatalog();

      expect(strangers.data).toEqual(owners.data);
      expect(strangers.data).toHaveLength(4);
    }),

  "dashboard.applyDashboardEdit": (attempt) =>
    Effect.gen(function* () {
      yield* attempt.strangerClient.dashboard.applyDashboardEdit({
        payload: { op: "set-title", title: "Panel del extraño" },
      });
      const owners = yield* attempt.ownerClient.dashboard.getDashboard();

      expect(owners.data.title).toBe("Panel privado del dueño");
    }),

  "categories.deleteKeywordRule": (attempt) =>
    Effect.gen(function* () {
      const ownerRule = yield* attempt.ownerClient.categories.createKeywordRule({
        payload: {
          keyword: CategoryKeyword.make("conservar"),
          categoryId: categoryIds.mercado,
        },
      });
      const denied = yield* Effect.result(
        attempt.strangerClient.categories.deleteKeywordRule({ params: { id: ownerRule.data.id } })
      );
      const retained = yield* attempt.ownerClient.categories.listKeywordRules({});
      expect(denied).toMatchObject({ _tag: "Failure", failure: { error: { code: "not_found" } } });
      expect(retained.data).toEqual([ownerRule.data]);
    }),

  "transactions.listTransactions": (attempt) =>
    Effect.gen(function* () {
      const listed = yield* attempt.strangerClient.transactions.listTransactions({ query: {} });

      expect(listed.data).toEqual([]);
    }),

  "insights.listPendingInsights": (attempt) =>
    Effect.gen(function* () {
      const listed = yield* attempt.strangerClient.insights.listPendingInsights();

      expect(listed.data).toEqual([]);
    }),

  "insights.markInsightDelivered": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.insights.markInsightDelivered({
          params: { id: attempt.ownedInsight.id },
          payload: {
            sentAt: DateTime.makeUnsafe("2026-08-09T23:00:08Z"),
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "wamid.stranger-attempt",
          },
        })
      );

      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      expect((yield* attempt.ownerClient.insights.listPendingInsights()).data).toEqual([
        attempt.ownedInsight,
      ]);
    }),

  "insights.markInsightRead": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.insights.markInsightRead({
          params: { id: attempt.ownedInsight.id },
        })
      );

      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      expect((yield* attempt.ownerClient.insights.listPendingInsights()).data).toEqual([
        attempt.ownedInsight,
      ]);
    }),

  "insights.dismissInsight": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.insights.dismissInsight({
          params: { id: attempt.ownedInsight.id },
        })
      );

      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      expect((yield* attempt.ownerClient.insights.listPendingInsights()).data).toEqual([
        attempt.ownedInsight,
      ]);
    }),

  "transactions.createTransaction": (attempt) =>
    Effect.gen(function* () {
      yield* attempt.strangerClient.transactions.createTransaction({
        payload: transactionPayload({ counterparty: "Rappi" }),
      });

      // The owner is context, not a field, so the payload has no `userId` for
      // the typed client to send. Naming one over raw HTTP is accepted — and
      // ignored: the row belongs to whoever called, not to whoever was named.
      const forged = yield* HttpClient.post("/transactions", {
        headers: headersFor(strangerBearer),
        body: HttpBody.jsonUnsafe({
          money: { amount: "8000", currency: "COP" },
          counterparty: "Tostao",
          direction: "outflow",
          occurredAt: "2026-07-21T09:00:00Z",
          userId: owner,
        }),
      });

      expect(forged.status).toBe(201);

      const ownersHistory = yield* attempt.ownerClient.transactions.listTransactions({ query: {} });
      const strangersHistory = yield* attempt.strangerClient.transactions.listTransactions({
        query: {},
      });

      expect(ownersHistory.data).toEqual([attempt.ownedTransaction]);
      expect(strangersHistory.data).toHaveLength(2);
    }),

  "transactions.updateTransaction": (attempt) =>
    Effect.gen(function* () {
      const { createdAt: _createdAt, id: _id, ...payload } = attempt.ownedTransaction;
      const denied = yield* Effect.result(
        attempt.strangerClient.transactions.updateTransaction({
          params: { id: attempt.ownedTransaction.id },
          payload,
        })
      );
      const retained = yield* attempt.ownerClient.transactions.getTransaction({
        params: { id: attempt.ownedTransaction.id },
      });
      expect(denied).toMatchObject({ _tag: "Failure", failure: { error: { code: "not_found" } } });
      expect(retained.data).toEqual(attempt.ownedTransaction);
    }),

  "transactions.deleteTransaction": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.transactions.deleteTransaction({
          params: { id: attempt.ownedTransaction.id },
        })
      );
      const retained = yield* attempt.ownerClient.transactions.getTransaction({
        params: { id: attempt.ownedTransaction.id },
      });
      expect(denied).toMatchObject({ _tag: "Failure", failure: { error: { code: "not_found" } } });
      expect(retained.data).toEqual(attempt.ownedTransaction);
    }),

  "transactions.listSourceAttestations": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.transactions.listSourceAttestations({
          params: { id: attempt.ownedTransaction.id },
        })
      );
      expect(denied).toMatchObject({ _tag: "Failure", failure: { error: { code: "not_found" } } });
    }),

  "transactions.getTransaction": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.transactions.getTransaction({
          params: { id: attempt.ownedTransaction.id },
        })
      );

      // The same answer an id that never existed gets, so asking cannot be used
      // to discover which ids are real.
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });

      const owners = yield* attempt.ownerClient.transactions.getTransaction({
        params: { id: attempt.ownedTransaction.id },
      });

      expect(owners.data).toEqual(attempt.ownedTransaction);
    }),

  "operations.executeAtomicBatch": (attempt) =>
    Effect.gen(function* () {
      yield* attempt.strangerClient.operations.executeAtomicBatch({
        payload: {
          calls: [
            {
              callId: AtomicBatchCallId.make("f1d1a000-0000-4000-8000-0000000000b3"),
              operation: "categories.createKeywordRule",
              input: {
                payload: {
                  keyword: CategoryKeyword.make("solo extraño"),
                  categoryId: categoryIds.otros,
                },
              },
            },
          ],
        },
      });
      const owners = yield* attempt.ownerClient.categories.listKeywordRules({});
      expect(owners.data).toEqual([]);
    }),
};

const seedAttempt = Effect.gen(function* () {
  yield* seedConsentedAgentIdentity({
    userId: owner,
    bearer: ownerBearer,
  });
  yield* seedConsentedAgentIdentity({
    userId: stranger,
    bearer: strangerBearer,
  });

  const ownerClient = yield* OwnerApiClient;
  const strangerClient = yield* StrangerApiClient;
  const created = yield* ownerClient.transactions.createTransaction({
    payload: transactionPayload(),
  });
  const ownedInsight = yield* generateInsightEvent(owner, weeklySummaryInput());
  yield* ownerClient.dashboard.applyDashboardEdit({
    payload: { op: "set-title", title: "Panel privado del dueño" },
  });

  return { ownerClient, strangerClient, ownedTransaction: created.data, ownedInsight };
});

layer(IsolationHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "per-user isolation",
  (it) => {
    it.effect("every canonical operation the server publishes is probed here", () =>
      Effect.gen(function* () {
        const published = yield* publishedOperationIds;

        expect([...published].sort()).toEqual(Object.keys(probes).sort());
      })
    );

    for (const [operation, probe] of Object.entries(probes)) {
      it.effect(`${operation} exposes nothing of another user's to its caller`, () =>
        Effect.gen(function* () {
          yield* truncateInsights;
          yield* truncateTransactions;
          yield* truncateDashboards;
          const attempt = yield* seedAttempt;

          yield* probe(attempt);
        })
      );
    }
  }
);
