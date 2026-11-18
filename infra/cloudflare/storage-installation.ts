import { installedOrigins } from "@fidy/server/browser-transport";
import { type Plan, describeResource } from "alchemy/Plan";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, type Redacted, Schema } from "effect";
import { browserOrigins } from "../../apps/server/cloudflare/runtime/contract";
import type { ReleaseMetadata } from "./deployment-configuration";
import { namespaceClasses, storageReleaseBinding } from "./storage-release";
import { freeTierWorkerObservability } from "./worker-observability";

// The Production physical names are recorded independently of the two Alchemy logical IDs.
export const nativeStack = "FidyNativeStorage";
export const nativeIngressHost = new URL(installedOrigins.acceptance.api).hostname;
export const nativeWebHost = new URL(installedOrigins.acceptance.browser).hostname;
export const installationNames = {
  Core: "fidy-native-storage-core",
  Ingress: "fidy-native-storage-ingress",
} as const;

export const storageNamespaces = Effect.sync(() => ({
  USER_STORE: Cloudflare.DurableObject("UserStore", { className: "UserStore" }),
  DIRECTORY: Cloudflare.DurableObject("Directory", { className: "Directory" }),
  PRICING: Cloudflare.DurableObject("Pricing", { className: "Pricing" }),
  MAINTENANCE: Cloudflare.DurableObject("Maintenance", { className: "Maintenance" }),
  ERASURE: Cloudflare.DurableObject("Erasure", { className: "Erasure" }),
}));

/** Same stack, logical workers, native classes and network surface as ordinary release capture. */
export const closedInstallation = Effect.fn(function* (input: {
  development: boolean;
  release: ReleaseMetadata;
  storage: string;
  smokeProof: Redacted.Redacted<string>;
  ceiling: string;
}) {
  const environment = {
    RECOVERY_ISOLATION: "isolated",
    BROWSER_ORIGIN: browserOrigins.nativeAcceptance,
    RELEASE_GIT_SHA: input.release.gitRevision,
    CONTRACT_DIGEST: input.release.contractDigest,
    SMOKE_PROOF: input.smokeProof,
    [storageReleaseBinding]: input.storage,
    CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
  };
  const deployment = {
    compatibility: { date: "2026-09-08" },
    version: input.development
      ? undefined
      : { traffic: 0, tag: input.release.versionTag, message: "isolated" },
    observability: freeTierWorkerObservability,
    workersDev: false,
  };
  const core = yield* Cloudflare.Worker("Core", {
    ...deployment,
    name: installationNames.Core,
    main: "../../apps/server/cloudflare/core-worker.ts",
    dev: { host: "127.0.0.1", port: 18982, strictPort: true },
    env: {
      ...environment,
      SQLITE_STORE_CAPACITY_BYTES: input.ceiling,
      ...(yield* storageNamespaces),
    },
  });
  const ingress = yield* Cloudflare.Worker("Ingress", {
    ...deployment,
    name: installationNames.Ingress,
    main: "../../apps/server/cloudflare/public-worker.ts",
    domain: input.development ? undefined : nativeIngressHost,
    dev: { host: "127.0.0.1", port: 18981, strictPort: true },
    env: { ...environment, CORE: core },
  });
  return { apiUrl: ingress.url };
});

const Row = Schema.Struct({
  action: Schema.Literal("create"),
  resourceType: Schema.Literal("Cloudflare.Worker"),
  logicalId: Schema.Literals(["Core", "Ingress"]),
});
/** Refuse adoption, repair, replacement and orphaned resources before calling the provider. */
export const requireFreshPlan = (plan: {
  resources: ReadonlyArray<unknown>;
  actions: ReadonlyArray<unknown>;
}): void => {
  const resources = Schema.decodeUnknownSync(Schema.Array(Row))(plan.resources);
  if (
    plan.actions.length !== 0 ||
    resources.length !== 2 ||
    new Set(resources.map((row) => row.logicalId)).size !== 2
  ) {
    throw Error("Fresh install requires exactly two new Workers and no other planned operations");
  }
};

export const requireAbsentInstallation = (input: {
  scripts: ReadonlyArray<{ id: string }>;
  namespaces: ReadonlyArray<{ script: string }>;
  domains: ReadonlyArray<{ hostname: string }>;
}): void => {
  const targets: ReadonlySet<string> = new Set(Object.values(installationNames));
  if (
    input.scripts.some((script) => targets.has(script.id)) ||
    input.namespaces.some((namespace) => targets.has(namespace.script)) ||
    input.domains.some((domain) => domain.hostname === nativeIngressHost)
  ) {
    throw Error(
      "Existing Worker, namespace or ingress domain; use guarded rollout or incident inspection"
    );
  }
};

