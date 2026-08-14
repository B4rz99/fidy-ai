import { expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";
import { assertCanonicalMutationRegistry } from "~/shell/_shared/canonical-mutation-registry";
import { operationCatalog } from "~/shell/api";
import { maximumAtomicBatchCalls } from "./operations";

const batchOperation = operationCatalog.byId.get("operations.executeAtomicBatch");
if (batchOperation === undefined) throw new Error("missing atomic batch operation");

const decodeBatchInput = Schema.decodeUnknownExit(batchOperation.input);
const callId = "f1d1a000-0000-4000-8000-000000000301";
const mutationCall = {
  callId,
  operation: "identity.updateUserPreferences",
  input: { payload: { locale: "es-CO", timeZone: "America/Bogota" } },
};

it("derives a non-empty bounded child union that excludes queries and recursive batches", () => {
  expect(Exit.isSuccess(decodeBatchInput({ payload: { calls: [mutationCall] } }))).toBe(true);
  expect(Exit.isFailure(decodeBatchInput({ payload: { calls: [] } }))).toBe(true);
  expect(
    Exit.isFailure(
      decodeBatchInput({
        payload: { calls: Array.from({ length: maximumAtomicBatchCalls + 1 }, () => mutationCall) },
      })
    )
  ).toBe(true);
  expect(
    Exit.isFailure(
      decodeBatchInput({
        payload: {
          calls: [{ callId, operation: "identity.getCurrentUser", input: {} }],
        },
      })
    )
  ).toBe(true);
  expect(
    Exit.isFailure(
      decodeBatchInput({
        payload: {
          calls: [
            {
              callId,
              operation: "operations.executeAtomicBatch",
              input: { payload: { calls: [mutationCall] } },
            },
          ],
        },
      })
    )
  ).toBe(true);
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
