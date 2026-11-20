import type * as Alchemist from "alchemy/Alchemist";
import { Data, Schema } from "effect";
import { type Plan, describePlan, describeResource } from "alchemy/Plan";
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
export const projectFixtureInventory = (rows: PlanRows): ReadonlyArray<ObservedResource> =>
  rows.map(({ logicalId, resourceType, action }) =>
    knownResources.has(logicalId) && knownResources.get(logicalId) === resourceType
      ? { logicalId, resourceType, action }
      : { logicalId: "unrecognized", resourceType: "unrecognized", action }
  );

export class FixturePlanRefused extends Data.TaggedError("FixturePlanRefused")<{
  reason:
    | "unexpected change"
    | "missing required update or deferred deletion"
    | "missing deferred original Worker"
    | "original Worker state or name differs";
}> {}
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

export const successorPlanSelection = (revision: string): ReadonlyArray<string> => [
  "Core",
  "Ingress",
  ...smokeResources.map((prefix) => prefix + revision),
];

export const requireSuccessorLifecycle = ({
  rows,
  revision,
}: {
  rows: PlanRows;
  revision: string;
}): void => {
  const inventory = nativeResourceInventory(revision);
  const expected = new Map(
    successorPlanSelection(revision).map(
      (id) => [id, id === "Core" || id === "Ingress" ? "update" : "create"] as const
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
