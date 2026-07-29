import { expect, layer } from "@effect/vitest";
import { Effect, Option } from "effect";
import { ApiHarness } from "./api-harness";
import { publishedOperations } from "./openapi";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "operation policy metadata",
  (it) => {
    it.effect("publishes required scope and cost class for every canonical operation", () =>
      Effect.gen(function* () {
        const operations = yield* publishedOperations;

        expect(operations.length).toBeGreaterThan(0);
        for (const operation of operations) {
          expect(Option.isSome(operation.requiredScope), operation.id).toBe(true);
          expect(Option.isSome(operation.costClass), operation.id).toBe(true);
        }
      })
    );
  }
);
