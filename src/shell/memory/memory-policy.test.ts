import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Ref } from "effect";
import { Memory, MemoryId, MemoryText } from "~/core/memory/model";
import { MemoryCapacityExceeded } from "~/core/memory/rules";
import { HostedInference, type HostedInferenceService } from "~/shell/agent/hosted-inference";
import {
  countAndAdmitMemory,
  countAndAdmitMemoryRevision,
  projectMemoryAggregate,
} from "./memory-policy";

const at = DateTime.makeUnsafe("2026-08-12T10:00:00Z");
const memory = (id: string, text: string): Memory =>
  Memory.make({ id: MemoryId.make(id), text: MemoryText.make(text), createdAt: at, updatedAt: at });

const memoryInference = (
  countMemoryText: HostedInferenceService["countMemoryText"]
): HostedInferenceService =>
  HostedInference.of({
    countMemoryText,
    prepareText: () => Effect.die("unused"),
    validateText: () => Effect.die("unused"),
    executeText: () => Effect.die("unused"),
    recoverText: () => Effect.die("unused"),
    discardText: () => Effect.die("unused"),
    prepareStructured: () => Effect.die("unused"),
    executeStructured: () => Effect.die("unused"),
    discardStructured: () => Effect.die("unused"),
  });

it.effect("counts the complete recall-ordered aggregate including the final candidate", () =>
  Effect.gen(function* () {
    const counted = yield* Ref.make<ReadonlyArray<string>>([]);
    const service = memoryInference((text) =>
      Ref.update(counted, (all) => [...all, text]).pipe(Effect.as(12))
    );
    const current = [memory("01912345-6789-7abc-8def-0123456789ab", "primera")];
    const candidate = memory("01912345-6789-7abc-8def-0123456789ac", "segunda");

    expect(
      yield* countAndAdmitMemory(current, candidate).pipe(
        Effect.provideService(HostedInference, service)
      )
    ).toBe(candidate);
    expect(yield* Ref.get(counted)).toEqual([projectMemoryAggregate([...current, candidate])]);
  })
);

it.effect("counts a same-instant candidate in the final recall identity order", () =>
  Effect.gen(function* () {
    const counted = yield* Ref.make("");
    const service = memoryInference((text) => Ref.set(counted, text).pipe(Effect.as(12)));
    const current = [memory("01912345-6789-7abc-8def-0123456789ac", "segunda")];
    const candidate = memory("01912345-6789-7abc-8def-0123456789ab", "primera");

    yield* countAndAdmitMemory(current, candidate).pipe(
      Effect.provideService(HostedInference, service)
    );

    expect(yield* Ref.get(counted)).toBe(projectMemoryAggregate([candidate, ...current]));
  })
);

it.effect("counts revision against the replaced aggregate without duplicating identity", () =>
  Effect.gen(function* () {
    const counted = yield* Ref.make("");
    const service = memoryInference((text) => Ref.set(counted, text).pipe(Effect.as(12)));
    const first = memory("01912345-6789-7abc-8def-0123456789ab", "anterior");
    const second = memory("01912345-6789-7abc-8def-0123456789ac", "segunda");
    const replacement = memory("01912345-6789-7abc-8def-0123456789ab", "reemplazo");

    expect(
      yield* countAndAdmitMemoryRevision([first, second], replacement).pipe(
        Effect.provideService(HostedInference, service)
      )
    ).toBe(replacement);
    expect(yield* Ref.get(counted)).toBe(projectMemoryAggregate([replacement, second]));
  })
);

it.effect("rejects an aggregate above 15,000 tokens without returning prose", () =>
  Effect.gen(function* () {
    const service = memoryInference(() => Effect.succeed(15_001));
    const candidate = memory("01912345-6789-7abc-8def-0123456789ac", "canary-private-prose");
    const exit = yield* countAndAdmitMemory([], candidate).pipe(
      Effect.provideService(HostedInference, service),
      Effect.exit
    );

    assert.deepStrictEqual(
      Exit.mapError(exit, (failure) => failure),
      Exit.fail(new MemoryCapacityExceeded())
    );
    expect(String(exit)).not.toContain("canary-private-prose");
  })
);
