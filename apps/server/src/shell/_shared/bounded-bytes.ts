import { Effect, Option, Stream } from "effect";
import type { HttpClientResponse } from "effect/unstable/http";

/**
 * Reads a streamed body without letting an oversized body fill memory. Stops at the byte limit and
 * returns `None`; otherwise returns the collected bytes.
 */
export const collectBoundedBytes = Effect.fn(function* <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maximumBytes: number
) {
  const chunks: Array<Uint8Array> = [];
  let byteLength = 0;
  yield* Stream.runForEachWhile(stream, (chunk) =>
    Effect.sync(() => {
      if (byteLength + chunk.byteLength > maximumBytes) {
        byteLength = maximumBytes + 1;
        return false;
      }
      chunks.push(chunk);
      byteLength += chunk.byteLength;
      return true;
    })
  );
  if (byteLength > maximumBytes) return Option.none<Uint8Array>();
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Option.some(bytes);
});

/**
 * Reads a provider response up to `maximumBytes`. A declared oversized body is rejected before
 * collection, while the streamed byte count remains authoritative when the header is absent or
 * dishonest. Early termination closes the response stream owned by the HTTP client.
 */
export const collectBoundedResponseBytes = Effect.fn("collectBoundedResponseBytes")(function* (
  response: HttpClientResponse.HttpClientResponse,
  maximumBytes: number
) {
  const declaredLength = Number(response.headers["content-length"] ?? 0);
  if (declaredLength > maximumBytes) {
    return yield* Effect.scoped(
      Stream.toPull(response.stream).pipe(Effect.as(Option.none<Uint8Array>()))
    );
  }
  return yield* collectBoundedBytes(response.stream, maximumBytes);
});
