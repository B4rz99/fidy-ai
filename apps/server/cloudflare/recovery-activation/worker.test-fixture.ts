import { Effect, Schema } from "effect";
import { type RecoveryAdmissionBinding, RecoveryClose, RecoveryLease } from "./contract";

export { RecoveryAdmissionGate } from "./runtime";

const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literal("inspect") }),
  Schema.Struct({
    action: Schema.Literals(["enter", "complete", "enterContinuation"]),
    input: RecoveryLease,
  }),
  Schema.Struct({ action: Schema.Literal("pause"), input: RecoveryClose }),
  Schema.Struct({ action: Schema.Literal("close"), input: RecoveryClose }),
]);
export default {
  fetch: (
    request: Request,
    environment: Readonly<{ GATE: { getByName: (name: string) => RecoveryAdmissionBinding } }>
  ): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const command = yield* Schema.decodeUnknownEffect(Command)(
          yield* Effect.tryPromise(() => request.json())
        );
        const gate = environment.GATE.getByName(
          new URL(request.url).pathname === "/replacement" ? "replacement" : "source-only"
        );
        if (command.action === "inspect") {
          return Response.json(yield* Effect.tryPromise(() => gate.inspect()));
        }
        if (command.action === "pause" || command.action === "close") {
          return Response.json(yield* Effect.tryPromise(() => gate[command.action](command.input)));
        }
        return Response.json(yield* Effect.tryPromise(() => gate[command.action](command.input)));
      })
    ),
};
