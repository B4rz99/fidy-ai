import { isDeepStrictEqual } from "node:util";
import type * as Alchemist from "alchemy/Alchemist";
import * as Apply from "alchemy/Apply";
import { Data, Effect, Predicate, Schema } from "effect";
import { type Plan, describePlan, describeResource } from "alchemy/Plan";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { State } from "alchemy/State";
import { nativeResourceInventory } from "./native-graph";
import fixtureUpload from "./native-fixture-upload.json" with { type: "json" };
import retainedProvider from "./native-retained-provider.json" with { type: "json" };

export const nativePlanOptions = ({
  profile,
  preview,
  fingerprint,
}: {
  profile: string;
  preview: boolean;
  fingerprint: string;
}): Parameters<typeof Alchemist.Stack.plan>[0] => ({
  target: { entrypoint: "alchemy.storage.ts", stage: "production", profile },
  operation: "deploy" as const,
  updateStateStore: !preview && fingerprint === "",
});

const smokeResources = [
  "ReleaseSmoke-",
  "ReleaseSmokeQueue-",
  "ReleaseSmokeWorkflowV2-",
  "ReleaseSmokeConsumer-",
];

const original = new Set(smokeResources.map((prefix) => prefix + retainedProvider.revision));

type PlanRows = ReturnType<typeof describePlan>["resources"];

const knownResources = new Map([
  ...nativeResourceInventory(fixtureUpload.revision),
  ...nativeResourceInventory(retainedProvider.revision),
]);

type ObservedResource = Pick<PlanRows[number], "logicalId" | "resourceType" | "action">;

const projectInventory = (
  rows: PlanRows,
  inventory: ReadonlyMap<string, string>
): ReadonlyArray<ObservedResource> =>
  rows.map(({ logicalId, resourceType, action }) =>
    inventory.get(logicalId) === resourceType
      ? { logicalId, resourceType, action }
      : { logicalId: "unrecognized", resourceType: "unrecognized", action }
  );

export const projectFixtureInventory = (rows: PlanRows): ReadonlyArray<ObservedResource> =>
  projectInventory(rows, knownResources);

export const projectSuccessorInventory = ({
  rows,
  revision,
}: {
  rows: PlanRows;
  revision: string;
}): ReadonlyArray<ObservedResource> => projectInventory(rows, nativeResourceInventory(revision));

export class FixturePlanRefused extends Data.TaggedError("FixturePlanRefused")<{
  reason:
    | "unexpected change"
    | "missing required update or deferred deletion"
    | "missing deferred original Worker"
    | "original Worker state or name differs"
    | "successor differs from reviewed plan"
    | "successor plan is not a scoped upload"
    | "successor scope has a pending replacement";
}> {}

export const isFixturePlanRefused = (value: unknown): value is FixturePlanRefused =>
  Predicate.isTagged(value, "FixturePlanRefused");

export const requireSafeScopedNativePlan = Effect.fn("requireSafeScopedNativePlan")(function* (
  plan: Plan
) {
  const selected = plan.selectedFqns;

  if (
    selected === undefined ||
    selected.size === 0 ||
    plan.destroy === true ||
    [plan.deletions, plan.actions, plan.actionDeletions].some(
      (rows) => Object.keys(rows).length !== 0
    ) ||
    Object.entries(plan.resources).some(
      ([fqn, node]) =>
        !selected.has(fqn) ||
        node.action === "replace" ||
        node.state?.status === "replaced" ||
        (node.renamedFrom?.length ?? 0) !== 0
    )
  ) {
    return yield* new FixturePlanRefused({ reason: "successor plan is not a scoped upload" });
  }

  const state = yield* yield* State;
  const stack = (yield* Stack).name;
  const stage = yield* Stage;

  const saved = yield* Effect.forEach(selected, (fqn) => state.get({ stack, stage, fqn }), {
    concurrency: 8,
  });

  if (saved.some((row) => row?.status === "replacing" || row?.status === "replaced")) {
    return yield* new FixturePlanRefused({ reason: "successor scope has a pending replacement" });
  }
});

export const applyScopedNativePlan = Effect.fn("applyScopedNativePlan")(function* <Output>(
  plan: Plan<Output>
) {
  yield* requireSafeScopedNativePlan(plan);

  return yield* Apply.apply(plan);
});

export const requireFixtureLifecycle = ({
  rows,
  fallback,
}: {
  rows: ReturnType<typeof describePlan>["resources"];
  fallback: boolean;
}): void => {
  const retained = new Set(original);
  const candidates = new Set(["Core", "Ingress"]);

  if (fallback) candidates.add("ReleaseSmoke-" + fixtureUpload.revision);

  const changes = new Map<string, Set<string>>([
    ["delete", retained],
    ["update", candidates],
  ]);

  for (const row of rows) {
    if (row.action === "noop") continue;

    if (changes.get(row.action)?.delete(row.logicalId) === true) continue;
    throw new FixturePlanRefused({ reason: "unexpected change" });
  }

  if (retained.size !== 0 || candidates.size !== 0) {
    throw new FixturePlanRefused({ reason: "missing required update or deferred deletion" });
  }
};

