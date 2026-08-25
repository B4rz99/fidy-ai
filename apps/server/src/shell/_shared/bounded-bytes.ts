import { Effect, Option, Stream } from "effect";

/**
 * Reads a streamed body without letting an oversized body fill memory. Stops at the byte limit and
 * returns `None`; otherwise returns the collected bytes.
 */
export const collectBoundedBytes = Effect.fn("collectBoundedBytes")(function* <E, R>(
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
