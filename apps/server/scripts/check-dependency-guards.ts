#!/usr/bin/env bun

import { Option } from "effect";

const serverRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const sharedKernelRoot = `${serverRoot}/src/core/_shared`;
const sharedKernelFiles = new Set([
  "context.test.ts",
  "context.ts",
  "money.test.ts",
  "money.ts",
  "time.test.ts",
  "time.ts",
]);
const unexpectedSharedKernelFiles = Array.from(
  new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: sharedKernelRoot })
).filter((file) => !sharedKernelFiles.has(file));
if (unexpectedSharedKernelFiles.length > 0) {
  throw new Error(
    "The functional-core Shared Kernel contains values beyond Money, product context, and time: " +
      unexpectedSharedKernelFiles.join(", ")
  );
}

const retiredOutboundHttpFiles = [
  "src/shell/_shared/bounded-external-http.ts",
  "src/shell/_shared/bounded-external-http.test.ts",
  "src/shell/_shared/protected-http-client.ts",
  "src/shell/_shared/projected-http-client-error.ts",
] as const;
const retiredFileChecks = await Promise.all(
  retiredOutboundHttpFiles.map((path) =>
    Bun.file(`${serverRoot}/${path}`)
      .exists()
      .then((exists) => ({ path, exists }))
  )
);
const retainedFile = retiredFileChecks.find(({ exists }) => exists);
if (retainedFile !== undefined) {
  throw new Error(`Retired Outbound HTTP implementation still exists: ${retainedFile.path}`);
}

const PROBE_PARENT = "src/core/audit";
const PROBE_PREFIX = `__probe-${process.pid}-`;

type ProbeFile = {
  readonly path: string;
  readonly source: string;
};

type Expectation =
  | { readonly kind: "allowed" }
  | { readonly kind: "rejected"; readonly mustContain: readonly string[] };

