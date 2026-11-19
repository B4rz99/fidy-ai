import {
  type NativeBinding,
  NativeBindings,
  type NativeRole,
  requireRoleBindings,
} from "./native-graph";
import { installedOrigins } from "@fidy/server/browser-transport";
import { type Plan, describeResource } from "alchemy/Plan";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";
import { namespaceClasses } from "./storage-release";

// The Production physical names are recorded independently of the two Alchemy logical IDs.
export const nativeStack = "FidyNativeStorage";
export const nativeIngressHost = new URL(installedOrigins.acceptance.api).hostname;
export const nativeWebHost = new URL(installedOrigins.acceptance.browser).hostname;
export const installationNames = {
  Core: "fidy-native-storage-core",
  Ingress: "fidy-native-storage-ingress",
  ForwardedEmail: "fidy-native-email",
  Web: "fidy-native-web",
} as const;

export const storageNamespaces = Effect.sync(() => ({
  USER_STORE: Cloudflare.DurableObject("UserStore", { className: "UserStore" }),
  DIRECTORY: Cloudflare.DurableObject("Directory", { className: "Directory" }),
  PRICING: Cloudflare.DurableObject("Pricing", { className: "Pricing" }),
  MAINTENANCE: Cloudflare.DurableObject("Maintenance", { className: "Maintenance" }),
  ERASURE: Cloudflare.DurableObject("Erasure", { className: "Erasure" }),
}));

export const requireAbsentInstallation = (input: {
  scripts: ReadonlyArray<{ id: string }>;
  namespaces: ReadonlyArray<{ script: string }>;
  domains: ReadonlyArray<{ hostname: string }>;
}): void => {
  const targets: ReadonlySet<string> = new Set(Object.values(installationNames));
  if (
    input.scripts.some((script) => targets.has(script.id)) ||
    input.namespaces.some((namespace) => targets.has(namespace.script)) ||
    input.domains.some(
      (domain) => domain.hostname === nativeIngressHost || domain.hostname === nativeWebHost
    )
  ) {
    throw Error(
      "Existing Worker, namespace or ingress domain; use guarded rollout or incident inspection"
    );
  }
};

const networkSurface = {
  workersDev: Schema.Literal(false),
  routes: Schema.optional(Schema.Never),
  namespace: Schema.optional(Schema.Never),
  preview: Schema.optional(Schema.Never),
  tailConsumers: Schema.optional(Schema.Never),
  streamingTailConsumers: Schema.optional(Schema.Never),
};
export type NativeHostMode = "acceptance" | "staged";
export const nativeHostPairs = (
  mode: NativeHostMode
): ReadonlyArray<(typeof installedOrigins)[keyof typeof installedOrigins]> =>
  mode === "staged"
    ? [installedOrigins.acceptance, installedOrigins.production]
    : [installedOrigins.acceptance];
const closedDomain = (role: "Web" | "Ingress", mode: NativeHostMode): Schema.Codec<unknown> =>
  Schema.Struct({
    name: Schema.Literal(role === "Web" ? nativeWebHost : nativeIngressHost),
    aliases:
      mode === "staged"
        ? Schema.Tuple([
            Schema.Literal(
              new URL(
                role === "Web"
                  ? installedOrigins.production.browser
                  : installedOrigins.production.api
              ).hostname
            ),
          ])
        : Schema.Tuple([]),
    redirects: Schema.optional(Schema.Tuple([])),
  });
export const requireInstallationWorker = ({
  logicalId,
  props,
  revision,
  hosts,
}: {
  logicalId: NativeRole;
  props: unknown;
  revision: string;
  hosts: NativeHostMode;
}): void => {
  const external = logicalId === "Ingress" || logicalId === "Web";
  const candidate = logicalId === "Core" || logicalId === "Ingress";
  Schema.decodeUnknownSync(
    Schema.Struct({
      ...networkSurface,
      name: Schema.Literal(
        logicalId === "Smoke" ? "fidy-native-smoke-" + revision : installationNames[logicalId]
      ),
      version: candidate
        ? Schema.Struct({ traffic: Schema.Literal(0), parent: Schema.optional(Schema.Never) })
        : Schema.optional(Schema.Never),
      domain: external ? closedDomain(logicalId, hosts) : Schema.optional(Schema.Never),
      crons:
        logicalId === "Core"
          ? Schema.Tuple([Schema.Literal("* * * * *")])
          : Schema.optional(Schema.Never),
    })
  )(props);
};

const ProviderBindings = Schema.Struct({ bindings: Schema.optional(NativeBindings) });
export const requireClosedBindings = (
  {
    worker,
    bindings,
  }: {
    worker: NativeRole;
    bindings: ReadonlyArray<NativeBinding>;
  },
  fingerprint = ""
): void => requireRoleBindings({ role: worker, bindings }, fingerprint);

const requireSiteAsset = (role: NativeRole, props: unknown, bindings: NativeBinding[]): void => {
  // The Worker provider appends the static ASSETS metadata from its build output outside its binding list.
  if (role === "Web" && !bindings.some((binding) => binding.name === "ASSETS")) {
    Schema.decodeUnknownSync(
      Schema.Struct({ assets: Schema.Struct({ directory: Schema.Unknown }) })
    )(props);
    bindings.push({ name: "ASSETS", type: "assets" });
  }
};
const requireSignerHost = (fingerprint: string, hosts: NativeHostMode): void => {
  if (fingerprint && hosts !== "acceptance") {
    throw Error("Fixture signer cannot stage live host routes");
  }
};
const roles = ["Core", "Ingress", "ForwardedEmail", "Web"] as const;
export const requireNativeBindings = (
  {
    plan,
    revision,
    hosts,
  }: {
    plan: Plan;
    revision: string;
    hosts: NativeHostMode;
  },
  fingerprint = ""
): void => {
  requireSignerHost(fingerprint, hosts);
  const resources = Object.values(plan.resources);
  for (const role of [...roles, "Smoke"] as const) {
    const logicalId = role === "Smoke" ? "ReleaseSmoke-" + revision : role;
    const node = resources.find((item) => describeResource(item).logicalId === logicalId);
    if (node === undefined) throw Error("Missing installed native Worker " + role);
    const props: unknown = node.action === "noop" ? node.state.props : node.props;
    requireInstallationWorker({ logicalId: role, props, revision, hosts });
    const bindings = node.bindings.flatMap(
      (binding) => Schema.decodeUnknownSync(ProviderBindings)(binding.data).bindings ?? []
    );
    requireSiteAsset(role, props, bindings);
    requireClosedBindings({ worker: role, bindings }, fingerprint);
    if (role === "Core") requireNativeClasses(bindings);
  }
};
const requireNativeClasses = (bindings: ReadonlyArray<NativeBinding>): void => {
  const classes = bindings.filter((binding) => binding.type === "durable_object_namespace");
  const verified = Object.entries(namespaceClasses).every(([name, expected]) =>
    classes.some(
      (binding) =>
        binding.name === name &&
        binding.className === expected &&
        binding.scriptName === undefined &&
        binding.transferredFrom === undefined
    )
  );
  if (!verified || classes.length !== Object.keys(namespaceClasses).length) {
    throw Error("Native namespace lifecycle differs");
  }
};
