import { Cause, Effect, Option, Predicate, Schema } from "effect";
import {
  BoundedBodyReadFailed,
  RequestBodyCapacityExceeded,
  RequestBodyDeadlineExceeded,
  type RequestBodyPolicy,
  RequestBodyUnreadable,
} from "./contract";

export const awaitRequestAbort = (
  request: Pick<Request, "signal">
): Effect.Effect<never, BoundedBodyReadFailed> =>
  Effect.callback((resume, fiberSignal) => {
    const onAbort = (): void => {
      cleanup();
      resume(Effect.fail(new BoundedBodyReadFailed({ reason: "cancelled" })));
    };

    const cleanup = (): void => request.signal.removeEventListener("abort", onAbort);
    request.signal.addEventListener("abort", onAbort, { once: true });

    if (request.signal.aborted) onAbort();
    fiberSignal.addEventListener("abort", cleanup, { once: true });

    return Effect.sync(cleanup);
  });

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
            reason: Predicate.isTagged(failure, "RequestBodyCapacityExceeded")
              ? "resource-limit"
              : "malformed-file",
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
    } catch {}
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
    if (!Predicate.isUint8Array(next.value)) return yield* new RequestBodyUnreadable();

    if (byteLength + next.value.byteLength > maximumBytes) {
      return yield* new RequestBodyCapacityExceeded();
    }

    if (next.value.byteLength > 0) chunks.push(next.value);
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

export const readBoundedRequestBody = Effect.fn(function* (
  request: Pick<Request, "signal" | "body">,
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

export const boundedJsonBodyWithSize = <A extends Schema.ConstraintDecoder<unknown>>({
  request,
  policy,
  schema,
}: Readonly<{ request: Request; policy: RequestBodyPolicy; schema: A }>): Effect.Effect<
  Option.Option<{ value: A["Type"]; byteLength: number }>
> =>
  Effect.gen(function* () {
    if (request.signal.aborted) return yield* Effect.failCause(Cause.interrupt());

    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      return Option.none();
    }

    return yield* readBoundedRequestBody(request, policy).pipe(
      Effect.flatMap((bytes) =>
        Effect.gen(function* () {
          const text = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: () => new RequestBodyUnreadable(),
          });

          const json = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text);
          const value = yield* Schema.decodeUnknownEffect(schema)(json);

          return { value, byteLength: bytes.byteLength };
        })
      ),
      Effect.option
    );
  });

export const boundedJsonBody = <A extends Schema.ConstraintDecoder<unknown>>({
  request,
  policy,
  schema,
}: Readonly<{ request: Request; policy: RequestBodyPolicy; schema: A }>): Effect.Effect<
  Option.Option<A["Type"]>
> =>
  boundedJsonBodyWithSize({ request, policy, schema }).pipe(
    Effect.map(Option.map(({ value }) => value))
  );

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

export const rawPathId = ({ request }: Readonly<{ request: Request }>): string =>
  new URL(request.url).pathname.split("/").at(-1) ?? "";