type Probe = {
  readonly expect: Expectation;
  readonly files: readonly ProbeFile[];
  readonly name: string;
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const runGraph = (
  sourceRoots: readonly string[] = ["src", "scripts", "tools", "cloudflare"]
): { readonly exitCode: Option.Option<number>; readonly report: string } => {
  const spawned = Bun.spawnSync(["bun", "../../tools/depcruise/run.mjs", ".", ...sourceRoots], {
    cwd: serverRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: Option.fromNullOr(spawned.exitCode),
    report: `${decode(spawned.stdout)}\n${decode(spawned.stderr)}`,
  };
};

const dir = (slug: string): string => `${PROBE_PARENT}/${PROBE_PREFIX}${slug}`;
const sourceDir = (slug: string): string => `src/${PROBE_PREFIX}${slug}`;

const SIBLING_REFERENCE = dir("sibling-reference");
const SIBLING_IMPLEMENTATION = dir("sibling-implementation");
const TYPE_ONLY = dir("type-only");
const CORE_TO_SHELL = dir("core-imports-shell");
const CORE_TO_WORLD = dir("core-imports-the-world");
const CLIENT_SEAM_ALLOWED = sourceDir("client-seam-allowed");
const CLIENT_SEAM_BYPASS = sourceDir("client-seam-bypass");
const CYCLE = dir("cycle");
const BARREL = dir("barrel");
const ALIAS_SAME_DIRECTORY = dir("alias-same-directory");
const RELATIVE_CROSS_DIRECTORY = dir("relative-cross-directory");
const HOSTED_MODEL = `src/shell/agent/${PROBE_PREFIX}hosted-model`;
const HOSTED_TOKENIZER = `src/shell/agent/${PROBE_PREFIX}hosted-tokenizer`;

const ownInternal = `src/core/${PROBE_PREFIX}own-internal`;
const foreignInternalSource = `src/core/${PROBE_PREFIX}foreign-internal-source`;
const foreignInternalTarget = `src/core/${PROBE_PREFIX}foreign-internal-target`;
const nestedForeignInternalSource = `src/shell/channels/${PROBE_PREFIX}foreign-internal-source`;
const nestedForeignInternalTarget = `src/shell/channels/${PROBE_PREFIX}foreign-internal-target`;
const nestedInterfaceDirection = `src/shell/channels/${PROBE_PREFIX}interface-direction`;
const typeInternalSource = `src/shell/${PROBE_PREFIX}type-internal-source`;
const typeInternalTarget = `src/shell/${PROBE_PREFIX}type-internal-target`;
const outboundHttpPublishedSource = `src/shell/${PROBE_PREFIX}outbound-http-published`;
const outboundHttpPrivateSource = `src/shell/${PROBE_PREFIX}outbound-http-private`;
const providerRawHttpSource = `src/shell/agent/${PROBE_PREFIX}provider-raw-http/probe.test.ts`;
const interfaceDirection = `src/core/${PROBE_PREFIX}interface-direction`;
const internalDirection = `src/core/${PROBE_PREFIX}internal-direction`;
const operationsDirection = `src/core/${PROBE_PREFIX}operations-direction`;
const reexportInternal = `src/core/${PROBE_PREFIX}reexport-internal`;
const reexportInternalAlias = `src/core/${PROBE_PREFIX}reexport-internal-alias`;
const reexportInternalType = `src/core/${PROBE_PREFIX}reexport-internal-type`;
const publishedSource = `src/shell/${PROBE_PREFIX}published-source`;
const publishedTarget = `src/shell/${PROBE_PREFIX}published-target`;
const runtimeSource = `src/shell/${PROBE_PREFIX}runtime-source`;
const runtimeTarget = `src/shell/${PROBE_PREFIX}runtime-target`;
const runtimeComposer = `src/shell/${PROBE_PREFIX}runtime-composer`;
const localTestInternal = `src/shell/${PROBE_PREFIX}local-test-internal`;
const foreignTestSource = `src/shell/${PROBE_PREFIX}foreign-test-source`;
const foreignTestTarget = `src/shell/${PROBE_PREFIX}foreign-test-target`;
const scriptPublication = `scripts/${PROBE_PREFIX}publication`;
const toolInternal = `tools/${PROBE_PREFIX}internal`;
const toolInternalTarget = `src/shell/${PROBE_PREFIX}tool-internal-target`;
const toolRuntime = `tools/${PROBE_PREFIX}runtime-access`;
const toolRuntimeAllowed = `tools/${PROBE_PREFIX}runtime-composition`;
const toolRuntimeTarget = `src/shell/${PROBE_PREFIX}tool-runtime-target`;
const scriptRuntime = `scripts/${PROBE_PREFIX}runtime-composition`;
const landmarkInternal = `src/${PROBE_PREFIX}landmark-internal`;
const landmarkInternalTarget = `src/shell/${PROBE_PREFIX}landmark-internal-target`;
const emptyGraph = `tools/${PROBE_PREFIX}empty-graph`;
const cloudflareConsentPublished = `cloudflare/${PROBE_PREFIX}consent-published`;
const cloudflareConsentPrivate = `cloudflare/${PROBE_PREFIX}consent-private`;
const cloudflareConsentShellPrivate = `cloudflare/consent/${PROBE_PREFIX}shell-private`;
const cloudflareConsentCorePrivate = `cloudflare/consent/${PROBE_PREFIX}core-private`;

const cloudflareIdentityPublished = `cloudflare/${PROBE_PREFIX}identity-published`;
const cloudflareIdentityPrivate = `cloudflare/${PROBE_PREFIX}identity-private`;
const cloudflareIdentityShellPrivate = `cloudflare/identity/${PROBE_PREFIX}shell-private`;
const cloudflareIdentityContextPrivate = `tools/${PROBE_PREFIX}identity-context-private`;

const cloudflareSessionPublished = `cloudflare/${PROBE_PREFIX}session-published`;
const cloudflareSessionPrivate = `cloudflare/${PROBE_PREFIX}session-private`;
const cloudflareSessionShellPrivate = `cloudflare/web-session/${PROBE_PREFIX}shell-private`;
const cloudflarePairingPrivate = `tools/${PROBE_PREFIX}pairing-private`;

const subscriptionPublished = `cloudflare/${PROBE_PREFIX}subscription-published`;
const subscriptionPrivate = `cloudflare/${PROBE_PREFIX}subscription-private`;
const subscriptionPortablePrivate = `cloudflare/subscription/${PROBE_PREFIX}portable-private`;
const subscriptionToolPrivate = `tools/${PROBE_PREFIX}subscription-private`;
const subscriptionLaundering = `cloudflare/${PROBE_PREFIX}subscription-laundering`;

const tokensPublished = `cloudflare/${PROBE_PREFIX}tokens-published`;
const tokensPrivate = `cloudflare/${PROBE_PREFIX}tokens-private`;
const tokensPortablePrivate = `cloudflare/tokens/${PROBE_PREFIX}portable-private`;
const tokensToolPrivate = `tools/${PROBE_PREFIX}tokens-private`;

const canonicalPublication = `cloudflare/canonical-operations/${PROBE_PREFIX}publication`;
const canonicalContractDirection = `cloudflare/canonical-operations/${PROBE_PREFIX}contract-direction`;
const canonicalInternalDirection = `cloudflare/canonical-operations/${PROBE_PREFIX}internal-direction`;
const canonicalOperationsDirection = `cloudflare/canonical-operations/${PROBE_PREFIX}operations-direction`;
const canonicalReexport = `cloudflare/canonical-operations/${PROBE_PREFIX}reexport`;
const canonicalAlias = `cloudflare/canonical-operations/${PROBE_PREFIX}alias`;
const canonicalTypeAlias = `cloudflare/canonical-operations/${PROBE_PREFIX}type-alias`;

const PROBES: readonly Probe[] = [
  {
    name: "Maintenance runtime composes published owner runtimes and contracts",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/maintenance/${PROBE_PREFIX}published/runtime.ts`,
        source:
          'import { makeAgentRetention } from "../../agent/runtime";\nimport type { AgentRetention } from "../../agent/contract";\nexport const build: (db: D1Database) => AgentRetention = (db) => makeAgentRetention({ db });\n',
      },
    ],
  },
  {
    name: "Maintenance cannot import a foreign owner operation even as a type",
    expect: { kind: "rejected", mustContain: ["error maintenance-imports-owner-implementation"] },
    files: [
      {
        path: `cloudflare/maintenance/${PROBE_PREFIX}owner-operation/probe.ts`,
        source:
          'import type { prepareHostedMutationCommit } from "../../agent/operations";\nexport type Bypass = typeof prepareHostedMutationCommit;\n',
      },
    ],
  },
  {
    name: "Maintenance cannot bypass platform runtime through a legacy operational helper",
    expect: { kind: "rejected", mustContain: ["error maintenance-imports-owner-implementation"] },
    files: [
      {
        path: `cloudflare/maintenance/${PROBE_PREFIX}platform-helper/probe.ts`,
        source:
          'import { observeOperationalHealth } from "../../runtime/operational-health";\nexport const bypass = observeOperationalHealth;\n',
      },
    ],
  },
  {
    name: "Maintenance cannot acquire raw resource admission authority",
    expect: { kind: "rejected", mustContain: ["error maintenance-imports-owner-implementation"] },
    files: [
      {
        path: `cloudflare/maintenance/${PROBE_PREFIX}raw-admission/probe.ts`,
        source:
          'import { ResourceAdmissionAuthority } from "../../resource-admission/authority";\nexport const bypass = ResourceAdmissionAuthority;\n',
      },
    ],
  },
  {
    name: "Maintenance declarations cannot construct runtime",
    expect: {
      kind: "rejected",
      mustContain: ["error maintenance-contract-imports-implementation"],
    },
    files: [
      {
        path: `cloudflare/maintenance/${PROBE_PREFIX}contract-direction/contract.ts`,
        source:
          'import { runCoreMaintenance } from "../runtime";\nexport const bypass = runCoreMaintenance;\n',
      },
    ],
  },
  {
    name: "Maintenance execution cannot acquire runtime",
    expect: { kind: "rejected", mustContain: ["error maintenance-operations-imports-runtime"] },
    files: [
      {
        path: `cloudflare/maintenance/${PROBE_PREFIX}operations-direction/operations.ts`,
        source:
          'import { runCoreMaintenance } from "../runtime";\nexport const bypass = runCoreMaintenance;\n',
      },
    ],
  },
  {
    name: "Owner implementations cannot depend back on Maintenance",
    expect: { kind: "rejected", mustContain: ["error maintenance-owner-backedge"] },
    files: [
      {
        path: `cloudflare/agent/${PROBE_PREFIX}maintenance-backedge/probe.ts`,
        source:
          'import { runCoreMaintenance } from "../../maintenance/runtime";\nexport const bypass = runCoreMaintenance;\n',
      },
    ],
  },
  {
    name: "Foreign consumers cannot import platform scheduled internals",
    expect: { kind: "rejected", mustContain: ["error platform-maintenance-internal-private"] },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}platform-private/probe.test.ts`,
        source:
          'import { inspectScheduledHealth } from "../runtime/internal/scheduled-health";\nexport const bypass = inspectScheduledHealth;\n',
      },
    ],
  },
  {
    name: "Maintenance interfaces cannot reexport private scheduling implementation",
    expect: { kind: "rejected", mustContain: ["error scheduled-interface-reexports-internal"] },
    files: [
      {
        path: `cloudflare/maintenance/${PROBE_PREFIX}reexport/runtime.ts`,
        source: `export { state } from "../internal/${PROBE_PREFIX}reexport/state";\n`,
      },
      {
        path: `cloudflare/maintenance/internal/${PROBE_PREFIX}reexport/state.ts`,
        source: 'export const state = "private";\n',
      },
    ],
  },
  {
    name: "Platform internals cannot depend on their outward runtime",
    expect: {
      kind: "rejected",
      mustContain: ["error scheduled-internal-imports-outward-interface"],
    },
    files: [
      {
        path: `cloudflare/runtime/internal/${PROBE_PREFIX}outward/probe.ts`,
        source:
          'import { makePlatformMaintenance } from "../../runtime";\nexport const bypass = makePlatformMaintenance;\n',
      },
    ],
  },
  {
    name: "callers consume Onboarding through its data-free operation",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}onboarding-published/probe.ts`,
        source:
          'import { completeOnboarding } from "../onboarding/operations";\nexport const published = [completeOnboarding];\n',
      },
    ],
  },
  {
    name: "foreign scripts cannot acquire private Onboarding composition",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-onboarding-internal: scripts/${PROBE_PREFIX}onboarding-private/probe.ts → cloudflare/onboarding/internal/completion.ts`,
      ],
    },
    files: [
      {
        path: `scripts/${PROBE_PREFIX}onboarding-private/probe.ts`,
        source:
          'import { complete } from "../../cloudflare/onboarding/internal/completion";\nexport const bypass = complete;\n',
      },
    ],
  },
  {
    name: "Onboarding cannot acquire delivery runtime authority",
    expect: {
      kind: "rejected",
      mustContain: [
        `error onboarding-imports-unpublished-native-authority: cloudflare/onboarding/${PROBE_PREFIX}foreign-runtime/probe.ts → cloudflare/email-authentication/runtime.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/onboarding/${PROBE_PREFIX}foreign-runtime/probe.ts`,
        source:
          'import { dispatchBrowserPairingEmail } from "../../email-authentication/runtime";\nexport const bypass = dispatchBrowserPairingEmail;\n',
      },
    ],
  },
  {
    name: "Onboarding cannot import private mailbox proof handling",
    expect: {
      kind: "rejected",
      mustContain: [
        `error onboarding-imports-unpublished-native-authority: cloudflare/onboarding/${PROBE_PREFIX}foreign-proof/probe.ts → cloudflare/email-authentication/internal/verified-onboarding.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/onboarding/${PROBE_PREFIX}foreign-proof/probe.ts`,
        source:
          'import { verifyOnboardingEmail } from "../../email-authentication/internal/verified-onboarding";\nexport const bypass = verifyOnboardingEmail;\n',
      },
    ],
  },
  {
    name: "foreign scripts cannot acquire private Web Authentication dispatch",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-web-authentication-internal: scripts/${PROBE_PREFIX}web-auth-private/probe.ts → cloudflare/web-authentication/internal/protocol.ts`,
      ],
    },
    files: [
      {
        path: `scripts/${PROBE_PREFIX}web-auth-private/probe.ts`,
        source:
          'import { respond } from "../../cloudflare/web-authentication/internal/protocol";\nexport const bypass = respond;\n',
      },
    ],
  },
  {
    name: "Web Authentication cannot acquire foreign runtime authority",
    expect: {
      kind: "rejected",
      mustContain: [
        `error web-authentication-imports-unpublished-native-authority: cloudflare/web-authentication/${PROBE_PREFIX}foreign-runtime/probe.ts → cloudflare/email-authentication/runtime.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/web-authentication/${PROBE_PREFIX}foreign-runtime/probe.ts`,
        source:
          'import { dispatchBrowserPairingEmail } from "../../email-authentication/runtime";\nexport const bypass = dispatchBrowserPairingEmail;\n',
      },
    ],
  },
  {
    name: "Web Authentication cannot import foreign persistence",
    expect: {
      kind: "rejected",
      mustContain: [
        `error web-authentication-imports-unpublished-native-authority: cloudflare/web-authentication/${PROBE_PREFIX}foreign-proof/probe.ts → cloudflare/browser-login/internal/claim.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/web-authentication/${PROBE_PREFIX}foreign-proof/probe.ts`,
        source:
          'import { prepareClaim } from "../../browser-login/internal/claim";\nexport const bypass = prepareClaim;\n',
      },
    ],
  },
  {
    name: "native Agent cannot bypass HostedInference through a raw model or tokenizer",
    expect: { kind: "rejected", mustContain: ["error native-agent-imports-model-implementation"] },
    files: [
      {
        path: `cloudflare/agent/${PROBE_PREFIX}raw-model/probe.ts`,
        source:
          'import { LanguageModel, Tokenizer } from "effect/unstable/ai";\nexport const bypass = [LanguageModel, Tokenizer];\n',
      },
    ],
  },
  {
    name: "native Agent ownership remains acyclic",
    expect: { kind: "rejected", mustContain: ["error native-agent-cycle"] },
    files: [
      {
        path: `cloudflare/agent/${PROBE_PREFIX}cycle/a.ts`,
        source: 'import type { B } from "./b";\nexport type A = { readonly b: B };\n',
      },
      {
        path: `cloudflare/agent/${PROBE_PREFIX}cycle/b.ts`,
        source: 'import type { A } from "./a";\nexport type B = { readonly a: A };\n',
      },
    ],
  },

  {
    name: "native Agent cannot import portable private context selection",
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-agent-internal: cloudflare/agent/${PROBE_PREFIX}portable-private/probe.ts → src/core/agent/internal/rules.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/agent/${PROBE_PREFIX}portable-private/probe.ts`,
        source:
          'import { isTranscriptWindowEntry } from "~/core/agent/internal/rules";\nexport const bypass = isTranscriptWindowEntry;\n',
      },
    ],
  },
  {
    name: "foreign tests cannot acquire native Turn or compaction persistence",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-agent-internal: cloudflare/${PROBE_PREFIX}agent-private/probe.test.ts → cloudflare/agent/internal/turn-store.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}agent-private/probe.test.ts`,
        source:
          'import { readHostedContinuity, commitHostedCompaction } from "../agent/internal/turn-store";\nexport const bypass = [readHostedContinuity, commitHostedCompaction];\n',
      },
    ],
  },
  {
    name: "tools cannot acquire Agent context construction",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-agent-internal: tools/${PROBE_PREFIX}agent-private/probe.ts → cloudflare/agent/internal/working-context.ts`,
      ],
    },
    files: [
      {
        path: `tools/${PROBE_PREFIX}agent-private/probe.ts`,
        source:
          'import { assembleWorkingContext } from "../../cloudflare/agent/internal/working-context";\nexport const bypass = assembleWorkingContext;\n',
      },
    ],
  },
  {
    name: "Agent declarations cannot acquire execution",
    expect: {
      kind: "rejected",
      mustContain: [
        `error agent-contract-imports-implementation: cloudflare/agent/${PROBE_PREFIX}contract-direction/contract.ts → cloudflare/agent/internal/hosted-turn.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/agent/${PROBE_PREFIX}contract-direction/contract.ts`,
        source:
          'import { completeHostedTurn } from "../internal/hosted-turn";\nexport const bypass = completeHostedTurn;\n',
      },
    ],
  },
  {
    name: "Agent private workflow cannot import outward lifecycle interfaces",
    expect: {
      kind: "rejected",
      mustContain: [
        `error agent-internal-imports-outward-interface: cloudflare/agent/internal/${PROBE_PREFIX}outward/probe.ts → cloudflare/agent/runtime.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/agent/internal/${PROBE_PREFIX}outward/probe.ts`,
        source:
          'import { makeAgentService } from "../../runtime";\nexport const bypass = makeAgentService;\n',
      },
    ],
  },
  {
    name: "Agent atomic operations cannot acquire runtime",
    expect: {
      kind: "rejected",
      mustContain: [
        `error agent-operations-imports-runtime: cloudflare/agent/${PROBE_PREFIX}operation-direction/operations.ts → cloudflare/agent/runtime.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/agent/${PROBE_PREFIX}operation-direction/operations.ts`,
        source:
          'import { makeAgentService } from "../runtime";\nexport const bypass = makeAgentService;\n',
      },
    ],
  },
  {
    name: "Agent runtime cannot reexport lifecycle internals",
    expect: {
      kind: "rejected",
      mustContain: [
        `error agent-interface-reexports-internal: cloudflare/agent/${PROBE_PREFIX}launder/runtime.ts → cloudflare/agent/internal/turn-store.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/agent/${PROBE_PREFIX}launder/runtime.ts`,
        source: 'export { finishHostedTurn } from "../internal/turn-store";\n',
      },
    ],
  },
  {
    name: "callers can construct complete Agent and bounded retention runtimes",
    expect: {
      kind: "allowed",
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}agent-published/runtime.ts`,
        source:
          'import { makeAgentService, makeAgentRetention } from "../agent/runtime";\nimport { prepareHostedMutationCommit } from "../agent/operations";\nimport { HostedTurnAdmission } from "../agent/contract";\nexport const published = [makeAgentService, makeAgentRetention, prepareHostedMutationCommit, HostedTurnAdmission];\n',
      },
    ],
  },
  {
    name: "channel peers cannot acquire private Turn or Transcript projections",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-agent-internal: cloudflare/whatsapp/${PROBE_PREFIX}turn-private/probe.ts → cloudflare/agent/internal/channel-evidence.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/whatsapp/${PROBE_PREFIX}turn-private/probe.ts`,
        source:
          'import { channelContinuationQuery } from "../../agent/internal/channel-evidence";\nexport const bypass = channelContinuationQuery;\n',
      },
    ],
  },

  {
    name: "native callers cannot bypass authenticated WhatsApp transport",
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-whatsapp-internal: cloudflare/${PROBE_PREFIX}whatsapp-private/probe.ts → src/shell/channels/whatsapp/internal/kapso-client.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}whatsapp-private/probe.ts`,
        source:
          'import { makeWhatsAppDelivery } from "~/shell/channels/whatsapp/internal/kapso-client";\nexport const bypass = makeWhatsAppDelivery;\n',
      },
    ],
  },
  {
    name: "tooling cannot acquire WhatsApp replay or delivery persistence",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-whatsapp-internal: tools/${PROBE_PREFIX}whatsapp-private/probe.ts → cloudflare/whatsapp/internal/whatsapp-delivery.ts`,
      ],
    },
    files: [
      {
        path: `tools/${PROBE_PREFIX}whatsapp-private/probe.ts`,
        source:
          'import { recordWhatsAppStatus } from "../../cloudflare/whatsapp/internal/whatsapp-delivery";\nexport const bypass = recordWhatsAppStatus;\n',
      },
    ],
  },
  {
    name: "published WhatsApp operations remain available without implementation access",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}whatsapp-published/probe.ts`,
        source:
          'import { classifyWhatsAppAdmission, recordWhatsAppStatus } from "../whatsapp/operations";\nimport { WhatsAppTurnAdmission } from "../whatsapp/contract";\nexport const published = [classifyWhatsAppAdmission, recordWhatsAppStatus, WhatsAppTurnAdmission];\n',
      },
    ],
  },

  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}memory-published/probe.ts`,
        source:
          'import { prepareRemember, prepareRevise, prepareForget, recallMemories, readMemoryContext } from "../memory/operations";\nexport const published = [prepareRemember, prepareRevise, prepareForget, recallMemories, readMemoryContext];\n',
      },
    ],
    name: "callers compose the four durable Memory operations and purpose-bound current context",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-memory-internal: cloudflare/${PROBE_PREFIX}memory-private/probe.test.ts → cloudflare/memory/internal/storage.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}memory-private/probe.test.ts`,
        source:
          'import { memoryRowsQuery } from "../memory/internal/storage";\nexport const bypass = memoryRowsQuery;\n',
      },
    ],
    name: "foreign tests cannot obtain private Memory row projections",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-memory-internal: tools/${PROBE_PREFIX}memory-private/probe.ts → cloudflare/memory/internal/${PROBE_PREFIX}storage/private.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/memory/internal/${PROBE_PREFIX}storage/private.ts`,
        source: "export const privateMemoryStorage = 1;\n",
      },
      {
        path: `tools/${PROBE_PREFIX}memory-private/probe.ts`,
        source: `import { privateMemoryStorage } from "../../cloudflare/memory/internal/${PROBE_PREFIX}storage/private";\nexport const bypass = privateMemoryStorage;\n`,
      },
    ],
    name: "tooling cannot acquire private Memory storage or free-text projections",
  },
  {
    name: "native callers cannot acquire private canonical dispatch",
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-canonical-internal: cloudflare/${PROBE_PREFIX}canonical-private/probe.ts → src/shell/canonical-operations/internal/operation-registry.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}canonical-private/probe.ts`,
        source:
          'import { findCanonicalOperationImplementation } from "~/shell/canonical-operations/internal/operation-registry";\nexport const bypass = findCanonicalOperationImplementation;\n',
      },
    ],
  },
  {
    name: "native callers consume published catalog and canonical policy",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}canonical-public/probe.ts`,
        source:
          'import { getCanonicalOperationInput } from "~/shell/canonical-operations/operations";\nimport { decideOperationAccess } from "~/shell/canonical-policy/operations";\nimport type { CatalogOperation } from "~/shell/canonical-catalog/contract";\nexport type Operation = CatalogOperation;\nexport const published = [getCanonicalOperationInput, decideOperationAccess];\n',
      },
    ],
  },
  {
    name: "native peers compose canonical execution and installed discovery through published operations",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}canonical-execution-public/probe.ts`,
        source:
          'import { executeCanonicalWork, executeCanonicalQuery, installedCanonicalOperations } from "../canonical-operations/operations";\nimport type { CanonicalWork } from "../canonical-operations/contract";\nexport type Work = CanonicalWork;\nexport const published = [executeCanonicalWork, executeCanonicalQuery, installedCanonicalOperations];\n',
      },
    ],
  },
  {
    name: "tool tests consume canonical declarations and installed discovery",
    expect: { kind: "allowed" },
    files: [
      {
        path: `tools/${PROBE_PREFIX}canonical-execution-public/probe.test.ts`,
        source:
          'import { installedCanonicalOperations } from "../../cloudflare/canonical-operations/operations";\nimport type { CanonicalMutationPreparation } from "../../cloudflare/canonical-operations/contract";\nexport type Preparation = CanonicalMutationPreparation;\nexport const discover = installedCanonicalOperations;\n',
      },
    ],
  },
  {
    name: "canonical owner tests may exercise private query and mutation assembly",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/canonical-operations/internal/${PROBE_PREFIX}owner-test/probe.test.ts`,
        source:
          'import { canonicalQueryOwner } from "../query-registry";\nimport { canonicalMutationAdapter } from "../mutation-registry";\nexport const ownerAssembly = [canonicalQueryOwner, canonicalMutationAdapter];\n',
      },
    ],
  },
  {
    name: "canonical publication composes declarations and private behavior in the inward direction",
    expect: { kind: "allowed" },
    files: [
      {
        path: `${canonicalPublication}/contract.ts`,
        source: "export type Input = boolean;\n",
      },
      {
        path: `${canonicalPublication}/internal/execute.ts`,
        source:
          'import type { Input } from "../contract";\nexport const execute = (input: Input): boolean => !input;\n',
      },
      {
        path: `${canonicalPublication}/operations.ts`,
        source:
          'import type { Input } from "./contract";\nimport { execute } from "./internal/execute";\nexport const run = (input: Input): boolean => execute(input);\n',
      },
      {
        path: `${canonicalPublication}/runtime.ts`,
        source:
          'import { run } from "./operations";\nexport const makeRunner = () => () => run(true);\n',
      },
    ],
  },
  {
    name: "foreign native tests cannot acquire canonical query or mutation registries",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-canonical-internal: cloudflare/${PROBE_PREFIX}canonical-registry-private/probe.test.ts → cloudflare/canonical-operations/internal/query-registry.ts`,
        `error foreign-module-imports-cloudflare-canonical-internal: cloudflare/${PROBE_PREFIX}canonical-registry-private/probe.test.ts → cloudflare/canonical-operations/internal/mutation-registry.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}canonical-registry-private/probe.test.ts`,
        source:
          'import { canonicalQueryOwner } from "../canonical-operations/internal/query-registry";\nimport { canonicalMutationAdapter } from "../canonical-operations/internal/mutation-registry";\nexport const bypass = [canonicalQueryOwner, canonicalMutationAdapter];\n',
      },
    ],
  },
  {
    name: "tooling cannot acquire canonical query dispatch or private mutation-unit types",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-canonical-internal: tools/${PROBE_PREFIX}canonical-unit-private/probe.ts → cloudflare/canonical-operations/internal/query-registry.ts`,
        `error foreign-module-imports-cloudflare-canonical-internal: tools/${PROBE_PREFIX}canonical-unit-private/probe.ts → cloudflare/canonical-operations/internal/mutation-unit.ts`,
      ],
    },
    files: [
      {
        path: `tools/${PROBE_PREFIX}canonical-unit-private/probe.ts`,
        source:
          'import { canonicalQueryOwner } from "../../cloudflare/canonical-operations/internal/query-registry";\nimport type { CanonicalMutationUnitExecution } from "../../cloudflare/canonical-operations/internal/mutation-unit";\nexport type Unit = CanonicalMutationUnitExecution;\nexport const bypass = canonicalQueryOwner;\n',
      },
    ],
  },
  {
    name: "scripts cannot acquire private canonical batch or trigger interpretation",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-canonical-internal: scripts/${PROBE_PREFIX}canonical-batch-private/probe.ts → cloudflare/canonical-operations/internal/batch.ts`,
        `error foreign-module-imports-cloudflare-canonical-internal: scripts/${PROBE_PREFIX}canonical-batch-private/probe.ts → cloudflare/canonical-operations/internal/triggers.ts`,
      ],
    },
    files: [
      {
        path: `scripts/${PROBE_PREFIX}canonical-batch-private/probe.ts`,
        source:
          'import { executeCanonicalBatch } from "../../cloudflare/canonical-operations/internal/batch";\nimport { canonicalTriggerOf } from "../../cloudflare/canonical-operations/internal/triggers";\nexport const bypass = [executeCanonicalBatch, canonicalTriggerOf];\n',
      },
    ],
  },
  {
    name: "canonical declarations cannot import private implementation or outward behavior",
    expect: {
      kind: "rejected",
      mustContain: [
        `error canonical-contract-imports-implementation: ${canonicalContractDirection}/contract.ts → ${canonicalContractDirection}/internal/value.ts`,
        `error canonical-contract-imports-implementation: ${canonicalContractDirection}/contract.ts → ${canonicalContractDirection}/operations.ts`,
        `error canonical-contract-imports-implementation: ${canonicalContractDirection}/contract.ts → ${canonicalContractDirection}/runtime.ts`,
      ],
    },
    files: [
      {
        path: `${canonicalContractDirection}/internal/value.ts`,
        source: "export type PrivateValue = boolean;\n",
      },
      {
        path: `${canonicalContractDirection}/operations.ts`,
        source: "export const operation = true;\n",
      },
      {
        path: `${canonicalContractDirection}/runtime.ts`,
        source: "export const runtime = true;\n",
      },
      {
        path: `${canonicalContractDirection}/contract.ts`,
        source:
          'import type { PrivateValue } from "./internal/value";\nimport { operation } from "./operations";\nimport { runtime } from "./runtime";\nexport type Value = PrivateValue;\nexport const outward = [operation, runtime];\n',
      },
    ],
  },
  {
    name: "canonical internals cannot depend backwards on published operations or runtime",
    expect: {
      kind: "rejected",
      mustContain: [
        `error canonical-internal-imports-outward-interface: ${canonicalInternalDirection}/internal/value.ts → ${canonicalInternalDirection}/operations.ts`,
        `error canonical-internal-imports-outward-interface: ${canonicalInternalDirection}/internal/value.ts → ${canonicalInternalDirection}/runtime.ts`,
      ],
    },
    files: [
      {
        path: `${canonicalInternalDirection}/operations.ts`,
        source: "export const operation = true;\n",
      },
      {
        path: `${canonicalInternalDirection}/runtime.ts`,
        source: "export const runtime = true;\n",
      },
      {
        path: `${canonicalInternalDirection}/internal/value.ts`,
        source:
          'import { operation } from "../operations";\nimport { runtime } from "../runtime";\nexport const outward = [operation, runtime];\n',
      },
    ],
  },
  {
    name: "canonical operations cannot acquire runtime construction authority",
    expect: {
      kind: "rejected",
      mustContain: [
        `error canonical-operations-imports-runtime: ${canonicalOperationsDirection}/operations.ts → ${canonicalOperationsDirection}/runtime.ts`,
      ],
    },
    files: [
      {
        path: `${canonicalOperationsDirection}/runtime.ts`,
        source: "export const runtime = true;\n",
      },
      {
        path: `${canonicalOperationsDirection}/operations.ts`,
        source: 'import { runtime } from "./runtime";\nexport const operation = runtime;\n',
      },
    ],
  },
  {
    name: "canonical interfaces cannot re-export private dispatch",
    expect: {
      kind: "rejected",
      mustContain: [
        `error canonical-interface-reexports-internal: ${canonicalReexport}/operations.ts → ${canonicalReexport}/internal/dispatch.ts`,
      ],
    },
    files: [
      {
        path: `${canonicalReexport}/internal/dispatch.ts`,
        source: "export const dispatch = (): boolean => true;\n",
      },
      {
        path: `${canonicalReexport}/operations.ts`,
        source: 'export { dispatch } from "./internal/dispatch";\n',
      },
    ],
  },
  {
    name: "canonical interfaces cannot launder private dispatch through local aliases",
    expect: {
      kind: "rejected",
      mustContain: [
        `error published-interface-reexports-internal: ${canonicalAlias}/operations.ts → ./internal/dispatch`,
      ],
    },
    files: [
      {
        path: `${canonicalAlias}/internal/dispatch.ts`,
        source: "export const dispatch = (): boolean => true;\n",
      },
      {
        path: `${canonicalAlias}/operations.ts`,
        source:
          'import { dispatch } from "./internal/dispatch";\nconst alias = dispatch;\nexport const publishedDispatch = alias;\n',
      },
    ],
  },
  {
    name: "canonical interfaces cannot launder private unit types through aliases",
    expect: {
      kind: "rejected",
      mustContain: [
        `error published-interface-reexports-internal: ${canonicalTypeAlias}/operations.ts → ./internal/unit`,
      ],
    },
    files: [
      {
        path: `${canonicalTypeAlias}/internal/unit.ts`,
        source: "export type PrivateUnit = { readonly committed: boolean };\n",
      },
      {
        path: `${canonicalTypeAlias}/operations.ts`,
        source:
          'import type { PrivateUnit } from "./internal/unit";\nexport type PublishedUnit = PrivateUnit;\n',
      },
    ],
  },

  {
    name: "native callers use the published data-less AccessTier coordinator",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}access-tier-public/probe.ts`,
        source:
          'import { activeProUserCondition } from "~/shell/access-tier/operations";\nexport const condition = activeProUserCondition;\n',
      },
    ],
  },
  {
    name: "AccessTier cannot bypass Identity or Subscription published operations",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-internal: src/shell/access-tier/${PROBE_PREFIX}private/probe.ts → src/shell/identity/internal/user-query.ts`,
        `error foreign-module-imports-internal: src/shell/access-tier/${PROBE_PREFIX}private/probe.ts → src/shell/subscription/internal/query-sql.ts`,
      ],
    },
    files: [
      {
        path: `src/shell/access-tier/${PROBE_PREFIX}private/probe.ts`,
        source:
          'import { findUser } from "~/shell/identity/internal/user-query";\nimport { subscriptionStandingQuery } from "~/shell/subscription/internal/query-sql";\nexport const forbidden = [findUser, subscriptionStandingQuery];\n',
      },
    ],
  },
  {
    name: "Insights callers use owner operations and bounded due identities",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}insights-public/probe.ts`,
        source:
          'import { discoverDueInsights, generateInsight, prepareInsightTransition } from "../insights/operations";\nexport const operations = [discoverDueInsights, generateInsight, prepareInsightTransition];\n',
      },
    ],
  },
  {
    name: "foreign tests cannot access Insights storage or delivery mechanics",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-insights-internal: cloudflare/${PROBE_PREFIX}insights-private/probe.test.ts → cloudflare/insights/internal/insight-store.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}insights-private/probe.test.ts`,
        source:
          'import { findInsight } from "../insights/internal/insight-store";\nexport const leak = findInsight;\n',
      },
    ],
  },
  {
    name: "tooling cannot bypass the InsightEvent owner",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-insights-internal: tools/${PROBE_PREFIX}insights-private/probe.ts → cloudflare/insights/internal/insight-store.ts`,
      ],
    },
    files: [
      {
        path: `tools/${PROBE_PREFIX}insights-private/probe.ts`,
        source:
          'import { generateInsight } from "../../cloudflare/insights/internal/insight-store";\nexport const leak = generateInsight;\n',
      },
    ],
  },
  {
    name: "portable callers cannot bypass native Insights operations",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-insights-internal: src/shell/${PROBE_PREFIX}insights-private/probe.ts → cloudflare/insights/internal/insight-store.ts`,
      ],
    },
    files: [
      {
        path: `src/shell/${PROBE_PREFIX}insights-private/probe.ts`,
        source:
          'import { findInsightAttempt } from "../../../cloudflare/insights/internal/insight-store";\nexport const leak = findInsightAttempt;\n',
      },
    ],
  },
  {
    name: "Dashboard callers use validated owner operations",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}dashboard-public/probe.ts`,
        source:
          'import { browseDashboard, prepareDashboard } from "../dashboard/operations";\nexport const operations = [browseDashboard, prepareDashboard];\n',
      },
    ],
  },
  {
    name: "foreign tests cannot access Dashboard documents or projection mechanics",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-dashboard-internal: cloudflare/${PROBE_PREFIX}dashboard-private/probe.test.ts → cloudflare/dashboard/internal/dashboard-mutation.ts`,
        `error foreign-module-imports-cloudflare-dashboard-internal: cloudflare/${PROBE_PREFIX}dashboard-private/probe.test.ts → cloudflare/dashboard/internal/dashboard-view.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}dashboard-private/probe.test.ts`,
        source:
          'import { findDashboardDocument } from "../dashboard/internal/dashboard-mutation";\nimport { loadDashboardFacts } from "../dashboard/internal/dashboard-view";\nexport const leaks = [findDashboardDocument, loadDashboardFacts];\n',
      },
    ],
  },
  {
    name: "native Dashboard cannot reach portable presentation internals",
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-dashboard-internal: cloudflare/dashboard/${PROBE_PREFIX}portable-private/probe.ts → src/shell/dashboard/internal/presentation.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/dashboard/${PROBE_PREFIX}portable-private/probe.ts`,
        source:
          'import { renderDashboardView } from "../../../src/shell/dashboard/internal/presentation";\nexport const leak = renderDashboardView;\n',
      },
    ],
  },
  {
    name: "tooling cannot bypass the Dashboard storage owner",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-dashboard-internal: tools/${PROBE_PREFIX}dashboard-private/probe.ts → cloudflare/dashboard/internal/dashboard-mutation.ts`,
      ],
    },
    files: [
      {
        path: `tools/${PROBE_PREFIX}dashboard-private/probe.ts`,
        source:
          'import { findDashboardDocument } from "../../cloudflare/dashboard/internal/dashboard-mutation";\nexport const leak = findDashboardDocument;\n',
      },
    ],
  },
  {
    name: "Budget peers consume caps, spending and alerts through owner operations",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}budgets-public/probe.ts`,
        source:
          'import { readBudgetCaps, readBudgetSpending, evaluateBudgetAlerts } from "../budgets/operations";\nexport const reads = [readBudgetCaps, readBudgetSpending, evaluateBudgetAlerts];\n',
      },
    ],
  },
  {
    name: "foreign native tests cannot import Budget persistence or calculations",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-budgets-internal: cloudflare/${PROBE_PREFIX}budgets-private/probe.test.ts → cloudflare/budgets/internal/budget-queries.ts`,
        `error foreign-module-imports-cloudflare-budgets-internal: cloudflare/${PROBE_PREFIX}budgets-private/probe.test.ts → cloudflare/budgets/internal/budget-progress.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}budgets-private/probe.test.ts`,
        source:
          'import { currentBudgetReport } from "../budgets/internal/budget-queries";\nimport { findBudgetProgress } from "../budgets/internal/budget-progress";\nexport const privateReads = [currentBudgetReport, findBudgetProgress];\n',
      },
    ],
  },
  {
    name: "tooling cannot import Budget persistence types",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-budgets-internal: tools/${PROBE_PREFIX}budgets-private/probe.ts → cloudflare/budgets/internal/budget-progress.ts`,
      ],
    },
    files: [
      {
        path: `tools/${PROBE_PREFIX}budgets-private/probe.ts`,
        source:
          'import type { BudgetProgress } from "../../cloudflare/budgets/internal/budget-progress";\nexport type LeakedProgress = BudgetProgress;\n',
      },
    ],
  },
  {
    name: "portable callers cannot bypass the native Budget owner",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-budgets-internal: src/shell/${PROBE_PREFIX}budgets-private/probe.ts → cloudflare/budgets/internal/budget-latches.ts`,
      ],
    },
    files: [
      {
        path: `src/shell/${PROBE_PREFIX}budgets-private/probe.ts`,
        source:
          'import { reconcileBudgetLatches } from "../../../cloudflare/budgets/internal/budget-latches";\nexport const privateCalculation = reconcileBudgetLatches;\n',
      },
    ],
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-ingestion-internal: tools/${PROBE_PREFIX}ingestion-private/probe.ts → cloudflare/ingestion/internal/statement-staging.ts`,
      ],
    },
    files: [
      {
        path: `tools/${PROBE_PREFIX}ingestion-private/probe.ts`,
        source:
          'import { StatementStaging } from "../../cloudflare/ingestion/internal/statement-staging";\nexport const bypass = StatementStaging;\n',
      },
    ],
    name: "tooling cannot acquire Ingestion R2 or storage authority",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-ingestion-internal: cloudflare/ingestion/${PROBE_PREFIX}raw-material/probe.ts → src/shell/ingestion/internal/material.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/ingestion/${PROBE_PREFIX}raw-material/probe.ts`,
        source:
          'import { ReceivedEmailContent } from "~/shell/ingestion/internal/material";\nexport const bypass = ReceivedEmailContent;\n',
      },
    ],
    name: "native Ingestion cannot acquire portable raw material or parser internals",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}ingestion-published/probe.ts`,
        source:
          'import { prepareStatementSubmission, processForwardedEmail } from "../ingestion/operations";\nimport { StatementWork } from "../ingestion/contract";\nexport const published = [prepareStatementSubmission, processForwardedEmail, StatementWork];\n',
      },
    ],
    name: "callers compose published Ingestion admission and finalization",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}recovery-published/probe.ts`,
        source:
          'import { handleSupportRecovery, rotateBackupRecoveryCode } from "../recovery/operations";\n' +
          'import { redeemBrowserPairing, prepareRecoveryBrowserPairingApproval } from "../browser-login/operations";\n' +
          "export const published = [handleSupportRecovery, rotateBackupRecoveryCode, redeemBrowserPairing, prepareRecoveryBrowserPairingApproval];\n",
      },
    ],
    name: "callers consume bounded Browser Login and Recovery owner operations",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-recovery-internal: tools/${PROBE_PREFIX}recovery-material/probe.ts → cloudflare/recovery/internal/material.ts`,
      ],
    },
    files: [
      {
        path: `tools/${PROBE_PREFIX}recovery-material/probe.ts`,
        source:
          'import { recoveryCodeDigest } from "../../cloudflare/recovery/internal/material";\nexport const bypass = recoveryCodeDigest;\n',
      },
    ],
    name: "tooling cannot acquire private recovery material",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-login-recovery-internal: cloudflare/recovery/${PROBE_PREFIX}private-case/probe.ts → src/core/recovery/internal/model.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/recovery/${PROBE_PREFIX}private-case/probe.ts`,
        source:
          'import { BackupRecoveryCredential } from "~/core/recovery/internal/model";\nexport const bypass = BackupRecoveryCredential;\n',
      },
    ],
    name: "native callers cannot expose portable recovery credential or case internals",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-recovery-internal: cloudflare/${PROBE_PREFIX}recovery-private/probe.test.ts → cloudflare/recovery/internal/support-recovery.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}recovery-private/probe.test.ts`,
        source:
          'import { handleSupportRecovery } from "../recovery/internal/support-recovery";\nexport const bypass = handleSupportRecovery;\n',
      },
    ],
    name: "foreign tests cannot import private Support Recovery decisions",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${tokensPublished}/probe.ts`,
        source:
          'import { authorizeCanonicalPAT, handlePATRequest } from "../tokens/operations";\n' +
          'import { livePATAuthority, preparePATMetadata } from "~/shell/tokens/operations";\n' +
          'import { PATsGroup, PATPairingApi } from "~/shell/tokens/contract";\n' +
          "export const published = [authorizeCanonicalPAT, handlePATRequest, livePATAuthority, preparePATMetadata, PATsGroup, PATPairingApi];\n",
      },
    ],
    name: "Tokens callers use published pairing, safe metadata and commit-time authority operations",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-tokens-internal: ${tokensPrivate}/probe.test.ts → cloudflare/tokens/internal/pat-shared.ts`,
      ],
    },
    files: [
      {
        path: `${tokensPrivate}/probe.test.ts`,
        source:
          'import { PATRow, digest } from "../tokens/internal/pat-shared";\nexport const bypass = [PATRow, digest];\n',
      },
    ],
    name: "foreign tests cannot import private PAT rows or bearer verification",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-tokens-internal: ${tokensPortablePrivate}/probe.ts → src/shell/tokens/internal/list-pats.ts`,
      ],
    },
    files: [
      {
        path: `${tokensPortablePrivate}/probe.ts`,
        source:
          'import { patMetadataQuery } from "~/shell/tokens/internal/list-pats";\nexport const bypass = patMetadataQuery;\n',
      },
    ],
    name: "native Tokens consumes prepared metadata instead of private portable persistence",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-tokens-internal: ${tokensToolPrivate}/probe.ts → cloudflare/tokens/internal/pat-pairing.ts`,
      ],
    },
    files: [
      {
        path: `${tokensToolPrivate}/probe.ts`,
        source:
          'import type { PairingRow } from "../../cloudflare/tokens/internal/pat-pairing";\nexport type StoredPairing = PairingRow;\n',
      },
    ],
    name: "operational tools cannot import private PATPairing state even as a type",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}email-published/probe.ts`,
        source:
          'import { requestEmailReplacement, completeBrowserPairingEmail } from "../email-authentication/operations";\n' +
          'import { EmailAddress } from "~/core/email-authentication/contract";\n' +
          "export const published = [requestEmailReplacement, completeBrowserPairingEmail, EmailAddress];\n",
      },
    ],
    name: "Email Authentication callers consume published proof and replacement operations",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-email-authentication-internal: cloudflare/${PROBE_PREFIX}email-private/probe.test.ts → cloudflare/email-authentication/internal/email-replacement.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}email-private/probe.test.ts`,
        source:
          'import { requestEmailReplacement } from "../email-authentication/internal/email-replacement";\nexport const replacement = requestEmailReplacement;\n',
      },
    ],
    name: "foreign tests cannot acquire private Email Authentication proof implementation",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-email-authentication-internal: tools/${PROBE_PREFIX}email-private/probe.ts → cloudflare/email-authentication/internal/onboarding-workflow.ts`,
      ],
    },
    files: [
      {
        path: `tools/${PROBE_PREFIX}email-private/probe.ts`,
        source:
          'import { sendThroughResend } from "../../cloudflare/email-authentication/internal/onboarding-workflow";\nexport const provider = sendThroughResend;\n',
      },
    ],
    name: "tooling cannot acquire Email Authentication provider delivery authority",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-email-authentication-internal: cloudflare/email-authentication/${PROBE_PREFIX}portable-private/probe.ts → src/shell/email-authentication/internal/delivery.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/email-authentication/${PROBE_PREFIX}portable-private/probe.ts`,
        source:
          'import { makeEmailDelivery } from "~/shell/email-authentication/internal/delivery";\nexport const provider = makeEmailDelivery;\n',
      },
    ],
    name: "native Email Authentication cannot bypass portable provider ownership",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${subscriptionPublished}/probe.ts`,
        source:
          'import { handleCardEnrollment, executeProtectedSubscriptionQuery } from "../subscription/operations";\n' +
          'import { activePaidSubscriptionCondition } from "~/shell/subscription/operations";\n' +
          'import { SubscriptionEnrollmentApi } from "~/shell/subscription/contract";\n' +
          "export const published = [handleCardEnrollment, executeProtectedSubscriptionQuery, activePaidSubscriptionCondition, SubscriptionEnrollmentApi];\n",
      },
    ],
    name: "Subscription callers consume published enrollment, standing and paid-access operations",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-subscription-internal: ${subscriptionPrivate}/probe.test.ts → cloudflare/subscription/internal/billing-settlement.ts`,
      ],
    },
    files: [
      {
        path: `${subscriptionPrivate}/probe.test.ts`,
        source:
          'import { recordVerifiedBillingEvidence } from "../subscription/internal/billing-settlement";\nexport const settlement = recordVerifiedBillingEvidence;\n',
      },
    ],
    name: "foreign tests cannot acquire Subscription settlement authority",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-subscription-internal: ${subscriptionPortablePrivate}/probe.ts → src/shell/subscription/internal/query-sql.ts`,
      ],
    },
    files: [
      {
        path: `${subscriptionPortablePrivate}/probe.ts`,
        source:
          'import { subscriptionStandingQuery } from "~/shell/subscription/internal/query-sql";\nexport const rowQuery = subscriptionStandingQuery;\n',
      },
    ],
    name: "native Subscription cannot bypass portable query ownership",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-subscription-internal: ${subscriptionToolPrivate}/probe.ts → cloudflare/subscription/internal/wompi-model.ts`,
      ],
    },
    files: [
      {
        path: `${subscriptionToolPrivate}/probe.ts`,
        source:
          'import type { WompiTransactionId } from "../../cloudflare/subscription/internal/wompi-model";\nexport type ProviderId = WompiTransactionId;\n',
      },
    ],
    name: "tooling cannot import private Wompi identities even as types",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error published-interface-reexports-internal: ${subscriptionLaundering}/operations.ts → ./internal/provider`,
      ],
    },
    files: [
      {
        path: `${subscriptionLaundering}/internal/provider.ts`,
        source: 'export const providerSecret = "probe";\n',
      },
      {
        path: `${subscriptionLaundering}/operations.ts`,
        source:
          'import { providerSecret } from "./internal/provider";\nconst alias = providerSecret;\nexport { alias };\n',
      },
    ],
    name: "native Published Trio cannot launder internal bindings through an alias",
  },
  {
    name: "native Transaction peers consume capture and bounded reads through owner operations",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}transactions-public/probe.ts`,
        source:
          'import { prepareCapture, readBudgetContributions, readDashboardTransactions } from "../transactions/operations";\nexport const owners = [prepareCapture, readBudgetContributions, readDashboardTransactions];\n',
      },
    ],
  },
  {
    name: "foreign native tests cannot import Transaction persistence or effective SQL",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-transactions-internal: cloudflare/${PROBE_PREFIX}transactions-private/probe.test.ts → cloudflare/transactions/internal/transaction-history.ts`,
        `error foreign-module-imports-cloudflare-transactions-internal: cloudflare/${PROBE_PREFIX}transactions-private/probe.test.ts → cloudflare/transactions/internal/effective-transaction.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}transactions-private/probe.test.ts`,
        source:
          'import { findTransaction } from "../transactions/internal/transaction-history";\nimport { effectiveTransactionRelation } from "../transactions/internal/effective-transaction";\nexport const privateReads = [findTransaction, effectiveTransactionRelation];\n',
      },
    ],
  },
  {
    name: "tooling cannot import Transaction storage types",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-transactions-internal: scripts/${PROBE_PREFIX}transactions-private/probe.ts → cloudflare/transactions/internal/transaction-history.ts`,
      ],
    },
    files: [
      {
        path: `scripts/${PROBE_PREFIX}transactions-private/probe.ts`,
        source:
          'import type { StoredTransaction } from "../../cloudflare/transactions/internal/transaction-history";\nexport type LeakedRow = StoredTransaction;\n',
      },
    ],
  },
  {
    name: "native adapters cannot import portable Transaction internals",
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-transactions-internal: cloudflare/transactions/${PROBE_PREFIX}portable-private/probe.ts → src/shell/transactions/internal/continuation.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/transactions/${PROBE_PREFIX}portable-private/probe.ts`,
        source:
          'import { nextTransactionPage } from "../../../src/shell/transactions/internal/continuation";\nexport const privateContinuation = nextTransactionPage;\n',
      },
    ],
  },
  {
    name: "native Published Trio cannot launder internal behavior through alias chains",
    expect: { kind: "rejected", mustContain: ["error published-interface-reexports-internal:"] },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}native-alias/internal/private.ts`,
        source: "export const privateRead = (): boolean => true;\n",
      },
      {
        path: `cloudflare/${PROBE_PREFIX}native-alias/operations.ts`,
        source:
          'import { privateRead } from "./internal/private";\nconst alias = privateRead;\nexport const publishedRead = alias;\n',
      },
    ],
  },
  {
    name: "Category callers use the published owner operations",
    expect: { kind: "allowed" },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}categories-public/probe.ts`,
        source:
          'import { requireCategory, categorizeCaptures } from "../categories/operations";\nexport const reads = [requireCategory, categorizeCaptures];\n',
      },
    ],
  },
  {
    name: "foreign tests cannot read Category persistence",
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-categories-internal: cloudflare/${PROBE_PREFIX}categories-private/probe.test.ts → cloudflare/categories/internal/keyword-rule-shared.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/${PROBE_PREFIX}categories-private/probe.test.ts`,
        source:
          'import { findOwnedKeywordRules } from "../categories/internal/keyword-rule-shared";\nexport const privateRead = findOwnedKeywordRules;\n',
      },
    ],
  },
  {
    name: "native Category adapters cannot reach portable private policy",
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-categories-internal: cloudflare/categories/${PROBE_PREFIX}portable-private/probe.ts → src/core/categories/internal/rules.ts`,
      ],
    },
    files: [
      {
        path: `cloudflare/categories/${PROBE_PREFIX}portable-private/probe.ts`,
        source:
          'import { findKeywordCategory } from "../../../src/core/categories/internal/rules";\nexport const privatePolicy = findKeywordCategory;\n',
      },
    ],
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${cloudflareIdentityPublished}/probe.ts`,
        source:
          'import { findWhatsAppUser, prepareVerifiedIdentity } from "../identity/operations";\n' +
          'import { readUserContext } from "../identity/user-context/operations";\n' +
          'import { User, WhatsAppIdentity } from "@fidy/server/identity-contract";\n' +
          "export const published = [findWhatsAppUser, prepareVerifiedIdentity, readUserContext, User, WhatsAppIdentity];\n",
      },
    ],
    name: "Cloudflare consumers may use the published Identity contract and operations",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-identity-internal: ${cloudflareIdentityPrivate}/probe.test.ts → cloudflare/identity/internal/association.ts`,
      ],
    },
    files: [
      {
        path: `${cloudflareIdentityPrivate}/probe.test.ts`,
        source:
          'import { resolveCaller } from "../identity/internal/association";\nexport const privateResolver = resolveCaller;\n',
      },
    ],
    name: "foreign Cloudflare tests cannot bypass the private Identity adapter",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-identity-internal: ${cloudflareIdentityShellPrivate}/probe.ts → src/shell/identity/internal/user-query.ts`,
      ],
    },
    files: [
      {
        path: `${cloudflareIdentityShellPrivate}/probe.ts`,
        source:
          'import { findUser } from "~/shell/identity/internal/user-query";\nexport const privateUser = findUser;\n',
      },
    ],
    name: "the Cloudflare Identity owner cannot import portable Identity internals",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-identity-internal: ${cloudflareIdentityContextPrivate}/probe.ts → cloudflare/identity/user-context/internal/context.ts`,
      ],
    },
    files: [
      {
        path: `${cloudflareIdentityContextPrivate}/probe.ts`,
        source:
          'import { loadContext } from "../../cloudflare/identity/user-context/internal/context";\nexport const privateContext = loadContext;\n',
      },
    ],
    name: "tooling cannot import private Identity context projections",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${cloudflareSessionPublished}/probe.ts`,
        source:
          'import { authenticateWebSession, logoutWebSession } from "../web-session/operations";\n' +
          'import { freshSessionQuery } from "@fidy/server/web-session-operations";\n' +
          "export const published = [authenticateWebSession, logoutWebSession, freshSessionQuery];\n",
      },
    ],
    name: "Cloudflare callers use published WebSession authentication and commit-time guards",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-web-session-internal: ${cloudflareSessionPrivate}/probe.test.ts → cloudflare/web-session/internal/credentials.ts`,
      ],
    },
    files: [
      {
        path: `${cloudflareSessionPrivate}/probe.test.ts`,
        source:
          'import { sessionCookie } from "../web-session/internal/credentials";\nexport const privateCredential = sessionCookie;\n',
      },
    ],
    name: "foreign tests cannot reach WebSession credential handling",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-web-session-internal: ${cloudflareSessionShellPrivate}/probe.ts → src/shell/web-session/internal/authority.ts`,
      ],
    },
    files: [
      {
        path: `${cloudflareSessionShellPrivate}/probe.ts`,
        source:
          'import { sessionCredentialAuthority } from "~/shell/web-session/internal/authority";\nexport const privateAuthority = sessionCredentialAuthority;\n',
      },
    ],
    name: "Cloudflare WebSession must respect portable owner internals",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-browser-login-internal: ${cloudflarePairingPrivate}/probe.ts → cloudflare/browser-login/internal/pairing.ts`,
      ],
    },
    files: [
      {
        path: `${cloudflarePairingPrivate}/probe.ts`,
        source:
          'import { redeemBrowserPairing } from "../../cloudflare/browser-login/internal/pairing";\nexport const privateVerifier = redeemBrowserPairing;\n',
      },
    ],
    name: "tools cannot bypass the browser verifier owner",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${cloudflareConsentPublished}/probe.ts`,
        source:
          'import type { ConsentStatus } from "../consent/contract";\n' +
          'import { readConsentStatus } from "../consent/operations";\n' +
          'import { DisclosureSnapshot } from "@fidy/server/consent-contract";\n' +
          'import { protectConsentStatement } from "@fidy/server/consent-operations";\n\n' +
          "export type PublishedStatus = ConsentStatus;\n" +
          "export const published = [readConsentStatus, DisclosureSnapshot, protectConsentStatement];\n",
      },
    ],
    name: "Cloudflare consumers may use the published Consent contract and operations",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-cloudflare-consent-internal: ${cloudflareConsentPrivate}/probe.test.ts → cloudflare/consent/internal/standing.ts`,
      ],
    },
    files: [
      {
        path: `${cloudflareConsentPrivate}/probe.test.ts`,
        source:
          'import { loadStanding } from "../consent/internal/standing";\n\n' +
          "export const privateStanding = loadStanding;\n",
      },
    ],
    name: "foreign Cloudflare tests cannot bypass the private Consent adapter",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-consent-internal: ${cloudflareConsentShellPrivate}/probe.ts → src/shell/consent/internal/protected-actions.ts`,
      ],
    },
    files: [
      {
        path: `${cloudflareConsentShellPrivate}/probe.ts`,
        source:
          'import { consentConditions } from "~/shell/consent/internal/protected-actions";\n\n' +
          "export const privateConditions = consentConditions;\n",
      },
    ],
    name: "the Cloudflare Consent owner cannot import portable shell Consent internals",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cloudflare-imports-portable-consent-internal: ${cloudflareConsentCorePrivate}/probe.ts → src/core/consent/internal/replies.ts`,
      ],
    },
    files: [
      {
        path: `${cloudflareConsentCorePrivate}/probe.ts`,
        source:
          'import { normalizeReply } from "~/core/consent/internal/replies";\n\n' +
          "export const privateReplyPolicy = normalizeReply;\n",
      },
    ],
    name: "the Cloudflare Consent owner cannot import portable core Consent internals",
  },
  {
    expect: { kind: "allowed" },
    files: [
      { path: `${ownInternal}/internal/value.ts`, source: "export const value = true;\n" },
      {
        path: `${ownInternal}/operations.ts`,
        source: `import { value } from "~/${ownInternal.replace("src/", "")}/internal/value";\n\nexport const operation = (): boolean => value;\n`,
      },
    ],
    name: "a module may import its own visible internals",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-internal: ${foreignInternalSource}/operations.ts → ${foreignInternalTarget}/internal/value.ts`,
      ],
    },
    files: [
      {
        path: `${foreignInternalTarget}/internal/value.ts`,
        source: "export const value = true;\n",
      },
      {
        path: `${foreignInternalSource}/operations.ts`,
        source: `import { value } from "~/${foreignInternalTarget.replace("src/", "")}/internal/value";\n\nexport const operation = value;\n`,
      },
    ],
    name: "a module cannot import another module's visible internals",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-internal: ${nestedForeignInternalSource}/operations.ts → ${nestedForeignInternalTarget}/internal/value.ts`,
      ],
    },
    files: [
      {
        path: `${nestedForeignInternalTarget}/internal/value.ts`,
        source: "export const value = true;\n",
      },
      {
        path: `${nestedForeignInternalSource}/operations.ts`,
        source: `import { value } from "~/${nestedForeignInternalTarget.replace("src/", "")}/internal/value";\n\nexport const operation = (): boolean => value;\n`,
      },
    ],
    name: "nested modules cannot import another module's visible internals",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error operations-imports-runtime: ${nestedInterfaceDirection}/operations.ts → ${nestedInterfaceDirection}/runtime.ts`,
        `error published-interface-reexports-internal: ${nestedInterfaceDirection}/operations.ts → ${nestedInterfaceDirection}/internal/value.ts`,
      ],
    },
    files: [
      {
        path: `${nestedInterfaceDirection}/internal/value.ts`,
        source: "export const value = true;\n",
      },
      { path: `${nestedInterfaceDirection}/runtime.ts`, source: "export const runtime = true;\n" },
      {
        path: `${nestedInterfaceDirection}/operations.ts`,
        source:
          'import { runtime } from "./runtime";\n' +
          'export { value } from "./internal/value";\n\n' +
          "export const operation = (): boolean => runtime;\n",
      },
    ],
    name: "nested Published Trio interfaces keep direction and internal publication rules",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-internal: ${typeInternalSource}/operations.ts → ${typeInternalTarget}/internal/value.ts`,
      ],
    },
    files: [
      { path: `${typeInternalTarget}/internal/value.ts`, source: "export type Value = true;\n" },
      {
        path: `${typeInternalSource}/operations.ts`,
        source: `import type { Value } from "~/${typeInternalTarget.replace("src/", "")}/internal/value";\n\nexport type Operation = Value;\n`,
      },
    ],
    name: "type-only imports cannot cross into foreign internals",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${outboundHttpPublishedSource}/probe.ts`,
        source:
          'import { OutboundHttp } from "~/shell/outbound-http/operations";\n\n' +
          "export const outboundHttpPublishedProbe = OutboundHttp;\n",
      },
    ],
    name: "external provider modules may use published Outbound HTTP authority",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-internal: ${outboundHttpPrivateSource}/probe.ts → src/shell/outbound-http/internal/outbound-http.ts`,
      ],
    },
    files: [
      {
        path: `${outboundHttpPrivateSource}/probe.ts`,
        source:
          'import { makeOutboundHttp } from "~/shell/outbound-http/internal/outbound-http";\n\n' +
          "export const outboundHttpPrivateProbe = makeOutboundHttp;\n",
      },
    ],
    name: "external provider modules cannot import private Outbound HTTP transport",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error provider-callers-import-raw-http: ${providerRawHttpSource} → node_modules/effect/dist/unstable/http/index.js`,
      ],
    },
    files: [
      {
        path: providerRawHttpSource,
        source:
          'import { HttpClient } from "effect/unstable/http";\n\n' +
          "export const rawProviderClient = HttpClient;\n",
      },
    ],
    name: "external provider tests cannot import raw Effect HTTP clients",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error contract-imports-implementation: ${interfaceDirection}/contract.ts → ${interfaceDirection}/internal/value.ts`,
        `error contract-imports-implementation: ${interfaceDirection}/contract.ts → ${interfaceDirection}/operations.ts`,
        `error contract-imports-implementation: ${interfaceDirection}/contract.ts → ${interfaceDirection}/runtime.ts`,
      ],
    },
    files: [
      { path: `${interfaceDirection}/internal/value.ts`, source: "export const value = true;\n" },
      { path: `${interfaceDirection}/operations.ts`, source: "export const operation = true;\n" },
      { path: `${interfaceDirection}/runtime.ts`, source: "export const runtime = true;\n" },
      {
        path: `${interfaceDirection}/contract.ts`,
        source:
          'import { value } from "./internal/value";\n' +
          'import { operation } from "./operations";\n' +
          'import { runtime } from "./runtime";\n\n' +
          "export const contract = [value, operation, runtime];\n",
      },
    ],
    name: "contract.ts cannot depend on implementation or outward interfaces",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error internal-imports-outward-interface: ${internalDirection}/internal/value.ts → ${internalDirection}/operations.ts`,
        `error internal-imports-outward-interface: ${internalDirection}/internal/value.ts → ${internalDirection}/runtime.ts`,
      ],
    },
    files: [
      { path: `${internalDirection}/operations.ts`, source: "export const operation = true;\n" },
      { path: `${internalDirection}/runtime.ts`, source: "export const runtime = true;\n" },
      {
        path: `${internalDirection}/internal/value.ts`,
        source:
          'import { operation } from "../operations";\n' +
          'import { runtime } from "../runtime";\n\n' +
          "export const value = [operation, runtime];\n",
      },
    ],
    name: "internal implementation cannot depend backward on operations or runtime",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error operations-imports-runtime: ${operationsDirection}/operations.ts → ${operationsDirection}/runtime.ts`,
      ],
    },
    files: [
      { path: `${operationsDirection}/runtime.ts`, source: "export const runtime = true;\n" },
      {
        path: `${operationsDirection}/operations.ts`,
        source: 'import { runtime } from "./runtime";\n\nexport const operation = runtime;\n',
      },
    ],
    name: "operations.ts cannot depend backward on runtime.ts",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error published-interface-reexports-internal: ${reexportInternal}/operations.ts → ./internal/value`,
        `error published-interface-reexports-internal: ${reexportInternal}/runtime.ts → ${reexportInternal}/internal/value.ts`,
      ],
    },
    files: [
      { path: `${reexportInternal}/internal/value.ts`, source: "export const value = true;\n" },
      {
        path: `${reexportInternal}/operations.ts`,
        source:
          'import { value } from "./internal/value";\n\n' + "export const leakedValue = value;\n",
      },
      {
        path: `${reexportInternal}/runtime.ts`,
        source: 'export { value } from "./internal/value";\n',
      },
    ],
    name: "published interfaces cannot launder imported internals through aliases or re-exports",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error published-interface-reexports-internal: ${reexportInternalAlias}/operations.ts → ./internal/value`,
      ],
    },
    files: [
      {
        path: `${reexportInternalAlias}/internal/value.ts`,
        source: "export const value = true;\n",
      },
      {
        path: `${reexportInternalAlias}/operations.ts`,
        source:
          'import { value } from "./internal/value";\n\n' +
          "const leakedValue = value;\n" +
          "export { leakedValue };\n",
      },
    ],
    name: "published interfaces cannot launder internals through local alias chains",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error published-interface-reexports-internal: ${reexportInternalType}/operations.ts → ./internal/value`,
      ],
    },
    files: [
      {
        path: `${reexportInternalType}/internal/value.ts`,
        source: "export interface Value { readonly value: true }\n",
      },
      {
        path: `${reexportInternalType}/operations.ts`,
        source:
          'import type { Value } from "./internal/value";\n\n' +
          "export type PublishedValue = Value;\n" +
          "export interface PublishedRecord extends Value {}\n",
      },
    ],
    name: "published interfaces cannot launder internal types through aliases or inheritance",
  },
  {
    expect: { kind: "allowed" },
    files: [
      { path: `${publishedTarget}/contract.ts`, source: "export const contract = true;\n" },
      { path: `${publishedTarget}/operations.ts`, source: "export const operation = true;\n" },
      {
        path: `${publishedSource}/operations.ts`,
        source:
          `import { contract } from "~/${publishedTarget.replace("src/", "")}/contract";\n` +
          `import { operation } from "~/${publishedTarget.replace("src/", "")}/operations";\n\n` +
          "export const published = [contract, operation];\n",
      },
    ],
    name: "foreign contract.ts and operations.ts are published interfaces",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-runtime-imported-outside-composition: ${runtimeSource}/operations.ts → ${runtimeTarget}/runtime.ts`,
      ],
    },
    files: [
      { path: `${runtimeTarget}/runtime.ts`, source: "export const runtime = true;\n" },
      {
        path: `${runtimeSource}/operations.ts`,
        source: `import { runtime } from "~/${runtimeTarget.replace("src/", "")}/runtime";\n\nexport const operation = runtime;\n`,
      },
    ],
    name: "ordinary modules cannot import a foreign runtime.ts",
  },
  {
    expect: { kind: "allowed" },
    files: [
      { path: `${runtimeTarget}/runtime.ts`, source: "export const runtime = true;\n" },
      {
        path: `${runtimeComposer}/runtime.ts`,
        source: `import { runtime } from "~/${runtimeTarget.replace("src/", "")}/runtime";\n\nexport const composed = runtime;\n`,
      },
    ],
    name: "runtime.ts may compose another module's runtime.ts",
  },
  {
    expect: { kind: "allowed" },
    files: [
      { path: `${localTestInternal}/internal/value.ts`, source: "export const value = true;\n" },
      {
        path: `${localTestInternal}/value.test.ts`,
        source: `import { value } from "~/${localTestInternal.replace("src/", "")}/internal/value";\n\nexport const tested = value;\n`,
      },
    ],
    name: "an owner-local test may import its own internals",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error foreign-module-imports-internal: ${foreignTestSource}/value.test.ts → ${foreignTestTarget}/internal/value.ts`,
      ],
    },
    files: [
      { path: `${foreignTestTarget}/internal/value.ts`, source: "export const value = true;\n" },
      {
        path: `${foreignTestSource}/value.test.ts`,
        source: `import { value } from "~/${foreignTestTarget.replace("src/", "")}/internal/value";\n\nexport const tested = value;\n`,
      },
    ],
    name: "a foreign test receives no exemption from visible-internal privacy",
  },
  {
    expect: { kind: "allowed" },
    files: [
      { path: `${publishedTarget}/operations.ts`, source: "export const operation = true;\n" },
      {
        path: `${scriptPublication}/probe.ts`,
        source: `import { operation } from "~/${publishedTarget.replace("src/", "")}/operations";\n\nexport const script = operation;\n`,
      },
    ],
    name: "scripts may use published operations",
  },
  {
    expect: { kind: "allowed" },
    files: [
      { path: `${runtimeTarget}/runtime.ts`, source: "export const runtime = true;\n" },
      {
        path: `${scriptRuntime}/probe-runtime.ts`,
        source: `import { runtime } from "~/${runtimeTarget.replace("src/", "")}/runtime";\n\nexport const script = runtime;\n`,
      },
    ],
    name: "a script may compose a published runtime",
  },
  {
    expect: { kind: "allowed" },
    files: [
      { path: `${toolRuntimeTarget}/runtime.ts`, source: "export const runtime = true;\n" },
      {
        path: `${toolRuntimeAllowed}/probe-runtime.ts`,
        source: `import { runtime } from "~/${toolRuntimeTarget.replace("src/", "")}/runtime";\n\nexport const tool = runtime;\n`,
      },
    ],
    name: "an explicitly named tool runtime may compose published runtime authority",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error tooling-imports-runtime-without-composition-role: ${toolRuntime}/probe.ts → ${toolRuntimeTarget}/runtime.ts`,
      ],
    },
    files: [
      { path: `${toolRuntimeTarget}/runtime.ts`, source: "export const runtime = true;\n" },
      {
        path: `${toolRuntime}/probe.ts`,
        source: `import { runtime } from "~/${toolRuntimeTarget.replace("src/", "")}/runtime";\n\nexport const tool = runtime;\n`,
      },
    ],
    name: "a tool without an explicit composition role cannot import runtime authority",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error landmark-imports-internal: ${landmarkInternal}/probe.ts → ${landmarkInternalTarget}/internal/value.ts`,
      ],
    },
    files: [
      {
        path: `${landmarkInternalTarget}/internal/value.ts`,
        source: "export const value = true;\n",
      },
      {
        path: `${landmarkInternal}/probe.ts`,
        source: `import { value } from "~/${landmarkInternalTarget.replace("src/", "")}/internal/value";\n\nexport const landmark = value;\n`,
      },
    ],
    name: "source landmarks cannot bypass visible-internal privacy",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error tooling-imports-internal: ${toolInternal}/probe.ts → ${toolInternalTarget}/internal/value.ts`,
      ],
    },
    files: [
      { path: `${toolInternalTarget}/internal/value.ts`, source: "export const value = true;\n" },
      {
        path: `${toolInternal}/probe.ts`,
        source: `import { value } from "~/${toolInternalTarget.replace("src/", "")}/internal/value";\n\nexport const tool = value;\n`,
      },
    ],
    name: "tools cannot bypass visible-internal privacy",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${SIBLING_REFERENCE}/probe.ts`,
        source:
          'import { UserId } from "~/core/identity/reference";\n' +
          'import { TokenId } from "~/core/tokens/reference";\n\n' +
          "export const siblingReferenceProbe = [UserId, TokenId];\n",
      },
    ],
    name: "a core slice may import a sibling's published reference.ts",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error core-slice-reaches-sibling-slice: ${SIBLING_IMPLEMENTATION}/probe.ts → src/core/categories/internal/rules.ts`,
        `error core-slice-reaches-sibling-slice: ${SIBLING_IMPLEMENTATION}/probe.ts → src/core/categories/internal/taxonomy.ts`,
      ],
    },
    files: [
      {
        path: `${SIBLING_IMPLEMENTATION}/probe.ts`,
        source:
          'import { findKnownCaptureCategory } from "~/core/categories/internal/rules";\n' +
          'import { categoryRows } from "~/core/categories/internal/taxonomy";\n\n' +
          "export const siblingImplementationProbe = [\n" +
          "  findKnownCaptureCategory,\n  categoryRows,\n];\n",
      },
    ],
    name: "core-slice-reaches-sibling-slice rejects a sibling's implementation",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error core-slice-reaches-sibling-slice: ${TYPE_ONLY}/probe.ts → src/core/categories/internal/taxonomy.ts`,
      ],
    },
    files: [
      {
        path: `${TYPE_ONLY}/probe.ts`,
        source:
          'import type { categoryRows } from "~/core/categories/internal/taxonomy";\n\n' +
          "export type TypeOnlyProbe = typeof categoryRows;\n",
      },
    ],
    name: "an `import type` is an edge the graph can see (tsPreCompilationDeps)",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error core-imports-shell: ${CORE_TO_SHELL}/probe.ts → src/shell/public-http/contract.ts`,
      ],
    },
    files: [
      {
        path: `${CORE_TO_SHELL}/probe.ts`,
        source:
          'import { UserId } from "~/core/identity/reference";\n' +
          'import "~/shell/public-http/contract";\n\n' +
          "export const coreImportsShellProbe = UserId;\n",
      },
    ],
    name: "core-imports-shell rejects a core module reaching into shell",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [`error core-imports-the-world: ${CORE_TO_WORLD}/probe.ts → fs`],
    },
    files: [
      {
        path: `${CORE_TO_WORLD}/probe.ts`,
        source:
          'import { readFileSync } from "node:fs";\n\n' +
          "export const coreImportsTheWorldProbe = readFileSync;\n",
      },
    ],
    name: "core-imports-the-world rejects a core module importing an I/O builtin",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${CLIENT_SEAM_ALLOWED}/probe.ts`,
        source: 'import { FidyApi } from "~/client";\n\nexport const clientSeamProbe = FidyApi;\n',
      },
    ],
    name: "browser-facing code may import the package-level client facade",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error browser-client-seam-bypass: ${CLIENT_SEAM_BYPASS}/probe.ts → src/shell/api.ts`,
      ],
    },
    files: [
      {
        path: `${CLIENT_SEAM_BYPASS}/probe.ts`,
        source:
          'import { FidyApi } from "~/shell/api";\n\nexport const clientSeamBypassProbe = FidyApi;\n',
      },
    ],
    name: "browser-facing code cannot bypass the package-level client facade",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: ["error cycle:", `${CYCLE}/a.ts`, `${CYCLE}/b.ts`],
    },
    files: [
      {
        path: `${CYCLE}/a.ts`,
        source:
          'import type { ProbeB } from "./b";\n\nexport type ProbeA = { readonly b: ProbeB };\n',
      },
      {
        path: `${CYCLE}/b.ts`,
        source:
          'import type { ProbeA } from "./a";\n\nexport type ProbeB = { readonly a: ProbeA };\n',
      },
    ],
    name: "cycle rejects a type-only circular import",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [`error barrel-file: ${BARREL}/probe.ts → ${BARREL}/index.ts`],
    },
    files: [
      { path: `${BARREL}/index.ts`, source: "export const barrelProbe = true;\n" },
      {
        path: `${BARREL}/probe.ts`,
        source:
          'import { barrelProbe } from "./index";\n\nexport const barrelUser = barrelProbe;\n',
      },
    ],
    name: "barrel-file rejects importing an index module",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error same-directory-import-is-aliased: ${ALIAS_SAME_DIRECTORY}/probe.ts → ${ALIAS_SAME_DIRECTORY}/neighbour.ts`,
      ],
    },
    files: [
      { path: `${ALIAS_SAME_DIRECTORY}/neighbour.ts`, source: "export const neighbour = true;\n" },
      {
        path: `${ALIAS_SAME_DIRECTORY}/probe.ts`,
        source:
          `import { neighbour } from "~/${ALIAS_SAME_DIRECTORY.replace("src/", "")}/neighbour";\n\n` +
          "export const aliasSameDirectoryProbe = neighbour;\n",
      },
    ],
    name: "same-directory-import-is-aliased rejects `~/` within one directory",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error cross-directory-import-is-relative: ${RELATIVE_CROSS_DIRECTORY}/probe.ts → src/core/identity/reference.ts`,
      ],
    },
    files: [
      {
        path: `${RELATIVE_CROSS_DIRECTORY}/probe.ts`,
        source:
          'import { UserId } from "../../identity/reference";\n\n' +
          "export const relativeCrossDirectoryProbe = UserId;\n",
      },
    ],
    name: "cross-directory-import-is-relative rejects `../` across directories",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error hosted-inference-orchestration-imports-provider: ${HOSTED_TOKENIZER}/probe.ts`,
      ],
    },
    files: [
      {
        path: `${HOSTED_TOKENIZER}/probe.ts`,
        source:
          'import { Tokenizer } from "effect/unstable/ai";\n\n' +
          "export const hostedTokenizerProbe = Tokenizer;\n",
      },
    ],
    name: "hosted inference orchestration rejects tokenizer imports",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error hosted-inference-orchestration-imports-provider: ${HOSTED_MODEL}/probe.ts`,
      ],
    },
    files: [
      {
        path: `${HOSTED_MODEL}/probe.ts`,
        source:
          'import { LanguageModel } from "effect/unstable/ai";\n\n' +
          "export const hostedModelProbe = LanguageModel;\n",
      },
    ],
    name: "hosted inference orchestration rejects generic model imports",
  },
];

const missingFrom = (report: string, expected: readonly string[]): readonly string[] =>
  expected.filter((entry) => !report.includes(entry));

const assertProbeBatch = (probes: readonly Probe[], expectation: Expectation["kind"]): void => {
  const { exitCode, report } = runGraph();
  const names = probes.map(({ name }) => name).join(" | ");

  if (expectation === "allowed") {
    if (!Option.contains(exitCode, 0)) {
      throw new Error(`${names}\nThe gate rejected an allowed probe batch.\n${report}`);
    }
    return;
  }

  if (Option.contains(exitCode, 0)) {
    throw new Error(
      `${names}\nThe gate PASSED on a graph containing rejected probes — a rule did not fire, ` +
        `or the cruiser never resolved the probe imports.\n${report}`
    );
  }
  for (const probe of probes) {
    if (probe.expect.kind !== "rejected") continue;
    const missing = missingFrom(report, probe.expect.mustContain);
    if (missing.length > 0) {
      throw new Error(
        `${probe.name}\nThe batch failed, but not for the reason this probe exists.\n` +
          `Absent from the report: ${missing.join(" | ")}\n${report}`
      );
    }
  }
};

const probeRoot = ({ path }: ProbeFile): string => {
  const marker = path.indexOf("/__probe-");
  const end = path.indexOf("/", marker + 1);
  if (marker < 0 || end < 0) {
    throw new Error(`Probe file is not under a generated directory: ${path}`);
  }
  return path.slice(0, end);
};

const remove = (path: string): void => {
  const result = Bun.spawnSync(["rm", "-rf", path], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(decode(result.stderr));
  }
};

const stale = ["src", "scripts", "tools", "cloudflare"].flatMap((root) =>
  Array.from(
    new Bun.Glob("**/__probe-*").scanSync({ cwd: `${serverRoot}/${root}`, onlyFiles: false })
  ).map((entry) => `${root}/${entry}`)
);
for (const entry of stale.sort((left, right) => right.length - left.length)) {
  remove(`${serverRoot}/${entry}`);
}
if (stale.length > 0) {
  process.stderr.write(`swept ${stale.length} probe directory(ies) from an interrupted run\n`);
}

const writeProbeBatch = (probes: readonly Probe[]): Promise<void> =>
  Promise.all(
    probes.flatMap((probe) =>
      probe.files.map((file) => Bun.write(`${serverRoot}${file.path}`, file.source))
    )
  ).then(() => undefined);

const assertEmptyGraphFailsClosed = (): void => {
  const { exitCode, report } = runGraph([emptyGraph]);
  if (Option.contains(exitCode, 0) || !report.includes("dependency-cruiser cruised 0 modules")) {
    throw new Error(`The graph did not fail closed when no modules resolved.\n${report}`);
  }
};

try {
  await Bun.write(`${serverRoot}/${emptyGraph}/.keep`, "");
  assertEmptyGraphFailsClosed();
  process.stdout.write("ok  a graph that resolves no modules fails closed\n");
} finally {
  remove(`${serverRoot}/${emptyGraph}`);
}

for (const expectation of ["allowed", "rejected"] as const) {
  const probes = PROBES.filter((probe) => probe.expect.kind === expectation);
  try {
    await writeProbeBatch(probes);
    assertProbeBatch(probes, expectation);
  } finally {
    const cleanupPaths = new Set(probes.flatMap(({ files }) => files.map(probeRoot)));
    for (const path of cleanupPaths) remove(`${serverRoot}/${path}`);
  }
  for (const probe of probes) process.stdout.write(`ok  ${probe.name}\n`);
}

process.stdout.write(
  `\nall ${PROBES.length} dependency guard probes passed in 2 graph traversals\n`
);
