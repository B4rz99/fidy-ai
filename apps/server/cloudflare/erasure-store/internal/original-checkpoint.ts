import { Effect, Option, Schema } from "effect";
import {
  type ErasureOriginalConfiguration,
  ErasureOriginalLocator,
  type ErasureScope,
  ErasureUnavailable,
} from "../contract";

const maximumObjects = 8;
const maximumLocatorBytes = 2048;
type CheckpointInput = Readonly<{
  configuration: ErasureOriginalConfiguration;
  scope: ErasureScope;
}>;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const writeLocator = (
  input: CheckpointInput & Readonly<{ object: typeof ErasureOriginalLocator.Type }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = input.configuration.retained;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const tail = input.object.key.split("/").at(-1);
    if (tail === undefined) return yield* new ErasureUnavailable();
    const key = `recovery/objects/${input.scope.reference}/${input.object.bucket}/${tail}`;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureOriginalLocator))(
      input.object
    );
    const installed = yield* io(() =>
      bucket.value.put(key, encoded, { onlyIf: { etagDoesNotMatch: "*" } })
    );
    if (installed === null) {
      const previous = yield* io(() => bucket.value.get(key));
      if (previous === null || previous.size > maximumLocatorBytes) {
        return yield* new ErasureUnavailable();
      }
      if ((yield* io(() => previous.text())) !== encoded) return yield* new ErasureUnavailable();
    }
    yield* io(() =>
      input.configuration.db
        .prepare(`UPDATE erasure_objects SET recovery_written=1 WHERE request_id=? AND bucket=? AND object_key=?
    AND EXISTS(SELECT 1 FROM erasure_requests WHERE id=? AND user_id=? AND state='Sealing')`)
        .bind(
          input.scope.reference,
          input.object.bucket,
          input.object.key,
          input.scope.reference,
          input.scope.userId
        )
        .run()
    );
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
export const checkpointOriginals = (
  input: CheckpointInput
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* io(() =>
      input.configuration.db
        .prepare(`SELECT bucket,object_key AS key FROM erasure_objects o
    JOIN erasure_requests q ON q.id=o.request_id WHERE q.id=? AND q.user_id=? AND q.state='Sealing' AND o.recovery_written=0 LIMIT ?`)
        .bind(input.scope.reference, input.scope.userId, maximumObjects)
        .all()
    );
    const objects = yield* Schema.decodeUnknownEffect(Schema.Array(ErasureOriginalLocator))(
      raw.results
    );
    if (objects.length === 0) return true;
    yield* Effect.forEach(objects, (object) => writeLocator({ ...input, object }), {
      discard: true,
    });
    return false;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
