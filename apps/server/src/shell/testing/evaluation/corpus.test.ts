import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Crypto, Effect, Encoding, Layer, Option } from "effect";
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

it.live("pins a distinct synthetic adversarial inline image", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(BunServices.layer);
    const [loaded, crypto] = yield* Effect.all([loadCorpus, Crypto.Crypto]).pipe(
      Effect.provide(services)
    );
    const injection = yield* Effect.fromOption(
      Option.fromUndefinedOr(loaded.images.get("injection.png"))
    );
    const receipt = yield* Effect.fromOption(
      Option.fromUndefinedOr(loaded.images.get("receipt.png"))
    );
    const digest = Encoding.encodeHex(yield* crypto.digest("SHA-256", injection));
    expect(injection).not.toEqual(receipt);
    expect(digest).toBe("bd4c8e16d8fafaef10558b9b2805903bc6f9df2377b7fbd16f55f6fc1d6dec13");
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
