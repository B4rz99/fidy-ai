import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { assertCanonicalMutationRegistry } from "~/shell/_shared/canonical-mutation-registry";
import { operationCatalog } from "~/shell/api";
import { getAtomicBatchCallSchema } from "./operations";

it("keeps mailbox-proof replacement out of atomic batches", () => {
  expect(
    operationCatalog.byId.get("emailAuthentication.requestEmailReplacement")?.atomicBatchEligible
  ).toBe(false);
  expect(
    operationCatalog.byId.get("emailAuthentication.completeEmailReplacement")?.atomicBatchEligible
  ).toBe(false);
  const decode = Schema.decodeUnknownOption(getAtomicBatchCallSchema());
  const callId = "10000000-0000-4000-8000-000000000001";
  expect(
    decode({
      callId,
      operation: "emailAuthentication.requestEmailReplacement",
      input: {
        payload: { candidateEmail: "other@example.test" },
      },
    })._tag
  ).toBe("None");
  expect(
    decode({
      callId,
      operation: "emailAuthentication.completeEmailReplacement",
      input: {
        payload: { combinedCode: "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ" },
      },
    })._tag
  ).toBe("None");
});

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
