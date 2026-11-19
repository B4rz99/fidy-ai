import { productionTopology } from "../../apps/server/cloudflare/runtime/contract";
import { requireHostPlan, stagedAccessApplications } from "./native-host-plan";
import * as Alchemist from "alchemy/Alchemist";
import * as Apply from "alchemy/Apply";
import { diagnoseFreshTarget, diagnoseNativePlan } from "./native-plan-diagnostics";
import { firstInstallEdge } from "./native-storage-release";
import { requireNativeResourcePlan } from "./native-graph";
import { type Plan, describePlan, describeResource } from "alchemy/Plan";
import { Config, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { releaseCommand, releaseEvidence } from "./production-release";
import { readRecoveryPin } from "./native-recovery-identity";
import { ReleaseHttpLive } from "./release-http";
import { nativeResourceFailureMessage, nativeResourceStage } from "./resource-failure";
import { type NativeHostMode, requireNativeBindings } from "./storage-installation";

const Phase = Schema.Literals(["first-install", "upload", "stage-hosts"]);
const Operation = Schema.Union([Phase, Schema.Literal("plan-first-install")]);
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
  upload: "verify-upload",
  "stage-hosts": "capture-hosts",
} as const;
const protectedRecoveryPin = Effect.gen(function* () {
  const { account, token } = releaseEvidence.config();
  const client = yield* HttpClient.HttpClient;
  return yield* readRecoveryPin(
    (path) =>
      releaseEvidence
        .providerJson(
          HttpClientRequest.get("https://api.cloudflare.com/client/v4/" + path, {
            headers: { authorization: "Bearer " + token },
          })
        )
        .pipe(Effect.provideService(HttpClient.HttpClient, client)),
    "accounts/" + account + "/"
  );
}).pipe(Effect.provide(ReleaseHttpLive));
const verifyResourcePlan = Effect.fn(function* ({
  phase,
  plan,
  revision,
  hosts,
  pin,
}: {
  phase: typeof Phase.Type;
  plan: Plan;
  revision: string;
  hosts: NativeHostMode;
  pin: string;
}) {
  yield* Effect.gen(function* () {
    const allowed = Schema.Struct({ allowedIdps: Schema.Tuple([Schema.Literal(pin)]) });
    for (const node of Object.values(plan.resources)) {
      if (describeResource(node).resourceType === "Cloudflare.Access.Application") {
        yield* Schema.decodeUnknownEffect(allowed)(
          node.action === "noop" ? node.state.props : node.props
        );
      }
    }
  }).pipe(nativeResourceStage("account recovery PIN"));

  if (phase === "stage-hosts") {
    yield* Effect.sync(() => requireHostPlan(plan)).pipe(nativeResourceStage("Access host plan"));
  } else {
    yield* Effect.sync(() => requireNativeBindings({ plan, revision, hosts })).pipe(
      nativeResourceStage("Worker bindings")
    );
    yield* Effect.sync(() =>
      requireNativeResourcePlan({
        plan: describePlan(plan),
        revision,
        first: phase === "first-install",
      })
    ).pipe(nativeResourceStage("resource inventory"));
    if (
      phase === "first-install" &&
      Object.values(plan.resources).some(
        (node) =>
          node.action !== "create" || node.state !== undefined || node.deferredAdoption?.adopt
      )
    ) {
      return yield* Effect.fail(Error("Previous state exists")).pipe(
        nativeResourceStage("first-install ownership")
      );
    }
  }
});
const resourceRelease = Effect.fn(function* (phase: typeof Phase.Type, preview: boolean) {
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
  const pin = yield* protectedRecoveryPin.pipe(nativeResourceStage("account recovery PIN"));
  const input = {
    target: { entrypoint: "alchemy.storage.ts", stage: "production", profile },
    operation: "deploy",
    updateStateStore: !preview,
  } as const;
  const snapshot = yield* (
    phase === "stage-hosts"
      ? Alchemist.Stack.plan({ ...input, include: stagedAccessApplications })
      : Alchemist.Stack.plan(input)
  ).pipe(diagnoseNativePlan(revision));
  yield* verifyResourcePlan({ phase, plan: snapshot.native, revision, hosts, pin });
  if (phase === "first-install") {
    yield* firstInstallEdge(preview ? "plan" : "install").pipe(
      Effect.provide(ReleaseHttpLive),
      diagnoseFreshTarget
    );
    if (preview)
      return yield* Effect.logInfo("Verified the fresh native first-install plan and closed edge.");
  } else {
    yield* releaseCommand({
      args: ["bun", "native-storage-release.ts", releaseChecks[phase]],
      lifetime: phase === "upload" ? "read-only" : "started-write",
    }).pipe(nativeResourceStage(phase === "upload" ? "upload verification" : "host capture"));
  }
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
    const operation = yield* Schema.decodeUnknownEffect(Operation)(process.argv[2]);
    if (operation === "plan-first-install") return yield* resourceRelease("first-install", true);
    return yield* resourceRelease(operation, false);
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
