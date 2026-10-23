import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { ExactEquivalentIgnorer, sourceHash } from "./equivalents.mjs";
import { schema } from "mutation-testing-report-schema";

const here = fileURLToPath(new URL(".", import.meta.url));
const unobservedSourceLine = 5;
/** @type {import("ajv").ValidateFunction<import("mutation-testing-report-schema/api").MutationTestResult>} */
const validateReport = new Ajv({ formats: { uri: true } }).compile(schema);

/** @param {string} fixture - Directory receiving the standalone mutation project. */
const writeFixture = (fixture) => {
  symlinkSync(join(here, "node_modules"), join(fixture, "node_modules"), "dir");
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(fixture, "validation.js"),
    `export const requireEnabled = (enabled) => { if (!enabled) throw new Error("Policy unavailable"); return { enabled }; };`
  );
  writeFileSync(
    join(fixture, "subject.js"),
    `
import { requireEnabled } from "./validation.js";
export const policy = requireEnabled(true);
export const next = (value) => value > 0 ? value + 1 : 0;
export const unobserved = (value) => value + 1;
`
  );
  writeFileSync(
    join(fixture, "subject.test.js"),
    `
import { describe, expect, it } from "vitest";
import { next, policy, unobserved } from "./subject.js";
describe("outer suite", () => {
  describe("inner suite", () => {
    it.each([[-2, 0], [0, 0], [2, 3]])("advances %s to %s", (value, expected) => {
      expect(next(value)).toBe(expected);
    });
    it("uses the enabled policy", () => expect(policy.enabled).toBe(true));
    it("executes a deliberately unasserted calculation", () => { unobserved(1); });
  });
});
`
  );
  writeFileSync(
    join(fixture, "other.test.js"),
    `import { expect, it } from "vitest"; import { next } from "./subject.js"; it("advances in another file", () => expect(next(3)).toBe(4));`
  );
  writeFileSync(
    join(fixture, "vitest.config.mjs"),
    `export default { test: { include: ["*.test.js"], isolate: true } };`
  );
  writeFileSync(
    join(fixture, "stryker.config.json"),
    JSON.stringify({
      plugins: [join(here, "node_modules/@stryker-mutator/vitest-runner/dist/src/index.js")],
      testRunner: "vitest",
      vitest: { configFile: "vitest.config.mjs" },
      mutate: ["subject.js"],
      concurrency: 1,
      coverageAnalysis: "perTest",
      mutator: { excludedMutations: ["StringLiteral", "ObjectLiteral"] },
      thresholds: { break: 0 },
      reporters: ["json"],
    })
  );
};

