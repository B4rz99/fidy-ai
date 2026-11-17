import * as Alchemist from "alchemy/Alchemist";
import * as Apply from "alchemy/Apply";
import { describePlan } from "alchemy/Plan";
import { Cause, Config, Effect, Option, Schema } from "effect";
import { releaseCommand } from "./production-release";
import { resourceFailureMessage } from "./production-resources";
import { requireFreshPlan, requireNativeBindings } from "./storage-installation";

const Phase = Schema.Literals(["first-install", "upload"]);
const resourceRelease = Effect.fn(function* (phase: typeof Phase.Type) {
  const actions = yield* Config.String("GITHUB_ACTIONS");
  const ref = yield* Config.String("GITHUB_REF");
  const hold = yield* Config.String("NATIVE_STORAGE_ADMISSION");
  const event = yield* Config.String("GITHUB_EVENT_NAME");
  if (
    actions !== "true" ||
    ref !== "refs/heads/trunk" ||
    hold !== "closed" ||
    event !== "workflow_dispatch"
  ) {
    return yield* Effect.fail(Error("Requires the closed protected native workflow"));
  }
  const profile = yield* Config.String("ALCHEMY_PROFILE");
  const snapshot = yield* Alchemist.Stack.plan({
    target: { entrypoint: "alchemy.storage.ts", stage: "production", profile },
    operation: "deploy",
    updateStateStore: true,
  }).pipe(Effect.mapError(() => Error("Native resource planning failed")));
  const rows = describePlan(snapshot.native);
  yield* Effect.try(() => {
    requireNativeBindings(snapshot.native);
    if (phase === "first-install") {
      requireFreshPlan(rows);
      if (
        Object.values(snapshot.native.resources).some(
          (node) =>
            node.action !== "create" || node.state !== undefined || node.deferredAdoption?.adopt
        )
      ) {
        throw Error("Previous state exists");
      }
    } else if (
      rows.actions.length !== 0 ||
      rows.resources.length !== 2 ||
      rows.resources.some((row) => row.action !== "noop" && row.action !== "update")
    ) {
      throw Error("Native rollout refused a resource lifecycle change");
    }
  });
  yield* releaseCommand({
    args: [
      "bun",
      "native-storage-release.ts",
      phase === "upload" ? "verify-upload" : "verify-fresh-target",
    ],
    lifetime: "read-only",
  });
  return yield* Apply.apply(snapshot.native, { deletions: "defer" }).pipe(
    Effect.provide(snapshot.session.context),
    Effect.uninterruptible,
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.fail(Error(resourceFailureMessage(cause))))
  );
});
if (import.meta.main) {
  const program = Effect.gen(function* () {
    const phase = yield* Schema.decodeUnknownEffect(Phase)(process.argv[2]);
    yield* resourceRelease(phase);
  }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped);
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const reason = Cause.findErrorOption(cause);
          process.stderr.write(
            (Option.isSome(reason) && reason.value instanceof Error
              ? "Native resource guard or provider refused the operation."
              : resourceFailureMessage(cause)) + "\n"
          );
          process.exitCode = 1;
        })
      )
    )
  );
}
