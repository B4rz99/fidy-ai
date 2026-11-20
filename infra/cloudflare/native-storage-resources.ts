import {
  SuccessorSource,
  applySuccessorPlan,
  nativePlanOptions,
  projectFixtureInventory,
  requireActiveSuccessorLifecycle,
  requireSameSuccessorPlan,
  requireSuccessorLifecycle,
  successorPlanSelection,
  verifyFixturePlan,
} from "./native-fixture-plan";
import {
  expectedFixtureSigner,
  fixtureArtifacts,
  fixtureBuild,
  resourceRevision,
} from "./native-fixture-signer";
import { productionTopology } from "../../apps/server/cloudflare/runtime/contract";
import { requireHostPlan, stagedAccessApplications } from "./native-host-plan";
import * as Alchemist from "alchemy/Alchemist";
import * as Apply from "alchemy/Apply";
import {
  diagnoseFreshTarget,
  diagnoseNativePlan,
  diagnoseSuccessorApply,
} from "./native-plan-diagnostics";
import { firstInstallEdge } from "./native-storage-release";
import { requireNativeResourcePlan } from "./native-graph";
import { type Plan, describePlan, describeResource } from "alchemy/Plan";
import { Config, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { releaseCommand, releaseEvidence } from "./production-release";
import { readRecoveryPin } from "./native-recovery-identity";
import { ReleaseHttpLive } from "./release-http";
import {
  nativePlanningFailure,
  nativeResourceFailureMessage,
  nativeResourceStage,
} from "./resource-failure";
import {
  type NativeHostMode,
  requireNativeBindings,
  requireSuccessorPlanBindings,
} from "./storage-installation";

const Phase = Schema.Literals(["first-install", "upload", "stage-hosts"]);
const Operation = Schema.Union([
  Phase,
  Schema.Literals(["plan-first-install", "plan-fixture-fallback"]),
]);
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
    const fingerprint = yield* expectedFixtureSigner;
    const fallback = (yield* fixtureBuild) === "fallback";
    if (fingerprint !== "") {
      yield* Effect.try(() => verifyFixturePlan({ plan, fallback })).pipe(
        nativeResourceStage("resource inventory")
      );
    }
    const generation = resourceRevision({ revision, signed: fingerprint !== "" });
    yield* Effect.sync(() =>
      requireNativeBindings({ plan, revision: generation, hosts, fingerprint, fallback })
    ).pipe(nativeResourceStage("Worker bindings"));
    yield* Effect.sync(() =>
      requireNativeResourcePlan({
        plan: describePlan(plan),
        revision: generation,
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
const preflight = Effect.fn(function* (phase: typeof Phase.Type, preview: boolean) {
  if (phase === "first-install") {
    return yield* firstInstallEdge(preview ? "plan" : "install").pipe(
      Effect.provide(ReleaseHttpLive),
      diagnoseFreshTarget
    );
  }
  yield* releaseCommand({
    args: ["bun", "native-storage-release.ts", releaseChecks[phase]],
    lifetime: phase === "upload" ? "read-only" : "started-write",
  }).pipe(nativeResourceStage(phase === "upload" ? "upload verification" : "host capture"));
});
const recordFixturePreview = Effect.fn(function* (input: {
  revision: string;
  plan: Plan;
  result: { qualified: true } | { qualified: false; refusal: string };
}) {
  const plan = describePlan(input.plan);
  const resources = projectFixtureInventory(plan.resources);
  yield* releaseEvidence.writeFile(
    (yield* Config.String("RUNNER_TEMP")) + "/native-fixture-plan.json",
    releaseEvidence.encodeJson({
      revision: input.revision,
      applied: false,
      ...input.result,
      actionCount: plan.actions.length,
      resources,
    })
  );
});
const verifyPreparedPlan = Effect.fn(function* (
  input: Parameters<typeof verifyResourcePlan>[0] & { preview: boolean }
) {
  const { phase, plan, preview, revision } = input;
  const verification = verifyResourcePlan(input).pipe(Effect.andThen(preflight(phase, preview)));
  if (phase === "upload" && (yield* expectedFixtureSigner) !== "") {
    const changes = projectFixtureInventory(describePlan(plan).resources).filter(
      (row) => row.action !== "noop"
    );
    yield* Effect.logInfo("Closed fixture plan changes " + releaseEvidence.encodeJson(changes));
    if (preview) {
      yield* verification.pipe(
        Effect.tapCause((cause) =>
          recordFixturePreview({
            revision,
            plan,
            result: { qualified: false, refusal: nativeResourceFailureMessage(cause) },
          })
        )
      );
      yield* recordFixturePreview({ revision, plan, result: { qualified: true } });
      return yield* Effect.logInfo(
        "Verified the closed fallback lifecycle and retained provider plan without applying it."
      );
    }
  }
  yield* verification;
  if (preview) {
    yield* Effect.logInfo("Verified the fresh native first-install plan and closed edge.");
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
  const input = nativePlanOptions({ profile, preview, fingerprint: yield* expectedFixtureSigner });
  const snapshot = yield* (
    phase === "stage-hosts"
      ? Alchemist.Stack.plan({ ...input, include: stagedAccessApplications })
      : Alchemist.Stack.plan(input)
  ).pipe(diagnoseNativePlan(revision));
  yield* verifyPreparedPlan({ phase, preview, plan: snapshot.native, revision, hosts, pin });
  if (preview) return;
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

const ReviewedSuccessorPlan = Schema.Struct({
  ...SuccessorSource.fields,
  member: Schema.Literal("performance-2"),
  applied: Schema.Literal(false),
  resources: Schema.Array(
    Schema.Struct({
      logicalId: Schema.NonEmptyString,
      resourceType: Schema.NonEmptyString,
      action: Schema.Literals(["noop", "update", "create"]),
    })
  ),
});
type SuccessorAction = "plan" | "stage" | "rollout";
const requireSuccessorSource = Effect.fn(function* (action: SuccessorAction) {
  yield* Config.Literal("true", "GITHUB_ACTIONS");
  yield* Config.Literal("true", "GITHUB_REF_PROTECTED");
  yield* Config.Literal("refs/heads/trunk", "GITHUB_REF");
  yield* Config.Literal("workflow_dispatch", "GITHUB_EVENT_NAME");
  yield* Config.Literal("1", "GITHUB_RUN_ATTEMPT");
  yield* Config.Literal(action + "-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  yield* Config.Literal("closed", "NATIVE_STORAGE_ADMISSION");
  yield* Config.Literal("acceptance", "NATIVE_STORAGE_HOSTS");
  yield* Config.Literal(
    "B4rz99/fidy-ai/.github/workflows/native-fixture-successor-plan.yml@refs/heads/trunk",
    "GITHUB_WORKFLOW_REF"
  );
  const revision = yield* Config.String("RELEASE_GIT_SHA");
  const artifacts = yield* fixtureArtifacts(revision);
  const fingerprint = yield* expectedFixtureSigner;
  const directory = yield* Config.String("RUNNER_TEMP");
  const raw = yield* releaseEvidence.readFile(directory + "/fixture-successor-source.json");
  const source = yield* Schema.decodeUnknownEffect(SuccessorSource)(raw);
  if (
    !/^[a-f0-9]{40}$/u.test(revision) ||
    !/^[a-f0-9]{64}$/u.test(fingerprint) ||
    source.signerSha256 !== fingerprint ||
    source.revision !== artifacts.resourceRevision ||
    source.previousRevision === revision
  ) {
    return yield* Effect.fail(Error("Unqualified closed successor plan source"));
  }
  return { revision, artifacts, fingerprint, directory, source };
});
export const readNativeScopedPlan = Effect.fn("readNativeScopedPlan")(function* ({
  profile,
  fingerprint,
  revision,
  include,
}: {
  profile: string;
  fingerprint: string;
  revision: string;
  include: readonly string[];
}) {
  return yield* Alchemist.Stack.plan({
    ...nativePlanOptions({ profile, preview: true, fingerprint }),
    include,
  }).pipe(
    diagnoseNativePlan(revision),
    Effect.catchCause((cause) => Effect.fail(nativePlanningFailure(cause)))
  );
});

const planFixtureSuccessor = Effect.fn(function* (action: SuccessorAction) {
  const { revision, artifacts, fingerprint, directory, source } =
    yield* requireSuccessorSource(action);
  const generation = artifacts.resourceRevision;
  const active = action === "rollout";
  const profile = yield* Config.String("ALCHEMY_PROFILE");
  const snapshot = yield* readNativeScopedPlan({
    profile,
    fingerprint,
    revision,
    include: successorPlanSelection(generation),
  });
  const observed = describePlan(snapshot.native);
  if (snapshot.native.selectedFqns === undefined || observed.actions.length !== 0) {
    return yield* Effect.fail(Error("Successor inventory requires a scoped read-only plan"));
  }
  yield* Effect.try(() => {
    const verify = active ? requireActiveSuccessorLifecycle : requireSuccessorLifecycle;
    verify({ rows: observed.resources, revision: generation });
    requireSuccessorPlanBindings({
      plan: snapshot.native,
      revision: generation,
      fingerprint,
      fallback: !active,
      accountingRevision: artifacts.accountingRollout ? Option.some(revision) : Option.none(),
    });
  });
  const resources = observed.resources.map(({ logicalId, resourceType, action }) => ({
    logicalId,
    resourceType,
    action,
  }));
  const observedPlan = { ...source, member: "performance-2", applied: false, resources };
  if (action === "plan") {
    return yield* releaseEvidence.writeFile(
      directory + "/native-fixture-successor-plan.json",
      releaseEvidence.encodeJson(observedPlan)
    );
  }
  if (active) {
    yield* releaseCommand({
      args: [
        "bun",
        new URL("./native-storage-release.ts", import.meta.url).pathname,
        "verify-successor-upload",
      ],
      lifetime: "read-only",
    });
  } else {
    const approved = yield* Schema.decodeUnknownEffect(ReviewedSuccessorPlan, {
      onExcessProperty: "error",
    })(yield* releaseEvidence.readFile(directory + "/fixture-successor-approved.json"));
    yield* Effect.try(() => requireSameSuccessorPlan({ approved, observed: observedPlan }));
  }
  yield* applySuccessorPlan(snapshot.native).pipe(
    diagnoseSuccessorApply(revision),
    Effect.provide(snapshot.session.context),
    Effect.uninterruptible
  );
});

if (import.meta.main) {
  const program = Effect.gen(function* () {
    if (process.argv[2] === "plan-fixture-successor") return yield* planFixtureSuccessor("plan");
    if (process.argv[2] === "stage-fixture-successor") return yield* planFixtureSuccessor("stage");
    if (process.argv[2] === "rollout-fixture-successor") {
      return yield* planFixtureSuccessor("rollout");
    }
    if (process.argv[2] === "publish-site") return yield* publishSite;
    const operation = yield* Schema.decodeUnknownEffect(Operation)(process.argv[2]);
    if (operation === "plan-fixture-fallback") return yield* resourceRelease("upload", true);
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
