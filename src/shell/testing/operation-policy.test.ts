import { expect, layer } from "@effect/vitest";
import { Effect, Option } from "effect";
import { HttpApi } from "effect/unstable/httpapi";
import { AgentAuthorization } from "~/shell/_shared/authz";
import { type AgentConfirmation } from "~/shell/_shared/operation-policy";
import { FidyApi, type OperationId } from "~/shell/api";
import { ApiHarness } from "./api-harness";
import { publishedOperations } from "./openapi";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "operation policy metadata",
  (it) => {
    it("runs every canonical operation behind attributable-call auditing", () => {
      const audited: Array<{ readonly id: string; readonly covered: boolean }> = [];
      HttpApi.reflect(FidyApi, {
        onGroup: () => undefined,
        onEndpoint: ({ endpoint, group, middleware }) => {
          audited.push({
            id: `${group.identifier}.${endpoint.identifier}`,
            covered: Array.from(middleware).some(
              (candidate) => candidate.key === AgentAuthorization.key
            ),
          });
        },
      });

      expect(audited.length).toBeGreaterThan(0);
      expect(audited.filter((operation) => !operation.covered)).toEqual([]);
    });

    it.effect("publishes complete policy for every canonical operation", () =>
      Effect.gen(function* () {
        const operations = yield* publishedOperations;

        expect(operations.length).toBeGreaterThan(0);
        for (const operation of operations) {
          expect(Option.isSome(operation.requiredScope), operation.id).toBe(true);
          expect(Option.isSome(operation.requiredTier), operation.id).toBe(true);
          expect(Option.isSome(operation.costClass), operation.id).toBe(true);
          expect(Option.isSome(operation.agentConfirmation), operation.id).toBe(true);
        }
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
          "dashboard.getDashboard": "not-required",
          "dashboard.listDashboardCatalog": "not-required",
          "dashboard.applyDashboardEdit": "required",
        } satisfies Record<OperationId, AgentConfirmation>;
        const operations = yield* publishedOperations;
        const published: Array<readonly [string, AgentConfirmation | undefined]> = operations.map(
          ({ agentConfirmation, id }) => [id, Option.getOrUndefined(agentConfirmation)]
        );
        const byOperationId = (
          left: readonly [string, unknown],
          right: readonly [string, unknown]
        ): number => left[0].localeCompare(right[0]);

        expect(published.sort(byOperationId)).toEqual(Object.entries(expected).sort(byOperationId));
      })
    );
  }
);
