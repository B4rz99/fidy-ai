import { expect, layer } from "@effect/vitest";
import { Effect, Option } from "effect";
import { HttpApi } from "effect/unstable/httpapi";
import { TokenAuthorization } from "~/shell/_shared/authz";
import { ValidationGate } from "~/shell/_shared/errors";
import {
  type AgentConfirmation,
  type CanonicalOperationKind,
} from "~/shell/_shared/operation-policy";
import { isOperationResponse } from "~/shell/_shared/response";
import { FidyApi, type OperationId } from "~/shell/api";
import { ApiHarness } from "./api-harness";
import { publishedOperations } from "./openapi";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "operation policy metadata",
  (it) => {
    it("runs every canonical operation behind validation and attributable-call auditing", () => {
      const covered: Array<{
        readonly id: string;
        readonly authorization: boolean;
        readonly validation: boolean;
      }> = [];
      HttpApi.reflect(FidyApi, {
        onGroup: () => undefined,
        onEndpoint: ({ endpoint, group, middleware }) => {
          const middlewareKeys = Array.from(middleware, (candidate) => candidate.key);
          covered.push({
            id: `${group.identifier}.${endpoint.identifier}`,
            authorization: middlewareKeys.includes(TokenAuthorization.key),
            validation: middlewareKeys.includes(ValidationGate.key),
          });
        },
      });

      expect(covered.length).toBeGreaterThan(0);
      expect(
        covered.filter((operation) => !operation.authorization || !operation.validation)
      ).toEqual([]);
    });

    it("publishes every canonical success in the universal response envelope", () => {
      const unwrapped: Array<string> = [];
      HttpApi.reflect(FidyApi, {
        onGroup: () => undefined,
        onEndpoint: ({ endpoint, group, successes }) => {
          for (const schemas of successes.values()) {
            for (const schema of schemas) {
              if (!isOperationResponse(schema)) {
                unwrapped.push(`${group.identifier}.${endpoint.identifier}`);
              }
            }
          }
        },
      });

      expect(unwrapped).toEqual([]);
    });

    it.effect("publishes complete policy for every canonical operation", () =>
      Effect.gen(function* () {
        const operations = yield* publishedOperations;

        expect(operations.length).toBeGreaterThan(0);
        for (const operation of operations) {
          expect(Option.isSome(operation.requiredScope), operation.id).toBe(true);
          expect(Option.isSome(operation.requiredTier), operation.id).toBe(true);
          expect(Option.isSome(operation.agentConfirmation), operation.id).toBe(true);
          expect(Option.isSome(operation.kind), operation.id).toBe(true);
        }
      })
    );

    it.effect("classifies every canonical operation as a query or mutation", () =>
      Effect.gen(function* () {
        const expected = {
          "identity.getCurrentUser": "query",
          "identity.updateUserPreferences": "mutation",
          "categories.listCategories": "query",
          "categories.listKeywordRules": "query",
          "categories.createKeywordRule": "mutation",
          "categories.updateKeywordRule": "mutation",
          "categories.deleteKeywordRule": "mutation",
          "transactions.createTransaction": "mutation",
          "transactions.listTransactions": "query",
          "transactions.getTransaction": "query",
          "transactions.updateTransaction": "mutation",
          "transactions.deleteTransaction": "mutation",
          "transactions.listSourceAttestations": "query",
          "insights.listPendingInsights": "query",
          "insights.markInsightDelivered": "mutation",
          "insights.markInsightRead": "mutation",
          "insights.dismissInsight": "mutation",
          "memory.remember": "mutation",
          "memory.revise": "mutation",
          "memory.forget": "mutation",
          "memory.recall": "query",
          "dashboard.getDashboard": "mutation",
          "dashboard.listDashboardCatalog": "query",
          "dashboard.applyDashboardEdit": "mutation",
          "subscription.getUpgradeUrl": "query",
          "ingestion.getStatementSubmission": "query",
          "ingestion.listNeedsReviewItems": "query",
          "ingestion.submitForExtraction": "mutation",
          "ingestion.resolveNeedsReviewItem": "mutation",
          "operations.executeAtomicBatch": "mutation",
        } satisfies Record<OperationId, CanonicalOperationKind>;
        const operations = yield* publishedOperations;
        const byOperationId = (
          left: readonly [string, unknown],
          right: readonly [string, unknown]
        ): number => left[0].localeCompare(right[0]);
        const published: Array<readonly [string, Option.Option<CanonicalOperationKind>]> =
          operations.map(({ id, kind }) => [id, kind]);

        expect(published.sort(byOperationId)).toEqual(
          Object.entries(expected)
            .map(([id, kind]): readonly [string, Option.Option<CanonicalOperationKind>] => [
              id,
              Option.some(kind),
            ])
            .sort(byOperationId)
        );
      })
    );

    it.effect("keeps every currently assembled canonical operation Free", () =>
      Effect.gen(function* () {
        const operations = yield* publishedOperations;
        const proOperations = operations
          .filter((operation) => Option.getOrUndefined(operation.requiredTier) === "pro")
          .map((operation) => operation.id);

        expect(proOperations).toEqual([]);
        expect(operations.map((operation) => operation.id)).toContain(
          "transactions.listTransactions"
        );
        expect(operations.map((operation) => operation.id)).toContain("subscription.getUpgradeUrl");
      })
    );

    it.effect("assigns explicit hosted-agent confirmation policy to every operation", () =>
      Effect.gen(function* () {
        const expected = {
          "identity.getCurrentUser": "not-required",
          "identity.updateUserPreferences": "not-required",
          "categories.listCategories": "not-required",
          "categories.listKeywordRules": "not-required",
          "categories.createKeywordRule": "not-required",
          "categories.updateKeywordRule": "required",
          "categories.deleteKeywordRule": "required",
          "transactions.createTransaction": "not-required",
          "transactions.listTransactions": "not-required",
          "transactions.getTransaction": "not-required",
          "transactions.updateTransaction": "required",
          "transactions.deleteTransaction": "required",
          "transactions.listSourceAttestations": "not-required",
          "insights.listPendingInsights": "not-required",
          "insights.markInsightDelivered": "required",
          "insights.markInsightRead": "required",
          "insights.dismissInsight": "required",
          "memory.remember": "not-required",
          "memory.revise": "required",
          "memory.forget": "required",
          "memory.recall": "not-required",
          "dashboard.getDashboard": "not-required",
          "dashboard.listDashboardCatalog": "not-required",
          "dashboard.applyDashboardEdit": "required",
          "subscription.getUpgradeUrl": "not-required",
          "ingestion.getStatementSubmission": "not-required",
          "ingestion.listNeedsReviewItems": "not-required",
          "ingestion.submitForExtraction": "not-required",
          "ingestion.resolveNeedsReviewItem": "required",
          "operations.executeAtomicBatch": "required",
        } satisfies Record<OperationId, AgentConfirmation>;
        const operations = yield* publishedOperations;
        const published: Array<readonly [string, Option.Option<AgentConfirmation>]> =
          operations.map(({ agentConfirmation, id }) => [id, agentConfirmation]);
        const byOperationId = (
          left: readonly [string, unknown],
          right: readonly [string, unknown]
        ): number => left[0].localeCompare(right[0]);

        expect(published.sort(byOperationId)).toEqual(
          Object.entries(expected)
            .map(([id, confirmation]): readonly [string, Option.Option<AgentConfirmation>] => [
              id,
              Option.some(confirmation),
            ])
            .sort(byOperationId)
        );
      })
    );
  }
);
