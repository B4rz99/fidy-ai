import { productionTopology } from "../../apps/server/cloudflare/runtime/contract";
import { requireHostPlan, stagedAccessApplications } from "./native-host-plan";
import * as Alchemist from "alchemy/Alchemist";
import * as Apply from "alchemy/Apply";
import { requireNativeResourcePlan } from "./native-graph";
import { describePlan, describeResource } from "alchemy/Plan";
import { Config, Effect, Schema } from "effect";
import { releaseCommand } from "./production-release";
import { nativeResourceFailureMessage, nativeResourceStage } from "./resource-failure";
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
  ).pipe(nativeResourceStage("planning"));
  if (phase === "stage-hosts") {
    yield* Effect.sync(() => requireHostPlan(snapshot.native)).pipe(
      nativeResourceStage("Access host plan")
    );
  } else {
    yield* Effect.sync(() =>
      requireNativeBindings({ plan: snapshot.native, revision, hosts })
    ).pipe(nativeResourceStage("Worker bindings"));
    yield* Effect.sync(() =>
      requireNativeResourcePlan({
        plan: describePlan(snapshot.native),
        revision,
        first: phase === "first-install",
      })
    ).pipe(nativeResourceStage("resource inventory"));
    if (
      phase === "first-install" &&
      Object.values(snapshot.native.resources).some(
        (node) =>
          node.action !== "create" || node.state !== undefined || node.deferredAdoption?.adopt
      )
    ) {
      return yield* Effect.fail(Error("Previous state exists")).pipe(
        nativeResourceStage("first-install ownership")
      );
    }
  }
  const preflightStages = {
    "first-install": "closed edge preparation",
    upload: "upload verification",
    "stage-hosts": "host capture",
  } as const;
  yield* releaseCommand({
    args: ["bun", "native-storage-release.ts", releaseChecks[phase]],
    lifetime: phase === "upload" ? "read-only" : "started-write",
  }).pipe(nativeResourceStage(preflightStages[phase]));
  return yield* Apply.apply(snapshot.native, { deletions: "defer" }).pipe(
    Effect.provide(snapshot.session.context),
    Effect.uninterruptible,
    Effect.asVoid,
    nativeResourceStage("provider apply")
  );
});
const publishSite = Effect.gen(function* () {
  yield* Config.Literal("true", "GITHUB_ACTIONS");
  yield* Config.Literal("refs/heads/trunk", "GITHUB_REF");
  yield* Config.Literal("workflow_dispatch", "GITHUB_EVENT_NAME");
  const profile = yield* Config.String("ALCHEMY_PROFILE");
  const planned = yield* Alchemist.Stack.plan({
    target: { entrypoint: "alchemy.site.ts", stage: "production", profile },
    operation: "deploy",
    include: ["Site"],
    updateStateStore: false,
  }).pipe(nativeResourceStage("planning"));
  const rows = describePlan(planned.native),
    site = Object.values(planned.native.resources).find(
      (node) => describeResource(node).logicalId === "Site"
    );
  if (
    planned.native.selectedFqns === undefined ||
    rows.actions.length !== 0 ||
    rows.resources.length !== 2 ||
    !rows.resources.every(
      (row) =>
        ((row.logicalId === "Site" && row.resourceType === "Cloudflare.Worker") ||
          (row.logicalId === "Build" && row.resourceType === "Command.Build")) &&
        ["noop", "update"].includes(row.action)
    ) ||
    site === undefined ||
    !(site.action === "noop" || site.action === "update")
  ) {
    return yield* Effect.fail(Error("Existing Site and Build must be the only changes")).pipe(
      nativeResourceStage("Site plan verification")
    );
  }
  const expected = Schema.Struct({
    workerName: Schema.Literal(productionTopology.site.workerName),
  });
  yield* Schema.decodeUnknownEffect(expected)(site.state.attr).pipe(
    nativeResourceStage("Site plan verification")
  );
  yield* Apply.apply(planned.native, { deletions: "defer" }).pipe(
    Effect.provide(planned.session.context),
    Effect.uninterruptible,
    nativeResourceStage("provider apply")
  );
});

if (import.meta.main) {
  const program = Effect.gen(function* () {
    if (process.argv[2] === "publish-site") return yield* publishSite;
    const phase = yield* Schema.decodeUnknownEffect(Phase)(process.argv[2]);
    yield* resourceRelease(phase);
  }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped);
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          process.stderr.write(nativeResourceFailureMessage(cause) + "\n");
          process.exitCode = 1;
        })
      )
    )
  );
}