export const verifyFixturePlan = ({ plan, fallback }: { plan: Plan; fallback: boolean }): void => {
  requireFixtureLifecycle({ rows: describePlan(plan).resources, fallback });
  const originalId = "ReleaseSmoke-" + retainedProvider.revision;

  const [worker] = Object.values(plan.deletions).filter(
    (row) => row !== undefined && describeResource(row).logicalId === originalId
  );

  if (worker?.action !== "delete") {
    throw new FixturePlanRefused({ reason: "missing deferred original Worker" });
  }

  const retainedWorker = Schema.is(
    Schema.Struct({
      status: Schema.Literals(["created", "updated"]),
      attr: Schema.Struct({
        workerName: Schema.Literal("fidy-native-smoke-" + retainedProvider.revision),
      }),
    })
  );

  if (!retainedWorker(worker.state)) {
    throw new FixturePlanRefused({ reason: "original Worker state or name differs" });
  }
};

export const SuccessorSource = Schema.Struct({
  revision: Schema.String,
  previousRevision: Schema.Literal("0ba692ff68c1d63da1f4a7fdb8d6df5ff1566287"),
  previousRelease: Schema.Literal("14645515552"),
  previousCleanup: Schema.Literal("14656121411"),
  signerSha256: Schema.String,
  stableCoreVersion: Schema.NonEmptyString,
  stableCoreDeployment: Schema.NonEmptyString,
  stableIngressVersion: Schema.NonEmptyString,
  stableIngressDeployment: Schema.NonEmptyString,
  oldSmokeVersionId: Schema.NonEmptyString,
  oldSmokeDeploymentId: Schema.NonEmptyString,
  retainedWebContractDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  namespaces: Schema.Array(Schema.String),
});

export const successorPlanSelection = (revision: string): ReadonlyArray<string> => [
  "Core",
  "Ingress",
  ...smokeResources.map((prefix) => prefix + revision),
];

const requireSuccessorResourceChanges = ({
  rows,
  revision,
  active,
}: {
  rows: PlanRows;
  revision: string;
  active: boolean;
}): void => {
  const inventory = nativeResourceInventory(revision);
  const smokeAction = active ? "noop" : "create";

  const expected = new Map(
    successorPlanSelection(revision).map(
      (id) => [id, id === "Core" || id === "Ingress" ? "update" : smokeAction] as const
    )
  );

  const observed = new Set<string>();

  for (const row of rows) {
    if (inventory.get(row.logicalId) !== row.resourceType || observed.has(row.logicalId)) {
      throw new FixturePlanRefused({ reason: "unexpected change" });
    }

    observed.add(row.logicalId);

    if (row.action !== (expected.get(row.logicalId) ?? "noop")) {
      throw new FixturePlanRefused({ reason: "unexpected change" });
    }

    expected.delete(row.logicalId);
  }

  if (expected.size !== 0) {
    throw new FixturePlanRefused({ reason: "missing required update or deferred deletion" });
  }
};

type ReviewedSuccessor = Readonly<{ resources: ReadonlyArray<{ logicalId: string }> }>;

export const requireSameSuccessorPlan = ({
  approved,
  observed,
}: {
  approved: ReviewedSuccessor;
  observed: ReviewedSuccessor;
}): void => {
  const order = <Plan extends ReviewedSuccessor>(plan: Plan): Plan => ({
    ...plan,
    resources: plan.resources.toSorted((left, right) =>
      left.logicalId.localeCompare(right.logicalId)
    ),
  });

  if (!isDeepStrictEqual(order(approved), order(observed))) {
    throw new FixturePlanRefused({ reason: "successor differs from reviewed plan" });
  }
};

type SuccessorInventory = { rows: PlanRows; revision: string };

export const requireSuccessorLifecycle = (input: SuccessorInventory): void =>
  requireSuccessorResourceChanges({ ...input, active: false });

export const requireActiveSuccessorLifecycle = (input: SuccessorInventory): void =>
  requireSuccessorResourceChanges({ ...input, active: true });

export const requireSmokeConsumerReconciliation = ({
  rows,
  revision,
}: SuccessorInventory): "create" | "noop" => {
  const inventory = nativeResourceInventory(revision);
  const target = "ReleaseSmokeConsumer-" + revision;
  const observed = new Set(rows.map((row) => row.logicalId));

  if (
    observed.size !== rows.length ||
    rows.some((row) => inventory.get(row.logicalId) !== row.resourceType)
  ) {
    throw new FixturePlanRefused({ reason: "unexpected change" });
  }

  if (
    ![target, "ReleaseSmoke-" + revision, "ReleaseSmokeQueue-" + revision].every((resource) =>
      observed.has(resource)
    )
  ) {
    throw new FixturePlanRefused({ reason: "missing required update or deferred deletion" });
  }

  const changes = rows.filter((row) => row.action !== "noop");

  if (changes.length === 0) return "noop";

  if (
    changes.length === 1 &&
    changes.every((row) => row.logicalId === target && row.action === "create")
  ) {
    return "create";
  }

  throw new FixturePlanRefused({ reason: "unexpected change" });
};
