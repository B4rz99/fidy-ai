import { RecoveryCase } from "./recovery-case";
import { sealRecoveryCase } from "./sealed-case";
import { Effect, Option, Schema } from "effect";
import { type ErasureScope, ErasureUnavailable } from "../../erasure-store/contract";
import { newId } from "../../secret-material/operations";
import type { ErasureRecoveryConfiguration } from "../contract";
import { expectedGeneration, generationAssertion, generationKey } from "./generation";

const maximumCaseBytes = 512;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
type Checkpoint = Readonly<{
  bucket: R2Bucket;
  previous: Readonly<{ generation: string; etag: string }>;
  generation: string;
}>;

const prepareGeneration = (
  configuration: ErasureRecoveryConfiguration
): Effect.Effect<Checkpoint, ErasureUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(configuration.bucket)) return yield* new ErasureUnavailable();
    const previous = yield* expectedGeneration(configuration);
    const matching = yield* io(() =>
      configuration.db
        .prepare(
          "SELECT count(*) AS matched FROM erasure_control WHERE kind='published' AND generation=?"
        )
        .bind(previous.generation)
        .first<number>("matched")
    );
    if (matching !== 1) return yield* new ErasureUnavailable();
    return { bucket: configuration.bucket.value, previous, generation: yield* Effect.sync(newId) };
  });

const checkpointStatements = (
  db: D1Database,
  checkpoint: Checkpoint
): ReadonlyArray<D1PreparedStatement> => [
  generationAssertion({ db, generation: checkpoint.previous.generation }),
  db
    .prepare("UPDATE erasure_control SET generation=? WHERE kind='published'")
    .bind(checkpoint.generation),
];

/** An uncertain initial publication keeps ordinary data access and restore release fenced. Commit the returned checkpoint with the exact request transition. */
export const publishDeletionMarker = (
  input: Readonly<{
    configuration: ErasureRecoveryConfiguration;
    record: typeof RecoveryCase.Type;
  }>
): Effect.Effect<
  Readonly<{
    record: typeof RecoveryCase.Type;
    checkpoint: ReadonlyArray<D1PreparedStatement>;
  }>,
  ErasureUnavailable
> =>
  Effect.gen(function* () {
    const checkpoint = yield* prepareGeneration(input.configuration);
    const { bucket, generation, previous } = checkpoint;
    const pending = yield* io(() =>
      bucket.put(generationKey, `publishing:${generation}`, {
        onlyIf: { etagMatches: previous.etag },
      })
    );
    if (pending === null) return yield* new ErasureUnavailable();
    const record = yield* installCase({ bucket, record: input.record });
    const published = yield* io(() =>
      bucket.put(generationKey, generation, {
        onlyIf: { etagMatches: pending.etag },
      })
    );
    if (published === null) return yield* new ErasureUnavailable();
    return { record, checkpoint: checkpointStatements(input.configuration.db, checkpoint) };
  });

const installCase = (
  input: Readonly<{ bucket: R2Bucket; record: typeof RecoveryCase.Type }>
): Effect.Effect<typeof RecoveryCase.Type, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { bucket } = input;
    const key = `recovery/cases/${input.record.reference}`;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryCase))(input.record);
    const installed = yield* io(() =>
      bucket.put(key, encoded, { onlyIf: { etagDoesNotMatch: "*" } })
    );
    if (installed !== null) return input.record;
    const object = yield* io(() => bucket.get(key));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > maximumCaseBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const previous = yield* Schema.decodeEffect(Schema.fromJsonString(RecoveryCase), {
      onExcessProperty: "error",
    })(yield* io(() => object.text()));
    if (
      previous.reference !== input.record.reference ||
      previous.userId !== input.record.userId ||
      previous.requestedAtMs !== input.record.requestedAtMs
    ) {
      return yield* new ErasureUnavailable();
    }
    return previous;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

/** Commit the returned assertions and generation update with the caller's exact disposition change. A failed native commit leaves ordinary data units fenced. */
export const prepareCheckpoint = (
  configuration: ErasureRecoveryConfiguration
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, ErasureUnavailable> =>
  Effect.gen(function* () {
    const checkpoint = yield* prepareGeneration(configuration);
    const stored = yield* io(() =>
      checkpoint.bucket.put(generationKey, checkpoint.generation, {
        onlyIf: { etagMatches: checkpoint.previous.etag },
      })
    );
    if (stored === null) return yield* new ErasureUnavailable();
    return checkpointStatements(configuration.db, checkpoint);
  });

export const checkpoint = (
  input: Readonly<{ configuration: ErasureRecoveryConfiguration; scope: ErasureScope }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* sealRecoveryCase(input);
    const statements = yield* prepareCheckpoint(input.configuration);
    yield* io(() =>
      input.configuration.db.batch([
        ...statements,
        input.configuration.db
          .prepare(`UPDATE erasure_requests SET marker_written=1,state='Erasing'
      WHERE id=? AND user_id=? AND state='Sealing' AND coordinator_cleared=1`)
          .bind(input.scope.reference, input.scope.userId),
      ])
    );
  });
