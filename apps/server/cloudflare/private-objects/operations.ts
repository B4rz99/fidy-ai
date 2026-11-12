import { UserId } from "../../src/core/identity/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { newId } from "../secret-material/operations";
import {
  type PrivateObjectBucket,
  PrivateObjectKey,
  PrivateObjectUnavailable,
  type PrivateObjectWrite,
} from "./contract";

/** Delimited stable-User namespace, shared across every private content bucket. */
export const userPrivateObjectPrefix = (userId: UserId): string => `users/${userId}/`;

const maximumEtagLength = 128;
const controlLifetimeMs = 600000;
const Etag = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumEtagLength));
const Stored = Schema.Struct({ etag: Etag });
const PayloadPredecessor = Schema.Struct({ etag: Etag, purpose: Schema.NonEmptyString });
const validateTarget = (
  input: Readonly<{ userId: string; key: string }>
): Effect.Effect<void, PrivateObjectUnavailable> =>
  Effect.gen(function* () {
    const userId = yield* Schema.decodeEffect(UserId)(input.userId).pipe(
      Effect.mapError(() => new PrivateObjectUnavailable())
    );
    const key = yield* Schema.decodeEffect(PrivateObjectKey)(input.key).pipe(
      Effect.mapError(() => new PrivateObjectUnavailable())
    );
    const prefix = userPrivateObjectPrefix(userId);
    if (!key.startsWith(prefix) || key.length === prefix.length) {
      return yield* new PrivateObjectUnavailable();
    }
  });
const io = <A>(run: () => Promise<A>): Effect.Effect<A, PrivateObjectUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new PrivateObjectUnavailable() });

/** A positive result confirms payload publication. Failed or cancelled calls require owner reconciliation. Cleanup invalidates the placeholder ETag, so a delayed payload cannot restore deleted bytes. */
export const writePrivateObject = <E, R>(
  input: PrivateObjectWrite<E, R>
): Effect.Effect<void, E | PrivateObjectUnavailable, R> =>
  Effect.gen(function* () {
    yield* validateTarget(input);
    if (Option.isSome(input.predecessor)) {
      const previous = input.predecessor.value;
      if (
        Option.isNone(Schema.decodeOption(PayloadPredecessor)(previous)) ||
        previous.purpose === "private-object-placeholder" ||
        previous.purpose === "private-object-erased"
      ) {
        return yield* new PrivateObjectUnavailable();
      }
    }
    const nonce = yield* Effect.sync(newId);
    const current = yield* Clock.currentTimeMillis;
    const placeholder = yield* io(() =>
      input.bucket.put(input.key, new TextEncoder().encode(nonce), {
        onlyIf: Option.match(input.predecessor, {
          onNone: () => ({ etagDoesNotMatch: "*" }),
          onSome: ({ etag }) => ({ etagMatches: etag }),
        }),
        customMetadata: {
          ...input.metadata,
          purpose: "private-object-placeholder",
          expiresAtMs: String(current + controlLifetimeMs),
        },
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

/** Delete an owner-qualified key only after its disposition permits deletion. Removing the placeholder invalidates a delayed payload's ETag without creating another object; unknown upload outcomes remain the owner's drain responsibility. */
export const erasePrivateObject = (
  input: Readonly<{ bucket: PrivateObjectBucket; userId: string; key: string }>
): Effect.Effect<void, PrivateObjectUnavailable> =>
  validateTarget(input).pipe(
    Effect.andThen(io(() => input.bucket.delete(input.key))),
    Effect.asVoid
  );

/** Trusted control sweep only. Preserve replacements that win before the fence. After its valid
 * acknowledgement, deletion is unconditional: lawful writers must exclude control predecessors.
 * A lost acknowledgement forbids deletion; even successful cleanup cannot settle an unknown writer. */
export const eraseObservedPrivateObject = (
  input: Readonly<{ bucket: PrivateObjectBucket; key: string; etag: string }>
): Effect.Effect<void, PrivateObjectUnavailable> =>
  Effect.gen(function* () {
    const nonce = yield* Effect.sync(newId);
    const current = yield* Clock.currentTimeMillis;
    const fenced = yield* io(() =>
      input.bucket.put(input.key, new TextEncoder().encode(nonce), {
        onlyIf: { etagMatches: input.etag },
        customMetadata: {
          purpose: "private-object-erased",
          expiresAtMs: String(current + controlLifetimeMs),
        },
      })
    );
    if (fenced === null) return;
    yield* Schema.decodeUnknownEffect(Stored)(fenced).pipe(
      Effect.mapError(() => new PrivateObjectUnavailable())
    );
    yield* io(() => input.bucket.delete(input.key));
  });
