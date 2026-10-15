import { Effect, Schema, Stream } from "effect";
import { RegisterFailure } from "./contract";

export const readPrivateJsonInput = (
  maximumInputBytes: number
): Effect.Effect<unknown, RegisterFailure> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    yield* Stream.fromReadableStream({
      evaluate: () => Bun.stdin.stream(),
      onError: () => new RegisterFailure({ reason: "InvalidInput" }),
    }).pipe(
      Stream.runForEach((chunk) => {
        bytes += chunk.byteLength;
        if (bytes > maximumInputBytes) {
          return Effect.fail(new RegisterFailure({ reason: "InvalidInput" }));
        }
        return Effect.try({
          try: () => {
            text += decoder.decode(chunk, { stream: true });
          },
          catch: () => new RegisterFailure({ reason: "InvalidInput" }),
        });
      }),
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new RegisterFailure({ reason: "InvalidInput" }))
    );
    const input = yield* Effect.try({
      try: () => text + decoder.decode(),
      catch: () => new RegisterFailure({ reason: "InvalidInput" }),
    });
    return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(input).pipe(
      Effect.mapError(() => new RegisterFailure({ reason: "InvalidInput" }))
    );
  });
