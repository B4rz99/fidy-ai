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
    // Invalid JSON raises a native SQL error on mismatch, rolling back the enclosing batch.
    // Keeping the assertion read-only avoids charging a write for every guarded read.
    .prepare(`SELECT json(CASE
  WHEN EXISTS(SELECT 1 FROM erasure_control WHERE kind='published' AND generation=?)
  THEN 'true' ELSE '' END) AS accepted`)
    .bind(input.generation);
