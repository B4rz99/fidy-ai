import retainedProvider from "./native-retained-provider.json" with { type: "json" };
import {
  type NativeBinding,
  NativeBindings,
  type NativeRole,
  requireRoleBindings,
  requireSuccessorCoreBindings,
} from "./native-graph";
import {
  accountingFixture,
  accountingWorkerMain,
  nativeSmokeMain,
  receiptWorkerMain,
} from "./native-fixture-signer";
import { installedOrigins } from "@fidy/server/browser-transport";
import { type Plan, describeResource } from "alchemy/Plan";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import { namespaceClasses } from "./storage-release";

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

export const requireClosedBindings = ({
  worker,
  bindings,
  fingerprint,
}: {
  worker: NativeRole;
  bindings: ReadonlyArray<NativeBinding>;
  fingerprint: string;
}): void => requireRoleBindings({ role: worker, bindings, fingerprint });

const requireSiteAsset = (role: NativeRole, props: unknown, bindings: NativeBinding[]): void => {
  if (role === "Web" && !bindings.some((binding) => binding.name === "ASSETS")) {
    Schema.decodeUnknownSync(
      Schema.Struct({ assets: Schema.Struct({ directory: Schema.Unknown }) })
    )(props);
    bindings.push({ name: "ASSETS", type: "assets" });
  }
};

const requireSignerHost = (fingerprint: string, hosts: NativeHostMode): void => {
  if (fingerprint !== "" && hosts !== "acceptance") {
    throw Error("Fixture signer cannot stage live host routes");
  }
};

const roles = ["Core", "Ingress", "ForwardedEmail", "Web"] as const;

const requireFixtureMain = (
  role: NativeRole,
  props: unknown,
  {
    fingerprint,
    fallback,
    accounting,
  }: { fingerprint: string; fallback: boolean; accounting: boolean }
): void => {
  if (accounting && role === "Smoke") {
    Schema.decodeUnknownSync(
      Schema.Struct({
        main: Schema.Literal(nativeSmokeMain),
        build: Schema.optional(Schema.Never),
      })
    )(props);
  }

  if (fingerprint !== "" && (role === "Core" || role === "Ingress")) {
    const main = accounting ? accountingWorkerMain(role) : receiptWorkerMain({ role, fallback });
    Schema.decodeUnknownSync(Schema.Struct({ main: Schema.Literal(main) }))(props);
  }
};

const requireFixtureService = (
  role: NativeRole,
  bindings: readonly NativeBinding[],
  fingerprint: string
): void => {
  if (fingerprint === "" || (role !== "Ingress" && role !== "Core")) return;
  const provider = bindings.find((binding) => binding.name === "RELEASE_FIXTURE");

  if (provider?.service !== "fidy-native-smoke-" + retainedProvider.revision) {
    throw Error("Resolved original provider target differs");
  }
};

type NativePlanBindings = {
  plan: Plan;
  revision: string;
  hosts: NativeHostMode;
  fingerprint: string;
  fallback: boolean;
};

const requireAccountingBindings = (
  role: NativeRole,
  revision: string,
  bindings: ReadonlyArray<NativeBinding>
): void => {
  const expected = new Map([
    ["RELEASE_GIT_SHA", role === "Smoke" ? accountingFixture.revision : revision],
    ["CONTRACT_DIGEST", accountingFixture.contractDigest],
    ["NATIVE_STORAGE_ADMISSION", "closed"],
  ]);

  if (role !== "Ingress") {
    expected.set("SMOKE_QUEUE_NAME", "fidy-native-smoke-" + accountingFixture.revision);
  }

  for (const [name, text] of expected) {
    if (
      !bindings.some(
        (binding) => binding.name === name && binding.type === "plain_text" && binding.text === text
      )
    ) {
      throw Error("Accounting rollout binding differs for " + role + " " + name);
    }
  }
};

const requirePlannedRoleBindings = ({
  role,
  bindings,
  fingerprint,
  successorPlan,
}: {
  role: NativeRole;
  bindings: ReadonlyArray<NativeBinding>;
  fingerprint: string;
  successorPlan: boolean;
}): void => {
  if (successorPlan && role === "Core") {
    requireSuccessorCoreBindings({ bindings, fingerprint });
  } else requireClosedBindings({ worker: role, bindings, fingerprint });
};

const requirePlannedBindings = ({
  plan,
  revision,
  hosts,
  fingerprint,
  fallback,
  accountingRevision,
  successorPlan,
}: NativePlanBindings & {
  successorPlan: boolean;
  accountingRevision: Option.Option<string>;
}): void => {
  requireSignerHost(fingerprint, hosts);
  const resources = Object.values(plan.resources);

  const verifiedRoles = successorPlan
    ? (["Core", "Ingress", "Smoke"] as const)
    : ([...roles, "Smoke"] as const);

  for (const role of verifiedRoles) {
    const logicalId = role === "Smoke" ? "ReleaseSmoke-" + revision : role;
    const node = resources.find((item) => describeResource(item).logicalId === logicalId);

    if (node === undefined) throw Error("Missing installed native Worker " + role);
    const props: unknown = node.action === "noop" ? node.state.props : node.props;
    requireInstallationWorker({ logicalId: role, props, revision, hosts });
    requireFixtureMain(role, props, {
      fingerprint,
      fallback,
      accounting: Option.isSome(accountingRevision),
    });

    const bindings = node.bindings.flatMap(
      (binding) => Schema.decodeUnknownSync(ProviderBindings)(binding.data).bindings ?? []
    );

    requireFixtureService(role, bindings, fingerprint);
    requireSiteAsset(role, props, bindings);
    requirePlannedRoleBindings({ role, bindings, fingerprint, successorPlan });

    if (Option.isSome(accountingRevision)) {
      requireAccountingBindings(role, accountingRevision.value, bindings);
    }

    if (role === "Core") requireNativeClasses(bindings);
  }
};

export const requireNativeBindings = (input: NativePlanBindings): void =>
  requirePlannedBindings({ ...input, successorPlan: false, accountingRevision: Option.none() });

export const requireSuccessorPlanBindings = (
  input: Omit<NativePlanBindings, "hosts"> & { accountingRevision: Option.Option<string> }
): void => requirePlannedBindings({ ...input, hosts: "acceptance", successorPlan: true });

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
