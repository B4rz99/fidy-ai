import { UserId } from "../../src/core/identity/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { newId } from "../secret-material/operations";
import {
  type PrivateObjectBucket,
  PrivateObjectKey,
  PrivateObjectUnavailable,
  type PrivateObjectWrite,
} from "./contract";

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
      Effect.mapError((cause) => new PrivateObjectUnavailable({ cause: Option.some(cause) }))
    );

    const key = yield* Schema.decodeEffect(PrivateObjectKey)(input.key).pipe(
      Effect.mapError((cause) => new PrivateObjectUnavailable({ cause: Option.some(cause) }))
    );

    const prefix = userPrivateObjectPrefix(userId);

    if (!key.startsWith(prefix) || key.length === prefix.length) {
      return yield* new PrivateObjectUnavailable({ cause: Option.none() });
    }
  });

const io = <A>(run: () => Promise<A>): Effect.Effect<A, PrivateObjectUnavailable> =>
  Effect.tryPromise({
    try: run,
    catch: () => new PrivateObjectUnavailable({ cause: Option.none() }),
  });

type TrackedWrite<E, R> = PrivateObjectWrite<E, R> & {
  put: (
    key: string,
    bytes: Uint8Array,
    options: R2PutOptions
  ) => Effect.Effect<unknown, E | PrivateObjectUnavailable, R>;
};

const publishPrivateObject = <E, R>(
  input: TrackedWrite<E, R>
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
        return yield* new PrivateObjectUnavailable({ cause: Option.none() });
      }
    }

    const nonce = yield* Effect.sync(newId);
    const current = yield* Clock.currentTimeMillis;

    const placeholder = yield* input.put(input.key, new TextEncoder().encode(nonce), {
      onlyIf: Option.match(input.predecessor, {
        onNone: () => ({ etagDoesNotMatch: "*" }),
        onSome: ({ etag }) => ({ etagMatches: etag }),
      }),
      customMetadata: {
        ...input.metadata,
        purpose: "private-object-placeholder",
        expiresAtMs: String(current + controlLifetimeMs),
      },
    });

    const stored = yield* Schema.decodeUnknownEffect(Stored)(placeholder).pipe(
      Effect.mapError((cause) => new PrivateObjectUnavailable({ cause: Option.some(cause) }))
    );

    if (!(yield* input.authorise)) {
      return yield* new PrivateObjectUnavailable({ cause: Option.none() });
    }

    const checksum = Option.match(input.digest, {
      onNone: () => ({}),
      onSome: (digest) => ({ sha256: Uint8Array.from(digest).buffer }),
    });

    const published = yield* input.put(input.key, input.bytes, {
      onlyIf: { etagMatches: stored.etag },
      customMetadata: { ...input.metadata },
      ...checksum,
    });

    yield* Schema.decodeUnknownEffect(Stored)(published).pipe(
      Effect.mapError((cause) => new PrivateObjectUnavailable({ cause: Option.some(cause) }))
    );
  });

export const erasePrivateObject = (
  input: Readonly<{ bucket: PrivateObjectBucket; userId: string; key: string }>
): Effect.Effect<void, PrivateObjectUnavailable> =>
  validateTarget(input).pipe(
    Effect.andThen(io(() => input.bucket.delete(input.key))),
    Effect.asVoid
  );

export const resumePrivateUpload = Effect.fn(function* <E, R>(
  work: TrackedWrite<E, R>,
  observed: Option.Option<R2Object>
) {
  if (
    Option.isNone(observed) ||
    observed.value.customMetadata?.purpose !== "private-object-placeholder"
  ) {
    return yield* publishPrivateObject(work);
  }

  yield* validateTarget(work);
  const metadata = observed.value.customMetadata;

  if (metadata.sha256 !== work.metadata.sha256 || !(yield* work.authorise)) {
    return yield* new PrivateObjectUnavailable({ cause: Option.none() });
  }

  const checksum = Option.match(work.digest, {
    onNone: () => ({}),
    onSome: (value) => ({ sha256: Uint8Array.from(value).buffer }),
  });

  const written = yield* work.put(work.key, work.bytes, {
    onlyIf: { etagMatches: observed.value.etag },
    customMetadata: { ...work.metadata },
    ...checksum,
  });

  yield* Schema.decodeUnknownEffect(Stored)(written).pipe(
    Effect.mapError((cause) => new PrivateObjectUnavailable({ cause: Option.some(cause) }))
  );
});
