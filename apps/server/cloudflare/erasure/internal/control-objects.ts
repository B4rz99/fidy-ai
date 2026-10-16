import { Clock, Effect, Option, Schema } from "effect";
import { eraseObservedPrivateObject } from "../../private-objects/operations";
import { ErasureUnavailable } from "../../erasure-store/contract";

const maximumObjects = 32;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
type ControlSweep = Readonly<{
  db: D1Database;
  id: "email" | "statement" | "erasure";
  bucket: R2Bucket;
}>;
const expiredControl = (
  input: Readonly<{ object: R2Object; current: number }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const purpose = input.object.customMetadata?.purpose;
    if (purpose !== "private-object-placeholder" && purpose !== "private-object-erased") {
      return false;
    }
    const expiry = yield* Schema.decodeUnknownEffect(Schema.FiniteFromString)(
      input.object.customMetadata?.["expiresAtMs"]
    );
    if (!Number.isSafeInteger(expiry)) return yield* new ErasureUnavailable();
    return expiry <= input.current;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const sweepBucket = (input: ControlSweep): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const stored = yield* io(() =>
      input.db
        .prepare("SELECT cursor FROM erasure_control_sweeps WHERE bucket=?")
        .bind(input.id)
        .first<string>("cursor")
    );
    const cursor = Option.fromNullOr(stored);
    const page = yield* io(() =>
      input.bucket.list({
        limit: maximumObjects,
        include: ["customMetadata"],
        ...(Option.isSome(cursor) && cursor.value !== "" ? { cursor: cursor.value } : {}),
      })
    );
    const current = yield* Clock.currentTimeMillis;
    for (const object of page.objects) {
      if (!(yield* expiredControl({ object, current }))) continue;
      yield* eraseObservedPrivateObject({
        bucket: input.bucket,
        key: object.key,
        etag: object.etag,
      });
    }
    yield* io(() =>
      input.db
        .prepare(
          "INSERT INTO erasure_control_sweeps(bucket,cursor) VALUES(?,?) ON CONFLICT(bucket) DO UPDATE SET cursor=excluded.cursor"
        )
        .bind(input.id, page.truncated ? page.cursor : "")
        .run()
    );
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

/** Reconcile expired control-only placeholders/nonces, including late ambiguous writes whose owner row has gone. Financial payloads and held records are never swept by this metadata-only path. */
export const sweepControlObjects = (
  input: Readonly<{
    db: D1Database;
    buckets: ReadonlyArray<Readonly<{ id: ControlSweep["id"]; bucket: Option.Option<R2Bucket> }>>;
  }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.forEach(
    input.buckets,
    ({ id, bucket }) =>
      Option.match(bucket, {
        onNone: () => Effect.void,
        onSome: (present) => sweepBucket({ db: input.db, id, bucket: present }),
      }),
    { discard: true }
  );
