import { BunRuntime } from "@effect/platform-bun";
import {
  SuccessorSource,
  applyScopedNativePlan,
  nativePlanOptions,
  projectFixtureInventory,
  projectSuccessorInventory,
  requireActiveSuccessorLifecycle,
  requireSameSuccessorPlan,
  requireSmokeConsumerReconciliation,
  requireSuccessorLifecycle,
  successorPlanSelection,
  verifyFixturePlan,
} from "./native-fixture-plan";
import {
  accountingFixture,
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
import { confirmInterruptedSmokeConsumer } from "./native-smoke-consumer-recovery";
import { nativeResourceInventory, requireNativeResourcePlan } from "./native-graph";
import { type Plan, describePlan, describeResource } from "alchemy/Plan";
import { Config, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { fileURLToPath } from "node:url";
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
  Schema.Literals(["plan-first-install", "plan-fixture-fallback", "upload-canonical-signup"]),
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

const readProtectedRecoveryPin = (
  client: HttpClient.HttpClient
): ReturnType<typeof readRecoveryPin> => {
  const { account, token } = releaseEvidence.config();

  return readRecoveryPin(
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
};

const protectedRecoveryPin = Effect.gen(function* () {
  return yield* readProtectedRecoveryPin(yield* HttpClient.HttpClient);
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
  const allowed = Schema.Struct({ allowedIdps: Schema.Tuple([Schema.Literal(pin)]) });

  yield* Effect.forEach(
    Object.values(plan.resources),
    (node) =>
      describeResource(node).resourceType === "Cloudflare.Access.Application"
        ? Schema.decodeUnknownEffect(allowed)(
            node.action === "noop" ? node.state.props : node.props
          )
        : Effect.void,
    { discard: true }
  ).pipe(nativeResourceStage("account recovery PIN"));

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
    lifetime: phase === "stage-hosts" && !preview ? "started-write" : "read-only",
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

  if (phase === "first-install" && preview) {
    yield* Effect.logInfo("Verified the fresh native first-install plan and closed edge.");
  }
});

const requiredHosts: Partial<Record<typeof Phase.Type, NativeHostMode>> = {
  "first-install": "acceptance",
  "stage-hosts": "staged",
};

const resourceRelease = Effect.fn(function* (phase: typeof Phase.Type, preview: boolean) {
  yield* requireProtectedDispatch;
  const revision = yield* Config.String("RELEASE_GIT_SHA");
  const profile = yield* Config.String("ALCHEMY_PROFILE");

  const hosts = yield* Config.Literals(["acceptance", "staged"], "NATIVE_STORAGE_HOSTS").pipe(
    Config.withDefault("acceptance")
  );

  const required = requiredHosts[phase];

  if (required !== undefined && hosts !== required) {
    return yield* Effect.fail(Error("Unexpected native host selection"));
  }

  const pin = yield* protectedRecoveryPin.pipe(nativeResourceStage("account recovery PIN"));

  const input = nativePlanOptions({
    profile,
    preview: preview || phase === "stage-hosts",
    fingerprint: yield* expectedFixtureSigner,
  });

  const snapshot = yield* (
    phase === "stage-hosts"
      ? Alchemist.Stack.plan({ ...input, include: stagedAccessApplications })
      : Alchemist.Stack.plan(input)
  ).pipe(diagnoseNativePlan(revision));

  yield* verifyPreparedPlan({ phase, preview, plan: snapshot.native, revision, hosts, pin });

  if (preview) return;

  const apply =
    phase === "stage-hosts"
      ? applyScopedNativePlan(snapshot.native)
      : Apply.apply(snapshot.native, { deletions: "defer" });

  return yield* apply.pipe(
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

type ScopedPlan = {
  profile: string;
  fingerprint: string;
  revision: string;
  include: readonly string[];
};

const readScopedPlan = Effect.fn("readNativeScopedPlan")(function* ({
  profile,
  fingerprint,
  revision,
  include,
  entrypoint,
}: ScopedPlan & { entrypoint: string }) {
  const options = nativePlanOptions({ profile, preview: true, fingerprint });

  return yield* Alchemist.Stack.plan({
    ...options,
    target: { ...options.target, entrypoint },
    include,
  }).pipe(
    diagnoseNativePlan(revision),
    Effect.catchCause((cause) => Effect.fail(nativePlanningFailure(cause)))
  );
});

export const readNativeScopedPlan = Effect.fn(function* (input: ScopedPlan) {
  return yield* readScopedPlan({ ...input, entrypoint: "alchemy.storage.ts" });
});

const successorEntrypoint = Effect.fn(function* (accounting: boolean) {
  if (!accounting) return "alchemy.storage.ts";

  const historicalDirectory = fileURLToPath(
    new URL("../../interrupted/infra/cloudflare", import.meta.url)
  );

  if (process.cwd() !== historicalDirectory) {
    return yield* Effect.fail(
      Error("Accounting planning requires the historical Smoke build directory")
    );
  }

  return fileURLToPath(new URL("./alchemy.storage.ts", import.meta.url));
});

const prepareSuccessorPlan = Effect.fn(function* (action: SuccessorAction) {
  const { revision, artifacts, fingerprint, directory, source } =
    yield* requireSuccessorSource(action);

  const generation = artifacts.resourceRevision;

  const snapshot = yield* readScopedPlan({
    profile: yield* Config.String("ALCHEMY_PROFILE"),
    fingerprint,
    revision,
    include: successorPlanSelection(generation),
    entrypoint: yield* successorEntrypoint(artifacts.accountingRollout),
  });

  return { revision, artifacts, fingerprint, directory, source, generation, snapshot };
});

const reconcileAccountingSmokeConsumer = Effect.gen(function* () {
  yield* Config.Literal("true", "FIXTURE_ACCOUNTING_ROLLOUT");
  yield* Config.Literal("false", "FIXTURE_ACCOUNTING_INSPECTION");
  const { revision, artifacts, fingerprint } = yield* requireSuccessorSource("rollout");
  const generation = artifacts.resourceRevision;

  if (!artifacts.accountingRollout || generation !== accountingFixture.revision) {
    return yield* Effect.fail(Error("Requires the exact interrupted Smoke generation"));
  }

  yield* confirmInterruptedSmokeConsumer;

  const snapshot = yield* readScopedPlan({
    profile: yield* Config.String("ALCHEMY_PROFILE"),
    fingerprint,
    revision,
    include: ["ReleaseSmokeConsumer-" + generation],
    entrypoint: yield* successorEntrypoint(true),
  });

  const observed = describePlan(snapshot.native);

  if (snapshot.native.selectedFqns === undefined || observed.actions.length !== 0) {
    return yield* Effect.fail(Error("Smoke consumer recovery requires a scoped plan"));
  }

  const action = yield* Effect.try(() =>
    requireSmokeConsumerReconciliation({ rows: observed.resources, revision: generation })
  );

  if (action === "noop") return;
  yield* confirmInterruptedSmokeConsumer;
  yield* applyScopedNativePlan(snapshot.native).pipe(
    diagnoseSuccessorApply(revision),
    Effect.provide(snapshot.session.context),
    Effect.uninterruptible
  );
  yield* confirmInterruptedSmokeConsumer;
});

const inspectAccountingSuccessor = Effect.gen(function* () {
  yield* Config.Literal("true", "FIXTURE_ACCOUNTING_INSPECTION");
  yield* Config.Literal("true", "FIXTURE_ACCOUNTING_ROLLOUT");
  const { revision, generation, directory, snapshot } = yield* prepareSuccessorPlan("rollout");
  const observed = describePlan(snapshot.native);

  return yield* releaseEvidence.writeFile(
    directory + "/native-fixture-accounting-inspection.json",
    releaseEvidence.encodeJson({
      revision,
      resourceRevision: generation,
      applied: false,
      scoped: snapshot.native.selectedFqns !== undefined,
      stackActions: observed.actions.length,
      resources: projectSuccessorInventory({ rows: observed.resources, revision: generation }),
    })
  );
});

const planFixtureSuccessor = Effect.fn(function* (action: SuccessorAction) {
  const { revision, artifacts, fingerprint, directory, source, generation, snapshot } =
    yield* prepareSuccessorPlan(action);

  const active = action === "rollout";
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

  yield* applyScopedNativePlan(snapshot.native).pipe(
    diagnoseSuccessorApply(revision),
    Effect.provide(snapshot.session.context),
    Effect.uninterruptible
  );
});

const requireCanonicalOpeningPlan = (rows: ReturnType<typeof describePlan>["resources"]): void => {
  const changes = new Set(["Core", "Ingress"]);

  for (const row of rows) {
    if (row.action === "noop") continue;

    if (
      row.resourceType !== "Cloudflare.Worker" ||
      row.action !== "update" ||
      !changes.delete(row.logicalId)
    ) {
      throw Error("Canonical signup plan changes an unapproved resource or retained dependency");
    }
  }

  if (changes.size !== 0) throw Error("Canonical signup requires both existing Worker versions");
};

const uploadCanonicalSignup = Effect.fn(function* () {
  yield* Config.Literal("open-canonical-signup", "FIXTURE_RELEASE_OPERATION");
  yield* Config.Literal("open", "NATIVE_STORAGE_ADMISSION");
  yield* Config.Literal("staged", "NATIVE_STORAGE_HOSTS");
  yield* Config.Literal("true", "GITHUB_REF_PROTECTED");
  yield* Config.Literal("1", "GITHUB_RUN_ATTEMPT");
  const revision = yield* Config.String("RELEASE_GIT_SHA");
  const captured = yield* Config.String("RELEASE_SNAPSHOT_FILE");
  yield* releaseEvidence.readFile(captured);
  const profile = yield* Config.String("ALCHEMY_PROFILE");

  const snapshot = yield* Alchemist.Stack.plan({
    ...nativePlanOptions({ profile, preview: true, fingerprint: "" }),
    include: ["Core", "Ingress"],
  }).pipe(diagnoseNativePlan(revision));

  const rows = describePlan(snapshot.native).resources;
  yield* Effect.try(() => requireCanonicalOpeningPlan(rows)).pipe(
    nativeResourceStage({
      stage: "planning",
      details: () => {
        const inventory = nativeResourceInventory(accountingFixture.revision);

        const changes = rows
          .filter((row) => row.action !== "noop")
          .map((row) => {
            const label =
              inventory.get(row.logicalId) === row.resourceType ? row.logicalId : "unrecognized";

            return label + " " + row.action;
          });

        return " Canonical opening changes [" + changes.join(", ") + "].";
      },
    })
  );
  yield* applyScopedNativePlan(snapshot.native).pipe(
    Effect.provide(snapshot.session.context),
    Effect.uninterruptible,
    nativeResourceStage("provider apply")
  );
});

const dispatchResourceRelease = Effect.fn(function* (operation: typeof Operation.Type) {
  if (operation === "plan-fixture-fallback") return yield* resourceRelease("upload", true);

  if (operation === "upload-canonical-signup") return yield* uploadCanonicalSignup();

  if (operation === "plan-first-install") return yield* resourceRelease("first-install", true);

  return yield* resourceRelease(operation, false);
});

if (import.meta.main) {
  const ordinary = Effect.gen(function* () {
    if (process.argv[2] === "plan-fixture-successor") return yield* planFixtureSuccessor("plan");

    if (process.argv[2] === "stage-fixture-successor") return yield* planFixtureSuccessor("stage");

    if (process.argv[2] === "rollout-fixture-successor") {
      return yield* planFixtureSuccessor("rollout");
    }

    if (process.argv[2] === "inspect-accounting-successor") {
      return yield* inspectAccountingSuccessor;
    }

    if (process.argv[2] === "publish-site") return yield* publishSite;
    const operation = yield* Schema.decodeUnknownEffect(Operation)(process.argv[2]);

    return yield* dispatchResourceRelease(operation);
  });

  const program = (
    process.argv[2] === "reconcile-accounting-consumer"
      ? reconcileAccountingSmokeConsumer.pipe(Effect.provide(ReleaseHttpLive))
      : ordinary
  ).pipe(Effect.provide(Alchemist.layer()), Effect.scoped);

  BunRuntime.runMain(
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
