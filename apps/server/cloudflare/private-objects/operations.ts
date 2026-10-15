import { Clock, Effect, Option, Schema } from "effect";
import { newId } from "../secret-material/operations";
import {
  type PrivateObjectBucket,
  PrivateObjectUnavailable,
  type PrivateObjectWrite,
} from "./contract";

const maximumEtagLength = 128;
const controlLifetimeMs = 600000;
const Stored = Schema.Struct({
  etag: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumEtagLength)),
});
const io = <A>(run: () => Promise<A>): Effect.Effect<A, PrivateObjectUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new PrivateObjectUnavailable() });

/** A positive result confirms payload publication. Failed or cancelled calls require owner reconciliation. Cleanup invalidates the placeholder ETag, so a delayed payload cannot restore deleted bytes. */
export const writePrivateObject = <E, R>(
  input: PrivateObjectWrite<E, R>
): Effect.Effect<void, E | PrivateObjectUnavailable, R> =>
  Effect.gen(function* () {
    const nonce = yield* Effect.sync(newId);
    const placeholder = yield* io(() =>
      input.bucket.put(input.key, new TextEncoder().encode(nonce), {
        onlyIf: Option.match(input.predecessor, {
          onNone: () => ({ etagDoesNotMatch: "*" }),
          onSome: (etag) => ({ etagMatches: etag }),
        }),
        customMetadata: { ...input.metadata, purpose: "private-object-placeholder" },
      })
    );
    const stored = yield* Schema.decodeUnknownEffect(Stored)(placeholder).pipe(
      Effect.mapError(() => new PrivateObjectUnavailable())
    );
    if (!(yield* input.authorise)) return yield* new PrivateObjectUnavailable();
    const checksum = Option.match(input.digest, {
      onNone: () => ({}),
      onSome: (digest) => ({ sha256: Uint8Array.from(digest).buffer }),
    });
    const published = yield* io(() =>
      input.bucket.put(input.key, input.bytes, {
        onlyIf: { etagMatches: stored.etag },
        customMetadata: { ...input.metadata },
        ...checksum,
      })
    );
    yield* Schema.decodeUnknownEffect(Stored)(published).pipe(
      Effect.mapError(() => new PrivateObjectUnavailable())
    );
  });

/** Call only for an owner-qualified key whose disposition permits deletion. The nonce write must settle before deletion; a lost acknowledgement leaves cleanup unresolved. */
export const erasePrivateObject = (
  input: Readonly<{ bucket: PrivateObjectBucket; key: string }>
): Effect.Effect<void, PrivateObjectUnavailable> =>
  Effect.gen(function* () {
    const nonce = yield* Effect.sync(newId);
    const current = yield* Clock.currentTimeMillis;
    const fenced = yield* io(() =>
      input.bucket.put(input.key, new TextEncoder().encode(nonce), {
        customMetadata: {
          purpose: "private-object-erased",
          expiresAtMs: String(current + controlLifetimeMs),
        },
      })
    );
    yield* Schema.decodeUnknownEffect(Stored)(fenced).pipe(
      Effect.mapError(() => new PrivateObjectUnavailable())
    );
    yield* io(() => input.bucket.delete(input.key));
  });
