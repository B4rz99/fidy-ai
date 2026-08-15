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
  readonly directory: string;
  readonly expect: Expectation;
  readonly files: readonly ProbeFile[];
  readonly name: string;
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const runGraph = (): { readonly exitCode: Option.Option<number>; readonly report: string } => {
  const spawned = Bun.spawnSync(["bun", "../../tools/depcruise/run.mjs"], {
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

const PROBES: readonly Probe[] = [
  {
    directory: SIBLING_REFERENCE,
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
    directory: SIBLING_IMPLEMENTATION,
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
    directory: TYPE_ONLY,
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
    directory: CORE_TO_SHELL,
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
    directory: CORE_TO_WORLD,
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
    directory: ENTRYPOINT,
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
    directory: CLIENT_SEAM_ALLOWED,
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
    directory: CLIENT_SEAM_BYPASS,
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
    directory: SENTRY_OUTSIDE_OBSERVABILITY,
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
    directory: CYCLE,
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
    directory: BARREL,
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
    directory: ALIAS_SAME_DIRECTORY,
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
    directory: RELATIVE_CROSS_DIRECTORY,
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
    directory: HOSTED_PROVIDER,
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
    directory: HOSTED_MODEL,
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

const assertProbe = (probe: Probe): void => {
  const { exitCode, report } = runGraph();

  if (probe.expect.kind === "allowed") {
    if (!Option.contains(exitCode, 0)) {
      throw new Error(`${probe.name}\nThe gate rejected something it must allow.\n${report}`);
    }
    return;
  }

  const missing = missingFrom(report, probe.expect.mustContain);
  if (Option.contains(exitCode, 0)) {
    throw new Error(
      `${probe.name}\nThe gate PASSED on a graph that violates it — the rule did not fire, ` +
        `or the cruiser never resolved the probe's imports.\n${report}`
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `${probe.name}\nThe gate failed, but not for the reason this probe exists.\n` +
        `Absent from the report: ${missing.join(" | ")}\n${report}`
    );
  }
};

const remove = (path: string): void => {
  const result = Bun.spawnSync(["rm", "-rf", path], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(decode(result.stderr));
  }
};

const stale = Array.from(
  new Bun.Glob("__probe-*").scanSync({ cwd: `${serverRoot}${PROBE_PARENT}`, onlyFiles: false })
);
const staleSource = Array.from(
  new Bun.Glob("__probe-*").scanSync({ cwd: `${serverRoot}/src`, onlyFiles: false })
);
for (const entry of stale) {
  remove(`${serverRoot}${PROBE_PARENT}/${entry}`);
}
for (const entry of staleSource) {
  remove(`${serverRoot}/src/${entry}`);
}
if (stale.length > 0 || staleSource.length > 0) {
  process.stderr.write(
    `swept ${stale.length + staleSource.length} probe directory(ies) from an interrupted run\n`
  );
}

for (const probe of PROBES) {
  try {
    for (const file of probe.files) {
      await Bun.write(`${serverRoot}${file.path}`, file.source);
    }
    assertProbe(probe);
  } finally {
    remove(`${serverRoot}${probe.directory}`);
  }
  process.stdout.write(`ok  ${probe.name}\n`);
}

process.stdout.write(`\nall ${PROBES.length} dependency guard probes passed\n`);
