import { requireHostPlan, stagedAccessApplications } from "./native-host-plan";
import * as Alchemist from "alchemy/Alchemist";
import * as Apply from "alchemy/Apply";
import { requireNativeResourcePlan } from "./native-graph";
import { describePlan } from "alchemy/Plan";
import { Cause, Config, Effect, Option, Schema } from "effect";
import { releaseCommand } from "./production-release";
import { resourceFailureMessage } from "./production-resources";
import { requireNativeBindings } from "./storage-installation";

const Phase = Schema.Literals(["first-install", "upload", "stage-hosts"]);
const requireProtectedDispatch = Effect.gen(function* () {
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
});
const releaseChecks = {
  "first-install": "prepare-closed-edge",
  upload: "verify-upload",
  "stage-hosts": "capture-hosts",
} as const;
const resourceRelease = Effect.fn(function* (phase: typeof Phase.Type) {
  yield* requireProtectedDispatch;
  const revision = yield* Config.String("RELEASE_GIT_SHA");
  const profile = yield* Config.String("ALCHEMY_PROFILE");
  const hosts = yield* Config.Literals(["acceptance", "staged"], "NATIVE_STORAGE_HOSTS").pipe(
    Config.withDefault("acceptance")
  );
  if (
    (phase === "stage-hosts" && hosts !== "staged") ||
    (phase === "first-install" && hosts !== "acceptance")
  ) {
    return yield* Effect.fail(Error("Unexpected native host selection"));
  }
  const input = {
    target: { entrypoint: "alchemy.storage.ts", stage: "production", profile },
    operation: "deploy",
    updateStateStore: true,
  } as const;
  const snapshot = yield* (
    phase === "stage-hosts"
      ? Alchemist.Stack.plan({ ...input, include: stagedAccessApplications })
      : Alchemist.Stack.plan(input)
  ).pipe(Effect.mapError(() => Error("Native resource planning failed")));
  const rows = describePlan(snapshot.native);
  yield* Effect.try(() => {
    if (phase === "stage-hosts") return requireHostPlan(snapshot.native);
    requireNativeBindings({ plan: snapshot.native, revision, hosts });
    requireNativeResourcePlan({ plan: rows, revision, first: phase === "first-install" });
    if (phase === "first-install") {
      if (
        Object.values(snapshot.native.resources).some(
          (node) =>
            node.action !== "create" || node.state !== undefined || node.deferredAdoption?.adopt
        )
      ) {
        throw Error("Previous state exists");
      }
    }
  });
  yield* releaseCommand({
    args: ["bun", "native-storage-release.ts", releaseChecks[phase]],
    lifetime: phase === "upload" ? "read-only" : "started-write",
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
