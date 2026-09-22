import { Data, Effect, Stream } from "effect";

/** Closed body-read failure safe to map to an HTTP reason without exposing stream details. */
export class BoundedBodyReadFailed extends Data.TaggedError("BoundedBodyReadFailed")<{
  readonly reason: "cancelled" | "malformed-file" | "resource-limit";
}> {}

/** Fails when the request aborts and removes its listener when the waiting fiber is interrupted. */
export const awaitRequestAbort = (request: Request): Effect.Effect<never, BoundedBodyReadFailed> =>
  Effect.callback((resume, fiberSignal) => {
    const onAbort = (): void =>
      resume(Effect.fail(new BoundedBodyReadFailed({ reason: "cancelled" })));
    const cleanup = (): void => request.signal.removeEventListener("abort", onAbort);
    request.signal.addEventListener("abort", onAbort, { once: true });
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
  const chunks: Array<Uint8Array> = [];
  let totalBytes = 0;
  yield* Effect.raceFirst(
    Stream.fromReadableStream<Uint8Array, BoundedBodyReadFailed>({
      evaluate: () => body,
      onError: () => new BoundedBodyReadFailed({ reason: "malformed-file" }),
    }).pipe(
      Stream.runForEachWhile((chunk) =>
        Effect.sync(() => {
          totalBytes += chunk.byteLength;
          if (totalBytes > maximumBytes) return false;
          chunks.push(chunk);
          return true;
        })
      )
    ),
    awaitRequestAbort(request)
  );
  if (totalBytes > maximumBytes) {
    return yield* new BoundedBodyReadFailed({ reason: "resource-limit" });
  }

  const collected = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    collected.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return collected;
});
