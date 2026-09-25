import { Option } from "effect";
import { expect, it } from "vitest";
import {
  CanonicalOperationId,
  atomicBatchChildOperations,
  atomicBatchOperation,
  getAtomicBatchChildIds,
  operationCatalog,
} from "@fidy/server/canonical-runtime";
import { canonicalMutationAdapters } from "./canonical-mutation-registry";

it("derives its execution registry from the catalog child set without a readiness allowlist", () => {
  const registry = canonicalMutationAdapters();
  const derived = atomicBatchChildOperations(operationCatalog);
  expect([...registry.keys()].sort()).toEqual(derived.map((child) => child.id).sort());
  // The published child-call union and the execution registry coincide: a child one derivation
  // names and the other drops is unreachable work, and the startup assertion proves the same.
  expect([...getAtomicBatchChildIds()].sort()).toEqual(derived.map((child) => child.id).sort());
  // Queries, nested batches, and ADR 0027 standalone account-security mutations stay excluded.
  expect(derived.every((child) => child.policy.kind === "mutation")).toBe(true);
  expect(derived.every((child) => child.atomicBatchEligible)).toBe(true);
  for (const excluded of [
    atomicBatchOperation,
    CanonicalOperationId.make("transactions.listTransactions"),
    CanonicalOperationId.make("categories.listKeywordRules"),
    CanonicalOperationId.make("memory.recall"),
    CanonicalOperationId.make("recovery.rotateBackupRecoveryCode"),
    CanonicalOperationId.make("emailAuthentication.requestEmailReplacement"),
    CanonicalOperationId.make("emailAuthentication.completeEmailReplacement"),
  ]) {
    expect(derived.some((child) => child.id === excluded)).toBe(false);
    expect(registry.has(excluded)).toBe(false);
  }
  // Every implemented owner mutation resolves to its adapter, and a catalog child without an
  // adapter stays in the registry as None so the batch fails closed instead of dropping it.
  const hasAdapter = (operation: string): boolean =>
    Option.getOrElse(
      Option.map(
        Option.fromUndefinedOr(registry.get(CanonicalOperationId.make(operation))),
        Option.isSome
      ),
      () => false
    );
  expect(hasAdapter("memory.remember")).toBe(true);
  expect(hasAdapter("categories.createKeywordRule")).toBe(true);
  expect(hasAdapter("transactions.createTransaction")).toBe(true);
  expect(hasAdapter("transactions.deleteTransaction")).toBe(false);
});
