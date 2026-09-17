#!/usr/bin/env bun

import { Option } from "effect";

const serverRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
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
  sourceRoots: readonly string[] = ["src", "scripts", "tools"]
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
const ENTRYPOINT = dir("entrypoint");
const CLIENT_SEAM_ALLOWED = sourceDir("client-seam-allowed");
const CLIENT_SEAM_BYPASS = sourceDir("client-seam-bypass");
const SENTRY_OUTSIDE_OBSERVABILITY = dir("sentry-outside-observability");
const CYCLE = dir("cycle");
const BARREL = dir("barrel");
const ALIAS_SAME_DIRECTORY = dir("alias-same-directory");
const RELATIVE_CROSS_DIRECTORY = dir("relative-cross-directory");
const HOSTED_PROVIDER = `src/shell/agent/${PROBE_PREFIX}hosted-provider`;
const HOSTED_MODEL = `src/shell/agent/${PROBE_PREFIX}hosted-model`;
const HOSTED_TOKENIZER = `src/shell/agent/${PROBE_PREFIX}hosted-tokenizer`;
const HOSTED_JS_TOKENIZER = `src/shell/agent/${PROBE_PREFIX}hosted-js-tokenizer`;
const ADAPTER_TO_HANDLER = `src/shell/${PROBE_PREFIX}adapter-to-handler`;
const REGISTRY_TO_HANDLER = `src/shell/_shared/${PROBE_PREFIX}registry-to-handler`;
const ADAPTER_TO_COORDINATION = `src/shell/${PROBE_PREFIX}adapter-to-coordination`;
const REGISTRY_TO_COORDINATION = `src/shell/_shared/${PROBE_PREFIX}registry-to-coordination`;
const ADAPTER_TO_REPO = `src/shell/${PROBE_PREFIX}adapter-to-repo`;
const ADAPTER_TO_QUERIES = `src/shell/${PROBE_PREFIX}adapter-to-queries`;
const CONTINUITY_OUTSIDE = `src/shell/audit/${PROBE_PREFIX}continuity-outside-runtime`;
const CONTINUITY_SIBLING = `src/shell/agent/${PROBE_PREFIX}continuity-runtime-sibling`;
const CONTINUITY_TYPE_ONLY = `src/shell/agent/${PROBE_PREFIX}continuity-type-only`;
const CONTINUITY_OUTSIDE_TEST = `src/shell/audit/${PROBE_PREFIX}continuity-outside-test`;
const CONTINUITY_RUNTIME_TEST = `src/shell/agent/${PROBE_PREFIX}continuity-runtime-test`;

const ownInternal = `src/core/${PROBE_PREFIX}own-internal`;
const foreignInternalSource = `src/core/${PROBE_PREFIX}foreign-internal-source`;
const foreignInternalTarget = `src/core/${PROBE_PREFIX}foreign-internal-target`;
const typeInternalSource = `src/shell/${PROBE_PREFIX}type-internal-source`;
const typeInternalTarget = `src/shell/${PROBE_PREFIX}type-internal-target`;
const interfaceDirection = `src/core/${PROBE_PREFIX}interface-direction`;
const internalDirection = `src/core/${PROBE_PREFIX}internal-direction`;
const operationsDirection = `src/core/${PROBE_PREFIX}operations-direction`;
const reexportInternal = `src/core/${PROBE_PREFIX}reexport-internal`;
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

