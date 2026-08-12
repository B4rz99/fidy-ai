import assert from "node:assert/strict";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Exit } from "effect";
import { Memory, MemoryId, MemoryText } from "./model";
import { MemoryCapacityExceeded, admitMemory, maximumAggregateMemoryTokens } from "./rules";

const candidate = Memory.make({
  id: MemoryId.make("01912345-6789-7abc-8def-0123456789ab"),
  text: MemoryText.make("arbitrary Unicode: 🫶🏽"),
  createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
});

describe("Memory capacity", () => {
  it.effect("admits an aggregate at the token cap", () =>
    Effect.gen(function* () {
      expect(yield* admitMemory({ candidate, aggregateTokens: maximumAggregateMemoryTokens })).toBe(
        candidate
      );
    })
  );

  it.effect("rejects an aggregate above the token cap without content-bearing failure fields", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        admitMemory({ candidate, aggregateTokens: maximumAggregateMemoryTokens + 1 })
      );
      assert.deepStrictEqual(exit, Exit.fail(new MemoryCapacityExceeded()));
      expect(String(exit)).not.toContain(candidate.text);
    })
  );
});
