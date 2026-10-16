import { readPrivateJsonInput } from "./input";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { CaseReceipt, RegisterFailure } from "./contract";
import { runCaseRegister } from "./runtime";

const maximumInputBytes = 4096;

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const directory = args[0];
  if (args.length !== 1 || directory === undefined) {
    return yield* new RegisterFailure({ reason: "InvalidInput" });
  }
  const request: unknown = yield* readPrivateJsonInput(maximumInputBytes);
  const result = yield* runCaseRegister({ directory, request });
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(CaseReceipt))(result);
  yield* Effect.tryPromise(() => Bun.write(Bun.stdout, text + "\n"));
}).pipe(Effect.provide(BunServices.layer));

if (import.meta.main) {
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
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
