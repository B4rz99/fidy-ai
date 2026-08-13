#!/usr/bin/env bun

const repoRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const productionSources = new Bun.Glob("src/**/*.ts");
for await (const path of productionSources.scan({ cwd: repoRoot })) {
  if (path.endsWith(".test.ts")) continue;
  const source = await Bun.file(`${repoRoot}${path}`).text();
  const handwrittenSymbol = /\bSymbol\s*\(/u.test(source) || /\bunique\s+symbol\b/u.test(source);
  if (handwrittenSymbol) {
    throw new Error(`${path}: handwritten Symbol(...) and unique symbol are prohibited`);
  }
}

const probes = [
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
    name: "restricted-clock",
    expectedRule: "eslint(no-restricted-properties)",
    source: `/** Negative probe: core must not read the ambient clock. */\nexport const nowMillis = (): number => Date.now();\n`,
  },
  {
    name: "restricted-process",
    expectedRule: "eslint(no-restricted-globals)",
    source: `/** Negative probe: core must not read ambient process state. */\nexport const platform = (): string => process.platform;\n`,
  },
] as const;

const probeFiles = probes.map((probe) => ({
  ...probe,
  path: `src/core/.lint-${probe.name}-probe-${process.pid}.ts`,
}));

try {
  await Promise.all(probeFiles.map(({ path, source }) => Bun.write(`${repoRoot}${path}`, source)));

  for (const probe of probeFiles) {
    const process = Bun.spawnSync(
      [
        "bunx",
        "oxlint",
        "--deny-warnings",
        "--config",
        ".oxlintrc.json",
        "--type-aware",
        probe.path,
      ],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }
    );
    const report = `${decode(process.stdout)}\n${decode(process.stderr)}`;

    if (process.exitCode === 0 || !report.includes(probe.expectedRule)) {
      throw new Error(
        `Expected the ${probe.name} negative lint probe to fail with ${probe.expectedRule}.\n${report}`
      );
    }
  }
} finally {
  await Promise.all(probeFiles.map(({ path }) => Bun.file(`${repoRoot}${path}`).delete()));
}
