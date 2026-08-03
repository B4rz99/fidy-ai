#!/usr/bin/env bun

const repoRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
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

const runGraph = (): { readonly exitCode: number | null; readonly report: string } => {
  const spawned = Bun.spawnSync(["bun", "tools/depcruise/run.mjs"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: spawned.exitCode,
    report: `${decode(spawned.stdout)}\n${decode(spawned.stderr)}`,
  };
};

const dir = (slug: string): string => `${PROBE_PARENT}/${PROBE_PREFIX}${slug}`;

const SIBLING_REFERENCE = dir("sibling-reference");
const SIBLING_IMPLEMENTATION = dir("sibling-implementation");
const TYPE_ONLY = dir("type-only");
const CORE_TO_SHELL = dir("core-imports-shell");
const ENTRYPOINT = dir("entrypoint");
const CYCLE = dir("cycle");
const BARREL = dir("barrel");
const ALIAS_SAME_DIRECTORY = dir("alias-same-directory");
const RELATIVE_CROSS_DIRECTORY = dir("relative-cross-directory");

const PROBES: readonly Probe[] = [
  {
    directory: SIBLING_REFERENCE,
    expect: { kind: "allowed" },
    files: [
      {
        path: `${SIBLING_REFERENCE}/probe.ts`,
        source:
          'import { UserId } from "~/core/identity/reference";\n' +
          'import { AgentTokenId } from "~/core/tokens/reference";\n\n' +
          "export const siblingReferenceProbe = [UserId, AgentTokenId];\n",
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
];

const missingFrom = (report: string, expected: readonly string[]): readonly string[] =>
  expected.filter((entry) => !report.includes(entry));

const assertProbe = (probe: Probe): void => {
  const { exitCode, report } = runGraph();

  if (probe.expect.kind === "allowed") {
    if (exitCode !== 0) {
      throw new Error(`${probe.name}\nThe gate rejected something it must allow.\n${report}`);
    }
    return;
  }

  const missing = missingFrom(report, probe.expect.mustContain);
  if (exitCode === 0) {
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
  new Bun.Glob("__probe-*").scanSync({ cwd: `${repoRoot}${PROBE_PARENT}`, onlyFiles: false })
);
for (const entry of stale) {
  remove(`${repoRoot}${PROBE_PARENT}/${entry}`);
}
if (stale.length > 0) {
  process.stderr.write(
    `swept ${stale.length} probe directory(ies) from an interrupted run: ${stale.join(", ")}\n`
  );
}

for (const probe of PROBES) {
  try {
    for (const file of probe.files) {
      await Bun.write(`${repoRoot}${file.path}`, file.source);
    }
    assertProbe(probe);
  } finally {
    remove(`${repoRoot}${probe.directory}`);
  }
  process.stdout.write(`ok  ${probe.name}\n`);
}

process.stdout.write(`\nall ${PROBES.length} dependency guard probes passed\n`);
