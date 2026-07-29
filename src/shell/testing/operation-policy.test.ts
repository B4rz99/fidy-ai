import { expect, layer } from "@effect/vitest";
import { Effect, Option } from "effect";
import { HttpApi } from "effect/unstable/httpapi";
import { AgentAuthorization } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
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

    it.effect("publishes scope, tier, and cost class for every canonical operation", () =>
      Effect.gen(function* () {
        const operations = yield* publishedOperations;

        expect(operations.length).toBeGreaterThan(0);
        for (const operation of operations) {
          expect(Option.isSome(operation.requiredScope), operation.id).toBe(true);
          expect(Option.isSome(operation.requiredTier), operation.id).toBe(true);
          expect(Option.isSome(operation.costClass), operation.id).toBe(true);
        }
      })
    );
  }
);
