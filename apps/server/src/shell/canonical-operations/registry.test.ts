import { expect, it } from "@effect/vitest";
import { operationCatalog } from "~/shell/api";
import { assertCanonicalMutationRegistry } from "~/shell/canonical-operations/internal/mutation-registry";

it("guards reusable dispatch completeness against the reflected ordinary mutation set", () => {
  const ordinary = {
    operations: operationCatalog.operations.filter(
      ({ id }) => id !== "operations.executeAtomicBatch"
    ),
    byId: new Map(
      operationCatalog.operations
        .filter(({ id }) => id !== "operations.executeAtomicBatch")
        .map((operation) => [operation.id, operation])
    ),
  };
  expect(() => assertCanonicalMutationRegistry(ordinary)).not.toThrow();
  expect(() =>
    assertCanonicalMutationRegistry({
      operations: ordinary.operations.filter(({ id }) => id !== "identity.updateUserPreferences"),
      byId: ordinary.byId,
    })
  ).toThrow("Canonical mutation registry drift");
});
