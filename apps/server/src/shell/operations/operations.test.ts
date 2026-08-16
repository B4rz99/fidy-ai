import { expect, it } from "@effect/vitest";
import { assertCanonicalMutationRegistry } from "~/shell/_shared/canonical-mutation-registry";
import { operationCatalog } from "~/shell/api";

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
