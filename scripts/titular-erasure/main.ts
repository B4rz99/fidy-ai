import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { ErasureDecision } from "../../apps/server/src/core/erasure/contract";
import { RegisterFailure } from "../titular-requests/contract";
import { readPrivateJsonInput } from "../titular-requests/input";
import { runCaseRegister } from "../titular-requests/runtime";
import { prepareErasureReview } from "./operations";

const maximumInputBytes = 16384;
const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const directory = args[0];
  if (args.length !== 1 || directory === undefined) {
    return yield* new RegisterFailure({ reason: "InvalidInput" });
  }
  const decision = yield* Schema.decodeUnknownEffect(ErasureDecision, {
    onExcessProperty: "error",
  })(yield* readPrivateJsonInput(maximumInputBytes));
  const receipt = yield* runCaseRegister({
    directory,
    request: { operation: "Read", caseId: decision.caseRef },
  });
  const command = yield* prepareErasureReview({ case: receipt.case, decision });
  const body = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({ action: Schema.Literal("Review"), decision: ErasureDecision })
    )
  )(command);
  yield* Effect.tryPromise(() => Bun.write(Bun.stdout, body + "\n"));
}).pipe(Effect.provide(BunServices.layer));

if (import.meta.main) {
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause(() =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            Bun.write(Bun.stderr, '{"error":"ErasureReviewUnavailable"}\n')
          );
          process.exitCode = 1;
        })
      )
    )
  );
}
