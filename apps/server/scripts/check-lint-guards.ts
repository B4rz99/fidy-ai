#!/usr/bin/env bun

const serverRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = Bun.fileURLToPath(new URL("../../../", import.meta.url));
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const productionSources = new Bun.Glob("src/**/*.ts");
for await (const path of productionSources.scan({ cwd: serverRoot })) {
  if (path.endsWith(".test.ts")) continue;
  const source = await Bun.file(`${serverRoot}${path}`).text();
  const handwrittenSymbol = /\bSymbol\s*\(/u.test(source) || /\bunique\s+symbol\b/u.test(source);
  if (handwrittenSymbol) {
    throw new Error(`${path}: handwritten Symbol(...) and unique symbol are prohibited`);
  }
}

type LintProbe = Readonly<{
  name: string;
  expectedRule: string;
  source: string;
}>;

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

  for (const probe of probeFiles) {
    const process = Bun.spawnSync(
      [
        "bunx",
        "oxlint",
        "--deny-warnings",
        "--config",
        ".oxlintrc.json",
        "--type-aware",
        `apps/server/${probe.path}`,
      ],
      { cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" }
    );
    const report = `${decode(process.stdout)}\n${decode(process.stderr)}`;

    if (process.exitCode === 0 || !report.includes(probe.expectedRule)) {
      throw new Error(
        `Expected the ${probe.name} negative lint probe to fail with ${probe.expectedRule}.\n${report}`
      );
    }
  }
} finally {
  await Promise.all(probeFiles.map(({ path }) => Bun.file(`${serverRoot}${path}`).delete()));
}
