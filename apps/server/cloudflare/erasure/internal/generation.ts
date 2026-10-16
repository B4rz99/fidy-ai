import { Effect, Option, Schema } from "effect";
import { ErasureGeneration, type ErasureRecoveryConfiguration } from "../contract";
import { ErasureUnavailable } from "../../erasure-store/contract";

export const generationKey = "recovery/generation";
const maximumGenerationBytes = 64;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const decodeGeneration = (
  object: R2ObjectBody
): Effect.Effect<
  Readonly<{ generation: typeof ErasureGeneration.Type; etag: string }>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    if (object.size > maximumGenerationBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const encoded = yield* io(() => object.text());
    const generation = yield* Schema.decodeEffect(ErasureGeneration)(encoded);
    return { generation, etag: object.etag };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const expectedGeneration = (
  configuration: ErasureRecoveryConfiguration
): Effect.Effect<
  Readonly<{ generation: typeof ErasureGeneration.Type; etag: string }>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    if (Option.isNone(configuration.bucket)) return yield* new ErasureUnavailable();
    const bucket = configuration.bucket.value;
    const existing = yield* io(() => bucket.get(generationKey));
    if (existing !== null) return yield* decodeGeneration(existing);
    return yield* new ErasureUnavailable();
  });

export const generationAssertion = (
  input: Readonly<{ db: D1Database; generation: typeof ErasureGeneration.Type }>
): D1PreparedStatement =>
  input.db
    .prepare(`INSERT INTO erasure_runtime_assertion(id,accepted)
  SELECT 1,EXISTS(SELECT 1 FROM erasure_generation WHERE id=1 AND generation=?)
  ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted`)
    .bind(input.generation);
