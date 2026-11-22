import { Data, Effect, Stream } from "effect";

export class BoundedBytesExceeded extends Data.TaggedError("BoundedBytesExceeded")<{
  readonly maximumBytes: number;
}> {}

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

      if (chunk.byteLength === 0) return true;
      chunks.push(chunk);
      byteLength += chunk.byteLength;

      return true;
    })
  );

  if (byteLength > maximumBytes) return yield* new BoundedBytesExceeded({ maximumBytes });
  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
});
