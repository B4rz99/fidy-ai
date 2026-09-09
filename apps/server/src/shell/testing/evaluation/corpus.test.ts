import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { loadCorpus, validateCoverage } from "./corpus";
import type { Corpus } from "./model";

it.live("loads one bounded synthetic corpus with every required coverage label", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(BunServices.layer);
    const loaded = yield* loadCorpus.pipe(Effect.provide(services));
    expect(loaded.corpus.revision).toBe("es-co-v1");
    expect(loaded.corpus.provenance).toBe("synthetic-only");
    expect(loaded.corpus.cases).toHaveLength(45);
    expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(loaded.images.size).toBe(5);
  })
);

it.live("rejects duplicate case identities before provider construction", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(BunServices.layer);
    const loaded = yield* loadCorpus.pipe(Effect.provide(services));
    const first = yield* Effect.fromOption(Option.fromUndefinedOr(loaded.corpus.cases[0]));
    const duplicate: Corpus = {
      ...loaded.corpus,
      cases: [first, first, ...loaded.corpus.cases.slice(1)],
    };
    const failure = yield* validateCoverage(duplicate).pipe(Effect.flip);
    expect(failure.reason).toBe("invalid-corpus");
  })
);
