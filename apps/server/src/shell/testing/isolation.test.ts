import { expect, layer } from "@effect/vitest";
import { BigDecimal, Context, DateTime, Effect, Equal, Layer, Option } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { IanaTimeZone } from "~/core/_shared/context";
import { Money } from "~/core/_shared/money";
import { type Budget } from "~/core/budgets/model";
import { BudgetId } from "~/core/budgets/reference";
import { EmailAddress } from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { Base64FileContent, StatementIdempotencyKey } from "~/core/ingestion/model";
import { NeedsReviewItemId, type StatementSubmissionId } from "~/core/ingestion/reference";
import { CategoryKeyword } from "~/core/categories/model";
import { categoryIds } from "~/core/categories/taxonomy";
import { type InsightEvent } from "~/core/insights/model";
import {
  BudgetBarWidget,
  CustomMetricWidget,
  TransactionListLimit,
  TransactionListWidget,
  WidgetId,
} from "~/core/dashboard/model";
import { type Transaction } from "~/core/transactions/model";
import { ManualPATRequestId, PATRecipientLabel, TokenBearer } from "~/core/tokens/model";
import { PATPairingId } from "~/core/tokens/pairing";
import type { OperationId } from "~/shell/api";
import { truncateInsights, weeklySummaryInput } from "~/shell/insights/fixtures";
import { truncateStatementIngestion } from "~/shell/ingestion/fixtures";
import { generateInsightEvent } from "~/shell/insights/repo";
import { MemoryId, MemoryText } from "~/core/memory/model";
import { truncateMemories } from "~/shell/memory/fixtures";
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
import { MigrationSqlClient } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { publishedOperationIds } from "./openapi";

const owner = UserId.make("f1d1a000-0000-4000-8000-0000000000a1");
const stranger = UserId.make("f1d1a000-0000-4000-8000-0000000000b2");
const ownerBearer = TokenBearer.make("fin_owner001_0123456789abcdefghijklmnopqrstuvwxyzABCD");
const strangerBearer = TokenBearer.make("fin_strange1_ABCDabcdefghijklmnopqrstuvwxyz0123456789");
const absentMemoryId = MemoryId.make("f1d1a000-0000-4000-8000-00000000dead");
const absentBudgetId = BudgetId.make("f1d1a000-0000-4000-8000-00000000dea4");
const budgetCap = Money.make({
  amount: BigDecimal.fromStringUnsafe("1000000"),
  currency: "COP",
});

const expectSameBudget = (actual: Budget, expected: Budget): void => {
  expect(actual.id).toBe(expected.id);
  expect(actual.categoryId).toBe(expected.categoryId);
  expect(actual.cap.currency).toBe(expected.cap.currency);
  expect(Equal.equals(actual.cap.amount, expected.cap.amount)).toBe(true);
};

class OwnerApiClient extends Context.Service<OwnerApiClient, ApiClient>()(
  "@fidy/server/shell/testing/isolation.test/OwnerApiClient"
) {}

