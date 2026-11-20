import type * as Alchemist from "alchemy/Alchemist";
import { Schema } from "effect";
import { type Plan, describePlan, describeResource } from "alchemy/Plan";
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
    throw Error("Closed fixture lifecycle differs for " + row.logicalId);
  }
  if (retained.size !== 0 || candidates.size !== 0) {
    throw Error(
      "Closed fixture requires both Worker updates and its exact retained provider generation"
    );
  }
};

/** A same-stack Worker.ref reads the retained Alchemy generation. Only a deferred delete may hold it. */
export const verifyFixturePlan = ({ plan, fallback }: { plan: Plan; fallback: boolean }): void => {
  requireFixtureLifecycle({ rows: describePlan(plan).resources, fallback });
  const originalId = "ReleaseSmoke-" + retainedProvider.revision;
  const [worker] = Object.values(plan.deletions).filter(
    (row) => row !== undefined && describeResource(row).logicalId === originalId
  );
  if (worker?.action !== "delete") {
    throw Error("Missing deferred original provider");
  }
  Schema.decodeUnknownSync(
    Schema.Struct({
      status: Schema.Literals(["created", "updated"]),
      attr: Schema.Struct({
        workerName: Schema.Literal("fidy-native-smoke-" + retainedProvider.revision),
      }),
    })
  )(worker.state);
};