const networkSurface = {
  workersDev: Schema.Literal(false),
  version: Schema.Struct({ traffic: Schema.Literal(0), parent: Schema.optional(Schema.Never) }),
  routes: Schema.optional(Schema.Never),
  namespace: Schema.optional(Schema.Never),
  preview: Schema.optional(Schema.Never),
  crons: Schema.optional(Schema.Never),
  tailConsumers: Schema.optional(Schema.Never),
  streamingTailConsumers: Schema.optional(Schema.Never),
};
export const requireInstallationWorker = ({
  logicalId,
  props,
}: {
  logicalId: keyof typeof installationNames;
  props: unknown;
}): void => {
  Schema.decodeUnknownSync(
    Schema.Struct({
      ...networkSurface,
      name: Schema.Literal(installationNames[logicalId]),
      domain:
        logicalId === "Ingress" ? Schema.Literal(nativeIngressHost) : Schema.optional(Schema.Never),
    })
  )(props);
};

const ProviderBindings = Schema.Struct({
  crons: Schema.optional(Schema.Never),
  bindings: Schema.optional(
    Schema.Array(
      Schema.StructWithRest(Schema.Struct({ type: Schema.String, name: Schema.String }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ])
    )
  ),
});
type PlannedBinding = NonNullable<typeof ProviderBindings.Type.bindings>[number];
const installationBindings = {
  BROWSER_ORIGIN: "plain_text",
  RELEASE_GIT_SHA: "plain_text",
  CONTRACT_DIGEST: "plain_text",
  RECOVERY_ISOLATION: "plain_text",
  [storageReleaseBinding]: "plain_text",
  CF_VERSION_METADATA: "version_metadata",
  SMOKE_PROOF: "secret_text",
};
export const requireClosedBindings = ({
  worker,
  bindings,
}: {
  worker: keyof typeof installationNames;
  bindings: ReadonlyArray<PlannedBinding>;
}): void => {
  const allowed = new Map(Object.entries(installationBindings));
  if (worker === "Ingress") {
    allowed.set("CORE", "service");
  } else {
    allowed.set("SQLITE_STORE_CAPACITY_BYTES", "plain_text");
    for (const name of Object.keys(namespaceClasses)) allowed.set(name, "durable_object_namespace");
  }
  if (
    bindings.filter((binding) => binding.name === "RECOVERY_ISOLATION").length !== 1 ||
    !bindings.some(
      (binding) => binding.name === "RECOVERY_ISOLATION" && binding.text === "isolated"
    ) ||
    !bindings.every((binding) => allowed.get(binding.name) === binding.type)
  ) {
    throw Error("Native installation requires closed admission and isolated bindings");
  }
};
/** Use the same binding data the pinned provider reads when preparing its native class migration. */
export const requireNativeBindings = (plan: Plan): void => {
  const rows = Object.values(plan.resources);
  const core = rows.find((node) => describeResource(node).logicalId === "Core");
  const ingress = rows.find((node) => describeResource(node).logicalId === "Ingress");
  if (rows.length !== 2 || core === undefined || ingress === undefined) {
    throw Error("Unexpected native Worker plan");
  }
  const workerProps = (node: typeof core): unknown =>
    node.action === "noop" ? node.state.props : node.props;
  requireInstallationWorker({ logicalId: "Core", props: workerProps(core) });
  requireInstallationWorker({ logicalId: "Ingress", props: workerProps(ingress) });
  const bindings = (node: typeof core): ReadonlyArray<PlannedBinding> =>
    node.bindings.flatMap(
      (binding) => Schema.decodeUnknownSync(ProviderBindings)(binding.data).bindings ?? []
    );
  const material = bindings(core);
  requireClosedBindings({ worker: "Core", bindings: material });
  requireClosedBindings({ worker: "Ingress", bindings: bindings(ingress) });
  const classes = material.filter((binding) => binding.type === "durable_object_namespace");
  const exact = Object.entries(namespaceClasses).every(([name, expected]) =>
    classes.some(
      (binding) =>
        binding.name === name &&
        binding.className === expected &&
        binding.scriptName === undefined &&
        binding.transferredFrom === undefined
    )
  );
  if (!exact || classes.length !== Object.keys(namespaceClasses).length) {
    throw Error("Native namespace lifecycle differs");
  }
};
