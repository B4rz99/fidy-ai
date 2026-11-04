import { Effect, Schema } from "effect";
import {
  type RecoveryAdmissionBinding,
  RecoveryClose,
  RecoveryControllerClaim,
  RecoveryLease,
} from "./contract";

export { RecoveryAdmissionGate } from "./runtime";

const LeaseCommand = Schema.Struct({
  action: Schema.Literals(["enter", "complete", "enterContinuation"]),
  input: RecoveryLease,
});
const ControllerCommand = Schema.Struct({
  action: Schema.Literals(["acquireController", "releaseController", "retainController"]),
  input: RecoveryControllerClaim,
});
const TransitionCommand = Schema.Struct({
  action: Schema.Literals(["pause", "close"]),
  input: RecoveryClose,
});
const Command = Schema.Union([
  Schema.Struct({ action: Schema.Literal("inspect") }),
  LeaseCommand,
  ControllerCommand,
  TransitionCommand,
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
        if ("claimId" in command.input) {
          const selected = yield* Schema.decodeUnknownEffect(ControllerCommand)(command);
          return Response.json(
            yield* Effect.tryPromise(() => gate[selected.action](selected.input))
          );
        }
        if ("leaseId" in command.input) {
          const selected = yield* Schema.decodeUnknownEffect(LeaseCommand)(command);
          return Response.json(
            yield* Effect.tryPromise(() => gate[selected.action](selected.input))
          );
        }
        const selected = yield* Schema.decodeUnknownEffect(TransitionCommand)(command);
        return Response.json(yield* Effect.tryPromise(() => gate[selected.action](selected.input)));
      })
    ),
};
