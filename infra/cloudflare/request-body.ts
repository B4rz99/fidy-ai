import { Cause, Data, Effect, Schema } from "effect";

/** The public request body exceeded the route's byte budget before it was accepted. */
export class RequestBodyCapacityExceeded extends Data.TaggedError("RequestBodyCapacityExceeded") {}

/** The public request body did not finish before the route's read deadline. */
export class RequestBodyDeadlineExceeded extends Data.TaggedError("RequestBodyDeadlineExceeded") {}

/** The public request body stream could not be acquired or read to completion. */
export class RequestBodyUnreadable extends Data.TaggedError("RequestBodyUnreadable") {}

const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

/**
 * Route-owned byte budget and deadline for accepting one public Worker request body. Decode route
 * constants through this schema so non-positive, non-finite, and fractional limits are impossible.
 */
export const RequestBodyPolicy = Schema.Struct({
  maximumBytes: PositiveInteger.pipe(Schema.brand("RequestBodyMaximumBytes")),
  deadlineMilliseconds: PositiveInteger.pipe(Schema.brand("RequestBodyDeadlineMilliseconds")),
});
export type RequestBodyPolicy = typeof RequestBodyPolicy.Type;

const releaseLock = (reader: ReadableStreamDefaultReader<unknown>): Effect.Effect<void> =>
  Effect.try({
    try: () => reader.releaseLock(),
    catch: () => undefined,
  }).pipe(Effect.ignore);

const releaseReader = (reader: ReadableStreamDefaultReader<unknown>): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      reader.cancel().catch(() => undefined);
    } catch {
      // A synchronous cancellation failure must not prevent the lock-release finalizer.
    }
  }).pipe(Effect.ensuring(releaseLock(reader)));

const readNextChunk = (
  reader: ReadableStreamDefaultReader<unknown>
): Effect.Effect<ReadableStreamReadResult<unknown>, RequestBodyUnreadable> =>
  Effect.tryPromise({
    try: () => reader.read(),
    catch: () => new RequestBodyUnreadable(),
  });

const collectBody = Effect.fn(function* (
  reader: ReadableStreamDefaultReader<unknown>,
  maximumBytes: number
) {
  const chunks: Array<Uint8Array> = [];
  let byteLength = 0;
  let next = yield* readNextChunk(reader);
  while (!next.done) {
    if (!(next.value instanceof Uint8Array)) return yield* new RequestBodyUnreadable();
    if (byteLength + next.value.byteLength > maximumBytes) {
      return yield* new RequestBodyCapacityExceeded();
    }
    chunks.push(next.value);
    byteLength += next.value.byteLength;
    next = yield* readNextChunk(reader);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
});

/**
 * Reads one public Worker request body under a route-owned byte budget and deadline. The caller must
 * provide policy values decoded through `RequestBodyPolicy` and may begin business effects only
 * after this succeeds. Failure or interruption initiates cancellation and releases the reader lock without
 * waiting on an untrusted cancellation promise; failures retain no body detail.
 */
export const readBoundedRequestBody = Effect.fn(function* (
  request: Request,
  policy: RequestBodyPolicy
) {
  const stream = request.body;
  if (stream === null) return new Uint8Array();

  const acquireReader: Effect.Effect<
    ReadableStreamDefaultReader<unknown>,
    RequestBodyUnreadable
  > = Effect.try({
    try: (): ReadableStreamDefaultReader<unknown> => stream.getReader(),
    catch: () => new RequestBodyUnreadable(),
  });
  const read = Effect.acquireUseRelease(
    acquireReader,
    (reader) => collectBody(reader, policy.maximumBytes),
    releaseReader
  );

  return yield* read.pipe(
    Effect.timeout(policy.deadlineMilliseconds),
    Effect.mapError((failure) =>
      Cause.isTimeoutError(failure) ? new RequestBodyDeadlineExceeded() : failure
    )
  );
});