const PROBES: readonly Probe[] = [
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
        `error core-slice-reaches-sibling-slice: ${SIBLING_IMPLEMENTATION}/probe.ts → src/core/categories/model.ts`,
        `error core-slice-reaches-sibling-slice: ${SIBLING_IMPLEMENTATION}/probe.ts → src/core/categories/rules.ts`,
        `error core-slice-reaches-sibling-slice: ${SIBLING_IMPLEMENTATION}/probe.ts → src/core/categories/errors.ts`,
        `error core-slice-reaches-sibling-slice: ${SIBLING_IMPLEMENTATION}/probe.ts → src/core/categories/taxonomy.ts`,
      ],
    },
    files: [
      {
        path: `${SIBLING_IMPLEMENTATION}/probe.ts`,
        source:
          'import { Category } from "~/core/categories/model";\n' +
          'import { CategoryNotFound } from "~/core/categories/errors";\n' +
          'import { findKnownCaptureCategory } from "~/core/categories/rules";\n' +
          'import { categoryIds } from "~/core/categories/taxonomy";\n\n' +
          "export const siblingImplementationProbe = [\n" +
          "  Category,\n  CategoryNotFound,\n  findKnownCaptureCategory,\n  categoryIds,\n];\n",
      },
    ],
    name: "core-slice-reaches-sibling-slice rejects a sibling's implementation",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error core-slice-reaches-sibling-slice: ${TYPE_ONLY}/probe.ts → src/core/categories/model.ts`,
      ],
    },
    files: [
      {
        path: `${TYPE_ONLY}/probe.ts`,
        source:
          'import type { Category } from "~/core/categories/model";\n\n' +
          "export type TypeOnlyProbe = Category;\n",
      },
    ],
    name: "an `import type` is an edge the graph can see (tsPreCompilationDeps)",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error core-imports-shell: ${CORE_TO_SHELL}/probe.ts → src/shell/_shared/errors.ts`,
      ],
    },
    files: [
      {
        path: `${CORE_TO_SHELL}/probe.ts`,
        source:
          'import { UserId } from "~/core/identity/reference";\n' +
          'import "~/shell/_shared/errors";\n\n' +
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
    expect: {
      kind: "rejected",
      mustContain: [`error entrypoint-is-imported: ${ENTRYPOINT}/probe.ts → src/main.ts`],
    },
    files: [
      {
        path: `${ENTRYPOINT}/probe.ts`,
        source: 'import "~/main";\n\nexport const entrypointProbe = true;\n',
      },
    ],
    name: "entrypoint-is-imported rejects importing src/main.ts",
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
      mustContain: [
        `error continuity-reached-outside-hosted-runtime: ${CONTINUITY_OUTSIDE}/probe.ts → src/shell/transcript/conversation-continuity.ts`,
      ],
    },
    files: [
      {
        path: `${CONTINUITY_OUTSIDE}/probe.ts`,
        source:
          'import { ConversationContinuity } from "~/shell/transcript/conversation-continuity";\n\n' +
          "export const continuityOutsideProbe = ConversationContinuity;\n",
      },
    ],
    name: "continuity is unreachable from outside the hosted agent runtime",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error continuity-reached-outside-hosted-runtime: ${CONTINUITY_SIBLING}/probe.ts \u2192 src/shell/transcript/conversation-continuity.ts`,
      ],
    },
    files: [
      {
        path: `${CONTINUITY_SIBLING}/probe.ts`,
        source:
          'import { ConversationContinuity } from "~/shell/transcript/conversation-continuity";\n\n' +
          "export const continuitySiblingProbe = ConversationContinuity;\n",
      },
    ],
    name: "continuity is unreachable even from a sibling of the hosted agent runtime",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${CONTINUITY_TYPE_ONLY}/probe.ts`,
        source:
          "import type { ConversationContinuityService } " +
          'from "~/shell/transcript/conversation-continuity";\n\n' +
          "export type ContinuityTypeOnlyProbe = ConversationContinuityService;\n",
      },
    ],
    name: "a type carries no capability, so a type-only continuity import stays legal",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error continuity-reached-outside-hosted-runtime: ${CONTINUITY_OUTSIDE_TEST}/probe.test.ts → src/shell/transcript/conversation-continuity.ts`,
      ],
    },
    files: [
      {
        path: `${CONTINUITY_OUTSIDE_TEST}/probe.test.ts`,
        source:
          'import { ConversationContinuity } from "~/shell/transcript/conversation-continuity";\n\n' +
          "export const continuityOutsideTestProbe = ConversationContinuity;\n",
      },
    ],
    name: "a test outside the hosted agent runtime buys no continuity exemption",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${CONTINUITY_RUNTIME_TEST}/probe.test.ts`,
        source:
          'import { ConversationContinuity } from "~/shell/transcript/conversation-continuity";\n\n' +
          "export const continuityRuntimeTestProbe = ConversationContinuity;\n",
      },
    ],
    name: "a test inside the hosted agent runtime may build continuity directly",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error adapter-imports-handler-adapter: ${ADAPTER_TO_HANDLER}/handlers.ts \u2192 src/shell/budgets/handlers.ts`,
      ],
    },
    files: [
      {
        path: `${ADAPTER_TO_HANDLER}/handlers.ts`,
        source:
          'import { BudgetsLive } from "~/shell/budgets/handlers";\n\n' +
          "export const adapterToHandlerProbe = BudgetsLive;\n",
      },
    ],
    name: "an HTTP handler cannot import another HTTP handler adapter",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error adapter-imports-handler-adapter: ${REGISTRY_TO_HANDLER}/canonical-operation-registry.ts \u2192 src/shell/budgets/handlers.ts`,
      ],
    },
    files: [
      {
        path: `${REGISTRY_TO_HANDLER}/canonical-operation-registry.ts`,
        source:
          'import { BudgetsLive } from "~/shell/budgets/handlers";\n\n' +
          "export const registryToHandlerProbe = BudgetsLive;\n",
      },
    ],
    name: "a canonical registry cannot import an HTTP handler adapter",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${ADAPTER_TO_COORDINATION}/handlers.ts`,
        source:
          'import { executeAtomicBatch } from "~/shell/operations/atomic-batch";\n\n' +
          "export const adapterToCoordinationProbe = executeAtomicBatch;\n",
      },
    ],
    name: "an HTTP handler may delegate to the atomic batch coordination module",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${REGISTRY_TO_COORDINATION}/canonical-operation-registry.ts`,
        source:
          'import { executeAtomicBatch } from "~/shell/operations/atomic-batch";\n\n' +
          "export const registryToCoordinationProbe = executeAtomicBatch;\n",
      },
    ],
    name: "a canonical registry may delegate to the atomic batch coordination module",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error adapter-reaches-slice-persistence: ${ADAPTER_TO_REPO}/handlers.ts \u2192 src/shell/budgets/repo.ts`,
      ],
    },
    files: [
      {
        path: `${ADAPTER_TO_REPO}/handlers.ts`,
        source:
          'import { selectBudgets } from "~/shell/budgets/repo";\n\n' +
          "export const adapterToRepoProbe = selectBudgets;\n",
      },
    ],
    name: "an adapter cannot reach a slice repo around its one operation implementation",
  },
  {
    expect: { kind: "allowed" },
    files: [
      {
        path: `${ADAPTER_TO_QUERIES}/handlers.ts`,
        source:
          'import { probeQuery } from "./queries";\n\n' +
          "export const adapterToQueriesProbe = probeQuery;\n",
      },
      {
        path: `${ADAPTER_TO_QUERIES}/queries.ts`,
        source:
          'import { selectBudgets } from "~/shell/budgets/repo";\n\n' +
          "export const probeQuery = selectBudgets;\n",
      },
    ],
    name: "an adapter delegating to its slice queries module is how persistence is reached",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error sentry-imported-outside-observability: ${SENTRY_OUTSIDE_OBSERVABILITY}/probe.ts → node_modules/@sentry/bun/build/types/index.d.ts`,
      ],
    },
    files: [
      {
        path: `${SENTRY_OUTSIDE_OBSERVABILITY}/probe.ts`,
        source:
          'import { captureEvent } from "@sentry/bun";\n\n' +
          "export const sentryOutsideObservabilityProbe = captureEvent;\n",
      },
    ],
    name: "sentry-imported-outside-observability rejects direct SDK access",
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
        `error hosted-inference-orchestration-imports-provider: ${HOSTED_JS_TOKENIZER}/probe.ts`,
      ],
    },
    files: [
      {
        path: `${HOSTED_JS_TOKENIZER}/probe.ts`,
        source:
          'import { encodingForModel } from "js-tiktoken";\n\n' +
          "export const hostedJsTokenizerProbe = encodingForModel;\n",
      },
    ],
    name: "hosted inference orchestration rejects js-tiktoken imports",
  },
  {
    expect: {
      kind: "rejected",
      mustContain: [
        `error hosted-inference-orchestration-imports-provider: ${HOSTED_PROVIDER}/probe.ts → src/shell/agent/openai.ts`,
      ],
    },
    files: [
      {
        path: `${HOSTED_PROVIDER}/probe.ts`,
        source:
          'import { FidyAgentModel } from "../openai";\n\n' +
          "export const hostedProviderProbe = FidyAgentModel;\n",
      },
    ],
    name: "hosted inference orchestration rejects provider-specific imports",
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

const stale = ["src", "scripts", "tools"].flatMap((root) =>
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
