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
      onError: () => RegisterFailure.make({ reason: "InvalidInput" }),
    }).pipe(
      Stream.runForEach((chunk) => {
        bytes += chunk.byteLength;

        if (bytes > maximumInputBytes) {
          return Effect.fail(RegisterFailure.make({ reason: "InvalidInput" }));
        }

        return Effect.try({
          try: () => {
            text += decoder.decode(chunk, { stream: true });
          },
          catch: () => RegisterFailure.make({ reason: "InvalidInput" }),
        });
      }),
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) => RegisterFailure.make({ reason: "InvalidInput", cause }))
    );

    const input = yield* Effect.try({
      try: () => text + decoder.decode(),
      catch: () => RegisterFailure.make({ reason: "InvalidInput" }),
    });

    return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(input).pipe(
      Effect.mapError((cause) => RegisterFailure.make({ reason: "InvalidInput", cause }))
    );
  });
