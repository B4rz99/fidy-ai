import { expect, layer } from "@effect/vitest";
import { Effect, Option } from "effect";
import { type PublishedOperation, publishedOperations } from "./openapi";
import { ApiHarness } from "./api-harness";

/**
 * An operation describes itself when the spec carries prose a caller can act
 * on, so whitespace counts for nothing: a blank description satisfies a
 * presence check and tells an agent no more than a missing one would.
 */
const describesItself = (operation: PublishedOperation): boolean =>
  Option.match(operation.description, {
    onNone: () => false,
    onSome: (description) => description.trim().length > 0,
  });

/**
 * The second derived guard (ARCHITECTURE.md §8). The spec is what a calling
 * agent reads at runtime to work out what an operation is for, so an operation
 * published without a description is a hole in the product, not in the docs.
 *
 * Only presence is checked, because only presence is checkable. Whether the
 * prose is addressed to an agent, and says when to reach for the operation
 * rather than how it is built, stays a review matter (CODING_STANDARDS.md).
 *
 * Fields get no equivalent guard: "obvious from its name and type" is a
 * judgement, and a rule demanding a description on `currency: "COP"` would buy
 * noise. The operations are the enumerable part, so they are the guarded part.
 */
layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "agent-facing descriptions",
  (it) => {
    it.effect("every canonical operation the server publishes says what it is for", () =>
      Effect.gen(function* () {
        const operations = yield* publishedOperations;

        // Asserted before the filter below, which an empty spec would satisfy
        // while describing nothing at all.
        expect(operations.length).toBeGreaterThan(0);

        // Enumerated from the spec rather than listed here, so an operation
        // added without a description fails this test without anyone having
        // remembered to extend it.
        const undescribed = operations
          .filter((operation) => !describesItself(operation))
          .map((operation) => operation.id);

        expect(undescribed).toEqual([]);
      })
    );
  }
);