class StrangerApiClient extends Context.Service<StrangerApiClient, ApiClient>()(
  "@fidy/server/shell/testing/isolation.test/StrangerApiClient"
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
  readonly ownedBudget: Budget;
  readonly ownedInsight: InsightEvent;
  readonly ownedStatementSubmissionId: StatementSubmissionId;
  readonly ownedReviewItemId: NeedsReviewItemId;
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
  "browserLogin.approvePairing": (attempt) =>
    Effect.result(
      attempt.strangerClient.browserLogin.approvePairing({ payload: { publicCode: "BCDF-GHJK" } })
    ).pipe(Effect.asVoid),

  "pats.createManualPAT": (attempt) =>
    Effect.result(
      attempt.strangerClient.pats.createManualPAT({
        payload: {
          requestId: ManualPATRequestId.make("f1d1a000-0000-4000-8000-000000000252"),
          grant: {
            recipientLabel: PATRecipientLabel.make("Denied PAT"),
            scopes: ["read"],
            lifetimeDays: 90,
          },
        },
      })
    ).pipe(Effect.asVoid),

  "pats.inspectPATPairing": (attempt) =>
    Effect.result(
      attempt.strangerClient.pats.inspectPATPairing({ payload: { publicCode: "BCDF-GHJK" } })
    ).pipe(Effect.asVoid),

  "pats.approvePATPairing": (attempt) =>
    Effect.result(
      attempt.strangerClient.pats.approvePATPairing({
        payload: {
          pairingId: PATPairingId.make("f1d1a000-0000-4000-8000-000000000249"),
          patExpiresAt: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
        },
      })
    ).pipe(Effect.asVoid),

  "emailAuthentication.requestEmailReplacement": (attempt) =>
    Effect.result(
      attempt.strangerClient.emailAuthentication.requestEmailReplacement({
        payload: { candidateEmail: EmailAddress.make("stranger-replacement@example.com") },
      })
    ).pipe(Effect.asVoid),

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

  "subscription.getUpgradeUrl": (attempt) =>
    attempt.strangerClient.subscription.getUpgradeUrl().pipe(Effect.asVoid),

  "subscription.listSubscriptionOffers": (attempt) =>
    attempt.strangerClient.subscription.listSubscriptionOffers().pipe(Effect.asVoid),

  "budgets.createBudget": (attempt) =>
    Effect.gen(function* () {
      yield* attempt.strangerClient.budgets.createBudget({
        payload: { categoryId: categoryIds.restaurantes, cap: budgetCap },
      });
      const retained = (yield* attempt.ownerClient.budgets.listBudgets()).data;
      expect(retained).toHaveLength(1);
      expectSameBudget(retained[0] ?? attempt.ownedBudget, attempt.ownedBudget);
    }),

  "budgets.listBudgets": (attempt) =>
    Effect.gen(function* () {
      expect((yield* attempt.strangerClient.budgets.listBudgets()).data).toEqual([]);
    }),

  "budgets.getBudget": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.budgets.getBudget({
          params: { id: attempt.ownedBudget.id },
        })
      );
      const absent = yield* Effect.result(
        attempt.strangerClient.budgets.getBudget({
          params: { id: absentBudgetId },
        })
      );
      expect(denied).toEqual(absent);
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
    }),

  "budgets.updateBudget": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.budgets.updateBudget({
          params: { id: attempt.ownedBudget.id },
          payload: { categoryId: categoryIds.mercado, cap: budgetCap },
        })
      );
      const absent = yield* Effect.result(
        attempt.strangerClient.budgets.updateBudget({
          params: { id: absentBudgetId },
          payload: { categoryId: categoryIds.mercado, cap: budgetCap },
        })
      );
      expect(denied).toEqual(absent);
      expectSameBudget(
        (yield* attempt.ownerClient.budgets.getBudget({
          params: { id: attempt.ownedBudget.id },
        })).data,
        attempt.ownedBudget
      );
    }),

  "budgets.deleteBudget": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.budgets.deleteBudget({
          params: { id: attempt.ownedBudget.id },
        })
      );
      const absent = yield* Effect.result(
        attempt.strangerClient.budgets.deleteBudget({
          params: { id: absentBudgetId },
        })
      );
      expect(denied).toEqual(absent);
      expectSameBudget(
        (yield* attempt.ownerClient.budgets.getBudget({
          params: { id: attempt.ownedBudget.id },
        })).data,
        attempt.ownedBudget
      );
    }),

  "budgets.getBudgetStatus": (attempt) =>
    Effect.gen(function* () {
      const statuses = yield* attempt.strangerClient.budgets.getBudgetStatus({
        query: { timeZone: IanaTimeZone.make("America/Bogota") },
      });
      expect(statuses.data.statuses).toEqual([]);
      expect(statuses.data.period.timeZone).toBe("America/Bogota");
    }),

  "memory.remember": (attempt) =>
    Effect.gen(function* () {
      yield* attempt.strangerClient.memory.remember({
        payload: { text: MemoryText.make("solo extraño") },
      });
      expect((yield* attempt.ownerClient.memory.recall()).data).toEqual([]);
    }),

  "memory.revise": (attempt) =>
    Effect.gen(function* () {
      const owned = yield* attempt.ownerClient.memory.remember({
        payload: { text: MemoryText.make("solo dueño") },
      });
      const denied = yield* Effect.result(
        attempt.strangerClient.memory.revise({
          params: { id: owned.data.id },
          payload: { text: MemoryText.make("intruso") },
        })
      );
      const absent = yield* Effect.result(
        attempt.strangerClient.memory.revise({
          params: { id: absentMemoryId },
          payload: { text: MemoryText.make("intruso") },
        })
      );
      expect(denied).toEqual(absent);
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      expect((yield* attempt.ownerClient.memory.recall()).data).toEqual([owned.data]);
    }),

  "memory.forget": (attempt) =>
    Effect.gen(function* () {
      const owned = yield* attempt.ownerClient.memory.remember({
        payload: { text: MemoryText.make("solo dueño") },
      });
      const denied = yield* Effect.result(
        attempt.strangerClient.memory.forget({ params: { id: owned.data.id } })
      );
      const absent = yield* Effect.result(
        attempt.strangerClient.memory.forget({
          params: { id: absentMemoryId },
        })
      );
      expect(denied).toEqual(absent);
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      expect((yield* attempt.ownerClient.memory.recall()).data).toEqual([owned.data]);
    }),

  "memory.recall": (attempt) =>
    Effect.gen(function* () {
      yield* attempt.ownerClient.memory.remember({
        payload: { text: MemoryText.make("solo dueño") },
      });
      expect((yield* attempt.strangerClient.memory.recall()).data).toEqual([]);
    }),

  "ingestion.getStatementSubmission": (attempt) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        attempt.strangerClient.ingestion.getStatementSubmission({
          params: { id: attempt.ownedStatementSubmissionId },
        })
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      const retained = yield* attempt.ownerClient.ingestion.getStatementSubmission({
        params: { id: attempt.ownedStatementSubmissionId },
      });
      expect(retained.data.id).toBe(attempt.ownedStatementSubmissionId);
    }),

  "ingestion.listNeedsReviewItems": (attempt) =>
    Effect.gen(function* () {
      const strangers = yield* attempt.strangerClient.ingestion.listNeedsReviewItems({
        query: { offset: Option.none(), limit: Option.none() },
      });
      const owners = yield* attempt.ownerClient.ingestion.listNeedsReviewItems({
        query: { offset: Option.none(), limit: Option.none() },
      });
      expect(strangers.data).toEqual([]);
      expect(owners.data.map((item) => item.id)).toContain(attempt.ownedReviewItemId);
    }),

  "ingestion.submitForExtraction": (attempt) =>
    Effect.asVoid(
      attempt.strangerClient.ingestion.submitForExtraction({
        payload: {
          idempotencyKey: StatementIdempotencyKey.make("f1d1a000-0000-4000-8000-00000000a183"),
          file: {
            name: "statement.csv",
            declaredMediaType: "text/csv",
            contentBase64: Base64FileContent.make("RGF0ZSxBbW91bnQKMjAyNi0wMS0wMSwxLjAw"),
          },
        },
      })
    ),

  "ingestion.resolveNeedsReviewItem": (attempt) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        attempt.strangerClient.ingestion.resolveNeedsReviewItem({
          params: { id: attempt.ownedReviewItemId },
          payload: {
            extraction: {
              money: attempt.ownedTransaction.money,
              counterparty: attempt.ownedTransaction.counterparty,
              direction: attempt.ownedTransaction.direction,
              occurredAt: attempt.ownedTransaction.occurredAt,
            },
          },
        })
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      const retained = yield* attempt.ownerClient.ingestion.listNeedsReviewItems({
        query: { offset: Option.none(), limit: Option.none() },
      });
      expect(retained.data).toMatchObject([{ id: attempt.ownedReviewItemId, status: "pending" }]);
    }),

  "categories.listCategories": (attempt) =>
    attempt.strangerClient.categories.listCategories({}).pipe(Effect.asVoid),

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
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      expect(retained.data).toEqual([ownerRule.data]);
    }),

  "dashboard.getDashboard": (attempt) =>
    Effect.gen(function* () {
      const strangers = yield* attempt.strangerClient.dashboard.getDashboard();
      const owners = yield* attempt.ownerClient.dashboard.getDashboard();

      expect(strangers.data.title).toBe("Tablero");
      expect(owners.data.title).toBe("Panel privado del dueño");
    }),

  "dashboard.getDashboardView": (attempt) =>
    Effect.gen(function* () {
      yield* attempt.strangerClient.dashboard.applyDashboardEdit({
        payload: {
          op: "add-widget",
          at: "bottom",
          widget: TransactionListWidget.make({
            id: WidgetId.make("f1d1a000-0000-4000-8000-0000000000b3"),
            type: "transaction-list",
            limit: TransactionListLimit.make(10),
          }),
        },
      });
      yield* attempt.strangerClient.dashboard.applyDashboardEdit({
        payload: {
          op: "add-widget",
          at: "bottom",
          widget: CustomMetricWidget.make({
            id: WidgetId.make("f1d1a000-0000-4000-8000-0000000000b4"),
            type: "custom-metric",
            label: "Total",
            period: "this-month",
            aggregation: "sum",
          }),
        },
      });
      yield* attempt.strangerClient.dashboard.applyDashboardEdit({
        payload: {
          op: "add-widget",
          at: "bottom",
          widget: BudgetBarWidget.make({
            id: WidgetId.make("f1d1a000-0000-4000-8000-0000000000b5"),
            type: "budget-bar",
            categoryId: categoryIds.restaurantes,
            currency: "COP",
          }),
        },
      });

      const strangers = yield* attempt.strangerClient.dashboard.getDashboardView();
      const ownerTransaction = yield* attempt.ownerClient.transactions.getTransaction({
        params: { id: attempt.ownedTransaction.id },
      });
      const ownerBudget = yield* attempt.ownerClient.budgets.getBudget({
        params: { id: attempt.ownedBudget.id },
      });
      type StrangerLayout = typeof strangers.data.layout;
      type StrangerWidget = Extract<StrangerLayout, { readonly kind: "leaf" }>["widget"];
      const widgets: Array<StrangerWidget> = [];
      const visit = (layout: StrangerLayout): void => {
        if (layout.kind === "leaf") widgets.push(layout.widget);
        else for (const child of layout.children) visit(child.node);
      };
      visit(strangers.data.layout);

      expect(strangers.data.title).toBe("Tablero");
      expect(widgets).toHaveLength(4);
      for (const { result } of widgets) {
        if ("buckets" in result) expect(result.buckets).toEqual([]);
        else if ("moneyGroups" in result) expect(result.moneyGroups).toEqual([]);
        else if ("transactions" in result) expect(result.transactions).toEqual([]);
        else expect(result.availability).toBe("missing-budget");
      }
      expect(ownerTransaction.data).toEqual(attempt.ownedTransaction);
      expectSameBudget(ownerBudget.data, attempt.ownedBudget);
    }),

  "dashboard.listDashboardCatalog": (attempt) =>
    Effect.gen(function* () {
      const strangers = yield* attempt.strangerClient.dashboard.listDashboardCatalog();
      const owners = yield* attempt.ownerClient.dashboard.listDashboardCatalog();

      expect(strangers.data).toEqual(owners.data);
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
        attempt.strangerClient.categories.deleteKeywordRule({
          params: { id: ownerRule.data.id },
        })
      );
      const retained = yield* attempt.ownerClient.categories.listKeywordRules({});
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      expect(retained.data).toEqual([ownerRule.data]);
    }),

  "transactions.listTransactions": (attempt) =>
    Effect.gen(function* () {
      const listed = yield* attempt.strangerClient.transactions.listTransactions({
        query: {},
      });

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
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
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
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
      expect(retained.data).toEqual(attempt.ownedTransaction);
    }),

  "transactions.listSourceAttestations": (attempt) =>
    Effect.gen(function* () {
      const denied = yield* Effect.result(
        attempt.strangerClient.transactions.listSourceAttestations({
          params: { id: attempt.ownedTransaction.id },
        })
      );
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "not_found" } },
      });
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
  yield* seedConsentedPatIdentity({
    userId: owner,
    bearer: ownerBearer,
  });
  yield* seedConsentedPatIdentity({
    userId: stranger,
    bearer: strangerBearer,
  });

  const ownerClient = yield* OwnerApiClient;
  const strangerClient = yield* StrangerApiClient;
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM budgets`;
  const ownedBudget = yield* ownerClient.budgets.createBudget({
    payload: { categoryId: categoryIds.restaurantes, cap: budgetCap },
  });
  const now = yield* DateTime.now;
  const created = yield* ownerClient.transactions.createTransaction({
    payload: transactionPayload({ occurredAt: now }),
  });
  const ownedInsight = yield* generateInsightEvent(owner, weeklySummaryInput());
  yield* ownerClient.dashboard.applyDashboardEdit({
    payload: { op: "set-title", title: "Panel privado del dueño" },
  });
  const ownedSubmission = yield* ownerClient.ingestion.submitForExtraction({
    payload: {
      idempotencyKey: StatementIdempotencyKey.make("f1d1a000-0000-4000-8000-00000000a181"),
      file: {
        name: "owner.csv",
        declaredMediaType: "text/csv",
        contentBase64: Base64FileContent.make("RGF0ZSxBbW91bnQKMjAyNi0wMS0wMSwxLjAw"),
      },
    },
  });
  const ownedReviewItemId = NeedsReviewItemId.make("f1d1a000-0000-4000-8000-00000000a182");
  yield* sql`
    INSERT INTO needs_review_items(
      id, user_id, submission_id, record_number, reason, service_market, locale, time_zone,
      source_format, source_channel, parser_revision, extractor_revision, original_evidence,
      issues, status
    ) VALUES (
      ${ownedReviewItemId}, ${owner}, ${ownedSubmission.data.id}, 1, 'missing-required-fact',
      'CO', 'es-CO', 'America/Bogota', 'csv', 'statement-upload', 'statement-parser-v1',
      'statement-extractor-v1',
      jsonb_build_object(
        'sourceFormat', 'csv', 'recordNumber', 1, 'startLine', 2, 'endLine', 2,
        'rawRecord', '2026-01-01,1.00', 'fields', jsonb_build_array('2026-01-01', '1.00')
      ),
      jsonb_build_array(), 'pending'
    )
  `;

  return {
    ownerClient,
    strangerClient,
    ownedTransaction: created.data,
    ownedBudget: ownedBudget.data,
    ownedInsight,
    ownedStatementSubmissionId: ownedSubmission.data.id,
    ownedReviewItemId,
  };
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
          yield* truncateStatementIngestion;
          yield* truncateDashboards;
          yield* truncateMemories;
          const attempt = yield* seedAttempt;

          yield* probe(attempt);
        })
      );
    }

    it.effect("does not serialize one User's Dashboard view with another User's write", () =>
      Effect.gen(function* () {
        yield* truncateInsights;
        yield* truncateTransactions;
        yield* truncateStatementIngestion;
        yield* truncateDashboards;
        yield* truncateMemories;
        const attempt = yield* seedAttempt;
        const now = yield* DateTime.now;

        const [view, created] = yield* Effect.all(
          [
            attempt.ownerClient.dashboard.getDashboardView(),
            attempt.strangerClient.transactions.createTransaction({
              payload: transactionPayload({ occurredAt: now }),
            }),
          ],
          { concurrency: "unbounded" }
        );

        expect(view.data.title).toBe("Panel privado del dueño");
        expect(created.data.id).toBeDefined();
      })
    );
  }
);
