#!/usr/bin/env bun

import { Schema } from "effect";

const serverRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = Bun.fileURLToPath(new URL("../../../", import.meta.url));
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const productionDirectories = [
  "apps/server/src",
  "apps/server/cloudflare",
  "apps/web/src",
  "infra/cloudflare",
] as const;
const productionPaths = productionDirectories
  .flatMap((directory) =>
    Array.from(new Bun.Glob(`${directory}/**/*.{ts,tsx}`).scanSync({ cwd: workspaceRoot }))
  )
  .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"));
const productionFiles = await Promise.all(
  productionPaths.map((path) =>
    Bun.file(`${workspaceRoot}${path}`)
      .text()
      .then((source) => ({ path, source }))
  )
);
for (const { path, source } of productionFiles) {
  const handwrittenSymbol = /\b(?:Symbol\s*\(|unique\s+symbol\b)/u.exec(source);
  if (handwrittenSymbol !== null) {
    const line = source.slice(0, handwrittenSymbol.index).split("\n").length;
    throw new Error(
      `${path}:${line}: handwritten Symbol(...) and unique symbol are prohibited. ` +
        "Use closure-backed behavior for one-shot capabilities. For domain ids, validate a scalar schema before Schema.brand(...); a brand alone adds no runtime checks. Built-in protocol symbols such as Symbol.iterator remain allowed."
    );
  }
}

type LintProbe = Readonly<
  { name: string; source: string } & ({ expectedRule: string } | { clean: true })
>;

const probes: ReadonlyArray<LintProbe> = [
  {
    name: "effect-promise",
    expectedRule: "effect-guards(no-effect-promise)",
    source: `import { Effect } from "effect";\n\n/** Negative probe: a Promise rejection must not hide behind a never failure channel. */\nexport const hiddenRejection = Effect.promise(() => Promise.resolve("value"));\n`,
  },
  {
    name: "ingestion-node-crypto",
    expectedRule: "eslint(no-restricted-imports)",
    source: `import { randomUUID } from "node:crypto";\n\nexport const platformId = (): string => randomUUID();\n`,
  },
  {
    name: "type-cast",
    expectedRule: "effect-guards(no-type-cast)",
    source: `import { Function } from "effect";\n\n/** Negative probe: type-only casts must never suppress an assignability error. */\nexport const invalidCast = (value: unknown): string => Function.cast<unknown, string>(value);\n`,
  },
  {
    name: "object-brand",
    expectedRule: "effect-guards(scalar-brand-only)",
    source: `import { Schema } from "effect";\n\n/** Negative probe: object schemas must never receive Effect brands. */\nexport const InvalidObjectBrand = Schema.Struct({ value: Schema.String }).pipe(\n  Schema.brand("InvalidObjectBrand")\n);\n`,
  },
  {
    name: "utc-mutation",
    expectedRule: "effect-guards(no-datetime-internals)",
    source: `import type { DateTime } from "effect";\n\n/** Negative probe: the Utc allowance must not permit mutation of its internal cache. */\nexport const mutateUtcCache = (instant: DateTime.Utc): void => {\n  instant.partsUtc = undefined;\n};\n`,
  },
  {
    name: "ambient-clock",
    expectedRule: "effect-guards(no-ambient-nondeterminism)",
    source: `/** Negative probe: an argless Date constructor reads the clock. */\nexport const readClock = (): Date => new Date();\n`,
  },
  {
    name: "ambient-entropy",
    expectedRule: "effect-guards(no-ambient-nondeterminism)",
    source: `import { randomUUID } from "node:crypto";\n\n/** Negative probe: a crypto entropy export must not reach core. */\nexport const makeId = (): string => randomUUID();\n`,
  },
  {
    name: "unknown-parameter",
    expectedRule: "effect-guards(no-unknown-parameters)",
    source: `/** Negative probe: core inputs must carry an established contract. */\nexport const inspect = (value: unknown): boolean => value !== undefined;\n`,
  },
  {
    name: "unsafe-dictionary",
    expectedRule: "effect-guards(no-unsafe-dictionary-type)",
    source: `/** Negative probe: aliases may not conceal an open unestablished value contract. */\ntype Properties = Readonly<Record<string, unknown>>;\n\nexport const properties = (): Properties => ({});\n`,
  },
  {
    name: "unsafe-generic-dictionary",
    expectedRule: "effect-guards(no-unsafe-dictionary-type)",
    source: `/** Negative probe: generic arguments must survive nested utility wrappers. */\ntype Box<Value> = Readonly<Record<string, Value>>;\n\nexport const properties = (): Box<unknown> => ({});\n`,
  },
  {
    name: "shadowed-record",
    clean: true,
    source: `type Record<Key extends string, Value> = { key: Key; value: Value };\n\n/** A locally declared Record is not TypeScript's open dictionary. */\nexport const entry = (): Record<string, unknown> => ({ key: "id", value: "data" });\n`,
  },
  {
    name: "restricted-clock",
    expectedRule: "eslint(no-restricted-properties)",
    source: `/** Negative probe: core must not read the ambient clock. */\nexport const nowMillis = (): number => Date.now();\n`,
  },
  {
    name: "restricted-process",
    expectedRule: "eslint(no-restricted-globals)",
    source: `/** Negative probe: core must not read ambient process state. */\nexport const platform = (): string => process.platform;\n`,
  },
];

const assertProbeResult = (probe: LintProbe, exitCode: number, report: string): void => {
  if ("clean" in probe) {
    if (exitCode !== 0) throw new Error(`Expected ${probe.name} to pass.\n${report}`);
    return;
  }
  if (exitCode === 0 || !report.includes(probe.expectedRule)) {
    throw new Error(
      `Expected the ${probe.name} negative lint probe to fail with ${probe.expectedRule}.\n${report}`
    );
  }
};

const probeFiles = probes.map((probe) => ({
  ...probe,
  path: `${
    probe.name === "ingestion-node-crypto" ? "src/shell/ingestion" : "src/core"
  }/.lint-${probe.name}-probe-${process.pid}.ts`,
}));

try {
  await Promise.all(
    probeFiles.map(({ path, source }) => Bun.write(`${serverRoot}${path}`, source))
  );

  // Keep each probe's path and rule assertion, but construct the type-aware lint program once.
  const result = Bun.spawnSync(
    [
      "bunx",
      "oxlint",
      "--deny-warnings",
      "--config",
      ".oxlintrc.json",
      "--type-aware",
      "--format=json",
      ...probeFiles.map((probe) => `apps/server/${probe.path}`),
    ],
    { cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" }
  );
  const report = Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({
        number_of_files: Schema.Int,
        diagnostics: Schema.Array(Schema.Struct({ filename: Schema.String, code: Schema.String })),
      })
    )
  )(decode(result.stdout));
  if (result.exitCode !== 1 || report.number_of_files !== probeFiles.length) {
    throw new Error(`Lint probes did not all execute.\n${decode(result.stderr)}`);
  }
  for (const probe of probeFiles) {
    const diagnostics = report.diagnostics.filter(
      (diagnostic) => diagnostic.filename === `apps/server/${probe.path}`
    );
    assertProbeResult(probe, diagnostics.length === 0 ? 0 : 1, JSON.stringify(diagnostics));
  }
} finally {
  await Promise.all(probeFiles.map(({ path }) => Bun.file(`${serverRoot}${path}`).delete()));
}
