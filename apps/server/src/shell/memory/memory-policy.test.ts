import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Result } from "effect";
import { Memory, MemoryCapacityExceeded, MemoryId, MemoryText } from "~/core/memory/contract";
import { approvedWorkersAiModel } from "~/shell/hosted-inference/contract";
import { HostedInference } from "~/shell/hosted-inference/operations";
import { makeWorkersAiHostedInference } from "~/shell/hosted-inference/runtime";
import { countAndAdmitMemory, countAndAdmitMemoryRevision } from "./operations";

const at = DateTime.makeUnsafe("2026-08-12T10:00:00Z");
const memory = (index: number, text: string): Memory =>
  Memory.make({
    id: MemoryId.make(`01912345-6789-7abc-8def-${String(index).padStart(12, "0")}`),
    text: MemoryText.make(text),
    createdAt: at,
    updatedAt: at,
  });

const localInference = makeWorkersAiHostedInference({
  model: Option.some(approvedWorkersAiModel),
  run: Option.some(() => Effect.die("Memory counting must not invoke Workers AI")),
});

it.effect("admits the complete ASCII aggregate at 15,000 bytes and rejects one extra byte", () =>
  Effect.gen(function* () {
    const inference = yield* localInference;
    const current = Array.from({ length: 7 }, (_, index) => memory(index, "a".repeat(2_000)));
    // Eight 55-byte JSON envelopes, seven LF separators, and 14,553 ASCII bytes total 15,000.
    const candidate = memory(7, "a".repeat(553));
    expect(
      yield* countAndAdmitMemory(current, candidate).pipe(
        Effect.provideService(HostedInference, inference)
      )
    ).toBe(candidate);

    const result = yield* countAndAdmitMemory(current, memory(7, "a".repeat(554))).pipe(
      Effect.provideService(HostedInference, inference),
      Effect.result
    );
    assert.deepStrictEqual(result, Result.fail(new MemoryCapacityExceeded()));
    expect(String(result)).not.toContain("a".repeat(554));
  })
);

it.effect("counts UTF-8 bytes in the replaced aggregate and refuses a revision above the cap", () =>
  Effect.gen(function* () {
    const inference = yield* localInference;
    const current = Array.from({ length: 4 }, (_, index) => memory(index, "é".repeat(2_000)));
    // Four 55-byte envelopes and three LF separators leave 14,777 text bytes;
    // three unchanged 4,000-byte texts plus 1,388 two-byte accents and one ASCII byte fill it.
    const replacement = memory(0, "é".repeat(1_388) + "a");
    expect(
      yield* countAndAdmitMemoryRevision(current, replacement).pipe(
        Effect.provideService(HostedInference, inference)
      )
    ).toBe(replacement);

    const result = yield* countAndAdmitMemoryRevision(
      current,
      memory(0, "é".repeat(1_388) + "aa")
    ).pipe(Effect.provideService(HostedInference, inference), Effect.result);
    assert.deepStrictEqual(result, Result.fail(new MemoryCapacityExceeded()));
    expect(String(result)).not.toContain("é".repeat(1_388));
  })
);
