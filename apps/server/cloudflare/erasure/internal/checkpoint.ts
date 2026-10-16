import { RecoveryCase } from "./recovery-case";
import { sealRecoveryCase } from "./sealed-case";
import { Effect, Option, Schema } from "effect";
import { ErasureDecision } from "../../../src/core/erasure/contract";
import { type ErasureScope, ErasureUnavailable } from "../../erasure-store/contract";
import { newId } from "../../secret-material/operations";
import type { ErasureRecoveryConfiguration } from "../contract";
import { expectedGeneration, generationAssertion, generationKey } from "./generation";

const maximumCaseBytes = 32768;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
export const persistReviewedCase = (
  input: Readonly<{
    configuration: ErasureRecoveryConfiguration;
    record: typeof RecoveryCase.Type;
  }>
): Effect.Effect<typeof RecoveryCase.Type, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = input.configuration.bucket;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const key = `recovery/cases/${input.record.decision.reference}`;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryCase))(input.record);
    const installed = yield* io(() =>
      bucket.value.put(key, encoded, { onlyIf: { etagDoesNotMatch: "*" } })
    );
    if (installed !== null) return input.record;
    const object = yield* io(() => bucket.value.get(key));
    if (object === null) return yield* new ErasureUnavailable();
    if (object.size > maximumCaseBytes) {
      yield* io(() => object.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const previous = yield* Schema.decodeEffect(Schema.fromJsonString(RecoveryCase))(
      yield* io(() => object.text())
    );
    const decision = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureDecision))(
      previous.decision
    );
    const expected = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureDecision))(
      input.record.decision
    );
    if (
      decision !== expected ||
      previous.requestedAtMs !== input.record.requestedAtMs ||
      previous.operatorRef !== input.record.operatorRef
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
    if (Option.isNone(configuration.bucket)) return yield* new ErasureUnavailable();
    const bucket = configuration.bucket.value;
    const previous = yield* expectedGeneration(configuration);
    const matching = yield* io(() =>
      configuration.db
        .prepare("SELECT count(*) AS matched FROM erasure_generation WHERE id=1 AND generation=?")
        .bind(previous.generation)
        .first<number>("matched")
    );
    if (matching !== 1) return yield* new ErasureUnavailable();
    const generation = yield* Effect.sync(newId);
    const stored = yield* io(() =>
      bucket.put(generationKey, generation, {
        onlyIf: { etagMatches: previous.etag },
      })
    );
    if (stored === null) return yield* new ErasureUnavailable();
    return [
      generationAssertion({ db: configuration.db, generation: previous.generation }),
      configuration.db
        .prepare("UPDATE erasure_generation SET generation=? WHERE id=1")
        .bind(generation),
    ];
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
          .prepare(`UPDATE erasure_requests SET marker_written=1,state='Archiving'
      WHERE id=? AND user_id=? AND state='Sealing' AND objects_captured=1 AND coordinator_cleared=1`)
          .bind(input.scope.reference, input.scope.userId),
      ])
    );
  });
