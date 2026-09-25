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

it("keeps statement submission inside the derived atomic-batch child union", () => {
  // #788 decided that statement bytes are staged before the canonical submission; the derived
  // child union must keep carrying the submission itself rather than exempting ingestion from
  // batching through an eligibility flag. The fixture mirrors the staged-reference declaration.
  const ingestion = operationCatalog.byId.get("ingestion.submitForExtraction");
  expect(ingestion?.atomicBatchEligible).toBe(true);
  expect(ingestion?.policy.kind).toBe("mutation");
  const callId = "10000000-0000-4000-8000-000000000002";
  const decode = Schema.decodeUnknownOption(getAtomicBatchCallSchema());
  expect(
    decode({
      callId,
      operation: "ingestion.submitForExtraction",
      input: {
        payload: {
          idempotencyKey: "20000000-0000-4000-8000-000000000201",
          reference: {
            stagingId: "30000000-0000-4000-8000-000000000301",
            byteLength: 42,
            sha256: "a".repeat(64),
          },
        },
      },
    })._tag
  ).toBe("Some");
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
