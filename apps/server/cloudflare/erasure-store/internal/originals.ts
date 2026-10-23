import { erasePrivateObject } from "../../private-objects/operations";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureDecision } from "../../../src/core/erasure/contract";
import {
  type ErasureOriginalConfiguration,
  ErasureOriginalLocator,
  type ErasureScope,
  ErasureUnavailable,
} from "../contract";

const maximumObjects = 4;
const maximumCaptureObjects = 16;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });

export const capture = (
  input: Readonly<{ configuration: ErasureOriginalConfiguration; scope: ErasureScope }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { configuration, scope } = input;
    const keys = configuration.keys(scope.userId);
    const results = yield* io(() =>
      configuration.db.batch([
        configuration.db
          .prepare(`INSERT INTO erasure_objects(request_id,bucket,object_key)
      SELECT q.id,k.bucket,k.object_key FROM erasure_requests q,(${keys.sql}) k
      WHERE q.id=? AND q.user_id=? AND q.state='Sealing'
      AND NOT EXISTS(SELECT 1 FROM erasure_objects o WHERE o.request_id=q.id AND o.bucket=k.bucket AND o.object_key=k.object_key) LIMIT ?`)
          .bind(...keys.params, scope.reference, scope.userId, maximumCaptureObjects),
        configuration.db
          .prepare(`UPDATE erasure_requests SET objects_captured=1 WHERE id=? AND user_id=? AND state='Sealing'
      AND NOT EXISTS(SELECT 1 FROM (${keys.sql}) k WHERE NOT EXISTS(SELECT 1 FROM erasure_objects o WHERE o.request_id=? AND o.bucket=k.bucket AND o.object_key=k.object_key))`)
          .bind(scope.reference, scope.userId, ...keys.params, scope.reference),
        configuration.db
          .prepare(
            "SELECT objects_captured AS captured FROM erasure_requests WHERE id=? AND user_id=?"
          )
          .bind(scope.reference, scope.userId),
      ])
    );
    const result = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ captured: Schema.Literals([0, 1]) })
    )(results.at(-1)?.results[0]);
    return result.captured === 1;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const discardOne = (
  input: Readonly<{
    configuration: ErasureOriginalConfiguration;
    scope: ErasureScope;
    object: typeof ErasureOriginalLocator.Type;
  }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = input.configuration[input.object.bucket];
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    yield* erasePrivateObject({ bucket: bucket.value, key: input.object.key }).pipe(
      Effect.mapError(() => new ErasureUnavailable())
    );
    const retained = yield* io(() => bucket.value.head(input.object.key));
    if (retained !== null) return yield* new ErasureUnavailable();
    yield* io(() =>
      input.configuration.db
        .prepare(`UPDATE erasure_objects SET done=1 WHERE request_id=? AND bucket=? AND object_key=?
    AND EXISTS(SELECT 1 FROM erasure_requests WHERE id=? AND user_id=? AND state IN('Erasing','ExternalPending'))`)
        .bind(
          input.scope.reference,
          input.object.bucket,
          input.object.key,
          input.scope.reference,
          input.scope.userId
        )
        .run()
    );
  });

export const discard = (
  input: Readonly<{ configuration: ErasureOriginalConfiguration; scope: ErasureScope }>
): Effect.Effect<"Done" | "Continue" | "Retained", ErasureUnavailable> =>
  Effect.gen(function* () {
    const { configuration, scope } = input;
    const raw = yield* io(() =>
      configuration.db
        .prepare(
          "SELECT decision_json AS decision FROM erasure_requests WHERE id=? AND user_id=? AND objects_captured=1 AND marker_written=1 AND state IN('Erasing','ExternalPending')"
        )
        .bind(scope.reference, scope.userId)
        .first()
    );
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ decision: Schema.fromJsonString(ErasureDecision) })
    )(raw);
    const records = yield* io(() =>
      configuration.db
        .prepare(
          "SELECT bucket,object_key AS key FROM erasure_objects WHERE request_id=? AND done=0 LIMIT ?"
        )
        .bind(scope.reference, maximumObjects)
        .all()
    );
    if (records.results.length === 0) return "Done";
    const disposition = row.decision.dispositions.ingestion;
    if (
      disposition.action === "Retain" &&
      disposition.retention.untilMs > (yield* Clock.currentTimeMillis)
    ) {
      const uncopied = yield* io(() =>
        configuration.db
          .prepare(
            "SELECT count(*) AS pending FROM erasure_objects WHERE request_id=? AND retained_key IS NULL"
          )
          .bind(scope.reference)
          .first<number>("pending")
      );
      if (uncopied !== 0) return yield* new ErasureUnavailable();
    }
    const objects = yield* Schema.decodeUnknownEffect(Schema.Array(ErasureOriginalLocator))(
      records.results
    );
    yield* Effect.forEach(objects, (object) => discardOne({ ...input, object }), { discard: true });
    return "Continue";
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
