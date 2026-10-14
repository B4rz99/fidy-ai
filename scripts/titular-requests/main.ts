import { BunServices } from "@effect/platform-bun";
import { Effect, Schema, Stream } from "effect";
import { CaseReceipt, RegisterFailure } from "./contract";
import { runCaseRegister } from "./runtime";

const maximumInputBytes = 4096;
const readInput = Effect.gen(function* () {
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
const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const directory = args[0];
  if (args.length !== 1 || directory === undefined) {
    return yield* new RegisterFailure({ reason: "InvalidInput" });
  }
  const request: unknown = yield* readInput;
  const result = yield* runCaseRegister({ directory, request });
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(CaseReceipt))(result);
  yield* Effect.tryPromise(() => Bun.write(Bun.stdout, text + "\n"));
}).pipe(Effect.provide(BunServices.layer));

if (import.meta.main) {
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          // The entrypoint reports only closed failure classes, never native errors or rejected input.
          const failure = cause.reasons.find(
            (reason) => reason._tag === "Fail" && reason.error instanceof RegisterFailure
          );
          const reason =
            failure?._tag === "Fail" && failure.error instanceof RegisterFailure
              ? failure.error.reason
              : "Unavailable";
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
          )({ error: reason });
          yield* Effect.tryPromise(() => Bun.write(Bun.stderr, encoded + "\n"));
          process.exitCode = 1;
        })
      )
    )
  );
}
