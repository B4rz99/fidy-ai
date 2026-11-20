import type * as Alchemist from "alchemy/Alchemist";
import { Schema } from "effect";
import { type Plan, describePlan, describeResource } from "alchemy/Plan";
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

type FixtureLifecycle = Readonly<{ revision: string; fallback: boolean }>;
export const requireFixtureLifecycle = ({
  rows,
  revision,
  fallback,
}: FixtureLifecycle & { rows: ReturnType<typeof describePlan>["resources"] }): void => {
  const creates = new Set(fallback ? smokeResources.map((prefix) => prefix + revision) : []);
  const retained = new Set(original);
  const updates = new Set(
    fallback ? ["Core", "Ingress", "ForwardedEmail", "Web", "Build"] : ["Core", "Ingress"]
  );
  const allowed = new Map<string, Set<string>>([
    ["create", creates],
    ["delete", retained],
    ["update", updates],
  ]);
  for (const row of rows) {
    if (row.action === "noop") continue;
    if (allowed.get(row.action)?.delete(row.logicalId) !== true) {
      throw Error("Closed fixture lifecycle differs for " + row.logicalId);
    }
  }
  if ([creates, retained].some((set) => set.size !== 0)) {
    throw Error("Closed fixture requires its exact new and retained smoke generations");
  }
};

/** A same-stack Worker.ref reads the retained Alchemy generation. Only a deferred delete may hold it. */
export const verifyFixturePlan = ({
  plan,
  revision,
  fallback,
}: FixtureLifecycle & { plan: Plan }): void => {
  requireFixtureLifecycle({ rows: describePlan(plan).resources, revision, fallback });
  const originalId = "ReleaseSmoke-" + retainedProvider.revision;
  const [worker] = Object.values(plan.deletions).filter(
    (row) => row !== undefined && describeResource(row).logicalId === originalId
  );
  if (worker === undefined || worker.action !== "delete") {
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
