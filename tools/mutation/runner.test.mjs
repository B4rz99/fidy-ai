import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
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
