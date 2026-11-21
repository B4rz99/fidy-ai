import { readPrivateJsonInput } from "./input";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Schema } from "effect";
import { CaseReceipt, RegisterFailure } from "./contract";
import { runCaseRegister } from "./runtime";

const maximumInputBytes = 4096;

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const directory = args[0];

  if (args.length !== 1 || directory === undefined) {
    return yield* RegisterFailure.make({ reason: "InvalidInput" });
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
          const reason =
            cause.reasons
              .values()
              .filter(Cause.isFailReason)
              .map((failure) => failure.error)
              .find(Schema.is(RegisterFailure))?.reason ?? "Unavailable";

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
