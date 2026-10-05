import { Cause, Effect, Option, Schema } from "effect";
import {
  BoundedBodyReadFailed,
  RequestBodyCapacityExceeded,
  RequestBodyDeadlineExceeded,
  type RequestBodyPolicy,
  RequestBodyUnreadable,
} from "./contract";

/** Fails when the request aborts and removes its listener when the waiting fiber is interrupted. */
export const awaitRequestAbort = (request: Request): Effect.Effect<never, BoundedBodyReadFailed> =>
  Effect.callback((resume, fiberSignal) => {
    const onAbort = (): void => {
      // A synchronous resume bypasses callback's returned finalizer in installed Effect 4.
      cleanup();
      resume(Effect.fail(new BoundedBodyReadFailed({ reason: "cancelled" })));
    };
    const cleanup = (): void => request.signal.removeEventListener("abort", onAbort);
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    fiberSignal.addEventListener("abort", cleanup, { once: true });
    return Effect.sync(cleanup);
  });

/**
 * Collects a request stream up to `maximumBytes`; aborts collection at the first excess chunk and
 * fails for cancellation, malformed streams, or resource exhaustion without returning partial data.
 */
export const collectBoundedRequestBody = Effect.fn(function* (
  request: Request,
  maximumBytes: number
) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return yield* new BoundedBodyReadFailed({ reason: "resource-limit" });
  }
  if (request.signal.aborted) {
    return yield* new BoundedBodyReadFailed({ reason: "cancelled" });
  }
  if (request.body === null) return new Uint8Array();

  const body = request.body;
  return yield* Effect.raceFirst(
    Effect.acquireUseRelease(
      Effect.try({ try: () => body.getReader(), catch: () => new RequestBodyUnreadable() }),
      (reader) => collectBody(reader, maximumBytes),
      releaseReader
    ).pipe(
      Effect.mapError(
        (failure) =>
          new BoundedBodyReadFailed({
            reason:
              failure._tag === "RequestBodyCapacityExceeded" ? "resource-limit" : "malformed-file",
          })
      )
    ),
    awaitRequestAbort(request)
  );
});

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
): Effect.Effect<
  Awaited<ReturnType<ReadableStreamDefaultReader<unknown>["read"]>>,
  RequestBodyUnreadable
> =>
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
  if (request.signal.aborted) return yield* Effect.failCause(Cause.interrupt());
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

  return yield* Effect.raceFirst(
    read.pipe(
      Effect.timeout(policy.deadlineMilliseconds),
      Effect.mapError((failure) =>
        Cause.isTimeoutError(failure) ? new RequestBodyDeadlineExceeded() : failure
      )
    ),
    awaitRequestAbort(request).pipe(Effect.catch(() => Effect.failCause(Cause.interrupt())))
  );
});

/**
 * Decode one bounded JSON request body against a route schema. A non-JSON content type and any
 * unreadable, oversized, late, malformed, or schema-invalid body are all refused as `Option.none`
 * without retaining any body detail. Request cancellation and caller interruption remain interruption,
 * never malformed-input absence.
 */
export const boundedJsonBody = <A extends Schema.ConstraintDecoder<unknown>>({
  request,
  policy,
  schema,
}: Readonly<{ request: Request; policy: RequestBodyPolicy; schema: A }>): Effect.Effect<
  Option.Option<A["Type"]>
> =>
  Effect.gen(function* () {
    if (request.signal.aborted) return yield* Effect.failCause(Cause.interrupt());
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
      return Option.none();
    }
    return yield* readBoundedRequestBody(request, policy).pipe(
      Effect.flatMap((bytes) =>
        Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: () => new RequestBodyUnreadable(),
        })
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.option
    );
  });

/**
 * The stable id the final segment of this request's path addresses, decoded by that id's own
 * schema, or None when the segment is absent or is not a stable identity.
 */
export const pathId = <A extends Schema.ConstraintDecoder<unknown>>({
  schema,
  request,
}: Readonly<{
  schema: A;
  request: Request;
}>): Option.Option<A["Type"]> =>
  Option.flatMap(Option.fromUndefinedOr(new URL(request.url).pathname.split("/").at(-1)), (raw) =>
    Schema.decodeOption(schema)(raw)
  );

/**
 * The final path segment exactly as it arrived, undecoded, for a route that must forward an
 * unstable id instead of answering for it. The empty string stands for a path that carries no
 * segment at all; both spellings reach the owner, which is the only place that decides whether
 * the id is a retained one. Prefer `pathId` when the route itself answers 404 for an id that is
 * not a stable identity.
 */
export const rawPathId = ({ request }: Readonly<{ request: Request }>): string =>
  new URL(request.url).pathname.split("/").at(-1) ?? "";
