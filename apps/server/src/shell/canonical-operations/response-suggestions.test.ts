import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { operationCatalog } from "~/shell/api";
import { NextOperations } from "~/shell/public-http/contract";
import { canCallOperation, checkpointResponseSuggestions } from "./operations";

const candidates: ReadonlyArray<Schema.Json> = [
  { tool: "memory.recall", hint: "Read your current Memories." },
  {
    tool: "memory.remember",
    hint: "Remember your economic context.",
    args: { payload: { text: "Private economic context." } },
  },
];

describe("canonical response continuation checkpoint", () => {
  it.each(["data", "error"])(
    "filters nested %s and envelope continuations without changing exact values",
    (part) => {
      Schema.decodeUnknownSync(NextOperations)(candidates);
      const value = Schema.decodeSync(Schema.Json)({
        [part]: { amount: "9007199254740993", nested: { continuations: candidates } },
        next: candidates,
      });
      const projected = checkpointResponseSuggestions({
        value,
        catalog: operationCatalog,
        available: (target) =>
          canCallOperation(target.policy, {
            accessCaller: { _tag: "OAuthAgent", capabilities: ["read"] },
            tier: "free",
          }),
      });
      expect(projected).toEqual({
        [part]: { amount: "9007199254740993", nested: { continuations: [candidates[0]] } },
        next: [candidates[0]],
      });
    }
  );

  it("keeps only tier-callable continuations when a declared query becomes Pro", () => {
    const operations = operationCatalog.operations.map((operation) =>
      operation.id === "memory.recall"
        ? { ...operation, policy: { ...operation.policy, requiredTier: "pro" as const } }
        : operation
    );
    const catalog = {
      ...operationCatalog,
      operations,
      byId: new Map(operations.map((operation) => [operation.id, operation])),
    };
    for (const tier of ["free", "pro"] as const) {
      const value = Schema.decodeSync(Schema.Json)({
        data: { continuations: candidates.slice(0, 1) },
        next: [],
      });
      expect(
        checkpointResponseSuggestions({
          value,
          catalog,
          available: (target) =>
            canCallOperation(target.policy, {
              accessCaller: { _tag: "OAuthAgent", capabilities: ["read"] },
              tier,
            }),
        })
      ).toEqual({ data: { continuations: tier === "pro" ? [candidates[0]] : [] }, next: [] });
    }
  });
});