await test("mutation selection executes nested suites and detects module initialization changes", () => {
  const fixture = mkdtempSync(join(tmpdir(), "fidy-mutation-runner-"));
  try {
    writeFixture(fixture);
    const result = spawnSync(process.execPath, [join(here, "run.mjs")], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    /** @type {unknown} */
    const report = JSON.parse(
      readFileSync(join(fixture, "reports/mutation/mutation.json"), "utf8")
    );
    assert.ok(validateReport(report), JSON.stringify(validateReport.errors));
    const mutants = report.files["subject.js"].mutants.filter(
      (mutant) => mutant.status !== "Ignored"
    );
    assert.ok(mutants.length > 0);
    assert.ok(mutants.some((mutant) => mutant.static));
    assert.ok(mutants.some((mutant) => mutant.location.start.line === unobservedSourceLine));
    assert.ok(
      mutants.some((mutant) => mutant.static && mutant.statusReason?.includes("Policy unavailable"))
    );
    for (const mutant of mutants) {
      assert.equal(
        mutant.status,
        mutant.location.start.line === unobservedSourceLine ? "Survived" : "Killed",
        JSON.stringify(mutant)
      );
      if (!mutant.static) assert.ok(mutant.testsCompleted > 0, JSON.stringify(mutant));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

const logger = {
  isTraceEnabled: () => false,
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isWarnEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

/**
 * @param {import("./equivalents.mjs").EquivalentRegistry} registry - Reviewed fixture record.
 * @param {import("@stryker-mutator/api/core").Mutant} selected - Exact fixture mutation.
 * @param {string} source - Complete fixture source.
 */
const assertOtherMutantsStayActive = (registry, selected, source) => {
  assert.equal(
    new ExactEquivalentIgnorer(registry).shouldIgnoreMutant(
      { ...selected, replacement: "value > 0" },
      source
    ),
    undefined
  );
  assert.equal(
    new ExactEquivalentIgnorer(registry).shouldIgnoreMutant(
      { ...selected, mutatorName: "ConditionalExpression" },
      source
    ),
    undefined
  );
  assert.equal(
    new ExactEquivalentIgnorer(registry).shouldIgnoreMutant(
      { ...selected, fileName: "/fixture/src/core/other.ts" },
      source
    ),
    undefined
  );
};

await test("reviewed equivalents exclude only the exact replacement in unchanged source", async () => {
  const { Instrumenter } = await import("@stryker-mutator/instrumenter");
  const { sourceHash } = await import("./equivalents.mjs");
  const instrumenter = new Instrumenter(logger);
  const source = "export const before = (value: number) => value < 0;\n";
  const fileName = "/fixture/src/core/example.ts";
  const options = { plugins: null, excludedMutations: [], ignorers: [] };
  const baseline = await instrumenter.instrument(
    [{ name: fileName, content: source, mutate: true }],
    options
  );
  const selected = baseline.mutants.find((mutant) => mutant.replacement === "value <= 0");
  assert.ok(selected);
  const registry = {
    files: {
      "src/core/example.ts": {
        sourceSha256: sourceHash(source),
        mutants: [
          {
            ...selected,
            location: {
              start: {
                line: selected.location.start.line + 1,
                column: selected.location.start.column + 1,
              },
              end: {
                line: selected.location.end.line + 1,
                column: selected.location.end.column + 1,
              },
            },
            original: "value < 0",
            reason: "Fixture-only exact-match control",
          },
        ],
      },
    },
  };
  const ignorer = new ExactEquivalentIgnorer(registry);
  const result = await instrumenter.instrument(
    [{ name: fileName, content: source, mutate: true }],
    { ...options, ignorers: [ignorer] }
  );
  assert.equal(result.mutants.length, baseline.mutants.length);
  const ignored = result.mutants.filter((mutant) => mutant.status === "Ignored");
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0]?.replacement, "value <= 0");
  assert.match(ignored[0]?.statusReason ?? "", /^Reviewed equivalent:/);
  assert.ok(
    result.mutants.some(
      (mutant) =>
        mutant.location.start.line === selected.location.start.line && mutant.status === undefined
    )
  );
  assertOtherMutantsStayActive(registry, selected, source);
  const changed = await instrumenter.instrument(
    [{ name: fileName, content: source + "\n", mutate: true }],
    { ...options, ignorers: [ignorer] }
  );
  assert.equal(changed.mutants.filter((mutant) => mutant.status === "Ignored").length, 0);
});

const equivalentReportFixture = () => {
  const source = "x < 0 && y > 0";
  const entry = {
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: source.length + 1 } },
    mutatorName: "ConditionalExpression",
    replacement: "true",
    original: source,
    reason: "Fixture-only exact-match control",
  };
  const registry = {
    files: { "src/core/example.ts": { sourceSha256: sourceHash(source), mutants: [entry] } },
  };
  /** @type {import("mutation-testing-report-schema/api").MutationTestResult} */
  const report = {
    schemaVersion: "3",
    files: {
      "src/core/example.ts": {
        source,
        mutants: [
          {
            ...entry,
            id: "1",
            status: "Ignored",
            statusReason: `Reviewed equivalent: ${entry.reason}`,
          },
        ],
      },
    },
  };
  return { source, registry, report };
};

await test("full reports reject stale, missing, or extra equivalent exclusions", async () => {
  const { verifyEquivalentReport } = await import("./equivalents.mjs");
  const { source, registry, report } = equivalentReportFixture();
  verifyEquivalentReport(registry, report);
  const file = report.files["src/core/example.ts"];
  assert.throws(
    () => verifyEquivalentReport(registry, { ...report, files: {} }),
    /Unexpected reviewed-equivalent count/
  );
  assert.throws(
    () =>
      verifyEquivalentReport(registry, {
        ...report,
        files: { "src/core/example.ts": { ...file, source: source + "\n" } },
      }),
    /Stale equivalent source/
  );
  assert.throws(
    () =>
      verifyEquivalentReport(registry, {
        ...report,
        files: { "src/core/example.ts": { ...file, mutants: [...file.mutants, ...file.mutants] } },
      }),
    /Unexpected reviewed-equivalent count/
  );
  assert.throws(
    () =>
      verifyEquivalentReport(registry, {
        ...report,
        files: {
          "src/core/example.ts": {
            ...file,
            mutants: file.mutants.map((mutant) => ({ ...mutant, replacement: "x > 0" })),
          },
        },
      }),
    /Stale equivalent mutant/
  );
});

await test("full reports distinguish nested equivalents sharing a start position", async () => {
  const { verifyEquivalentReport } = await import("./equivalents.mjs");
  const { registry, report } = equivalentReportFixture();
  const name = "src/core/example.ts";
  const entry = registry.files[name].mutants[0];
  assert.ok(entry);
  const nested = {
    ...entry,
    original: "x < 0",
    location: { ...entry.location, end: { line: 1, column: 6 } },
  };
  registry.files[name].mutants.push(nested);
  const parent = report.files[name].mutants[0];
  assert.ok(parent);
  report.files[name].mutants.push({ ...parent, id: "2", location: nested.location });
  verifyEquivalentReport(registry, report);
});
