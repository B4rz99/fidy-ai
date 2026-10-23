import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { schema as mutationReportSchema } from "mutation-testing-report-schema";
import { PluginKind, declareClassPlugin } from "@stryker-mutator/api/plugin";

/**
 * @typedef {import("@stryker-mutator/api/core").Mutant} Mutant
 * @typedef {{ sourceSha256: string, mutants: Array<{ location: Mutant["location"], mutatorName: string, replacement: string, original: string, reason: string }> }} EquivalentFile
 * @typedef {{ files: Record<string, EquivalentFile> }} EquivalentRegistry
 */

/** @param {string} source - Complete original source text. */
export const sourceHash = (source) => createHash("sha256").update(source).digest("hex");

/**
 * Match the complete source and exact mutant, never an operator, expression, or file blanket.
 * @param {EquivalentRegistry} registry - Individually reviewed mutations.
 * @param {Mutant} mutant - Generated mutation before instrumentation.
 * @param {string} source - Complete original source text.
 * @returns {string | undefined}
 */
export const equivalentReason = (registry, mutant, source) => {
  const fileName = mutant.fileName.replaceAll("\\", "/");
  const file = Object.entries(registry.files).find(
    ([name]) => fileName === name || fileName.endsWith(`/${name}`)
  )?.[1];
  if (file === undefined || file.sourceSha256 !== sourceHash(source)) return undefined;
  const equivalent = file.mutants.find(
    (entry) =>
      entry.mutatorName === mutant.mutatorName &&
      entry.replacement === mutant.replacement &&
      entry.location.start.line === mutant.location.start.line &&
      entry.location.start.column === mutant.location.start.column &&
      entry.location.end.line === mutant.location.end.line &&
      entry.location.end.column === mutant.location.end.column
  );
  return equivalent === undefined ? undefined : `Reviewed equivalent: ${equivalent.reason}`;
};

const position = {
  type: "object",
  required: ["line", "column"],
  additionalProperties: false,
  properties: { line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } },
};
/** @type {import("ajv").ValidateFunction<EquivalentRegistry>} */
const validateRegistry = new Ajv().compile({
  type: "object",
  required: ["files"],
  additionalProperties: false,
  properties: {
    files: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["sourceSha256", "mutants"],
        additionalProperties: false,
        properties: {
          sourceSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          mutants: {
            type: "array",
            items: {
              type: "object",
              required: ["location", "mutatorName", "replacement", "original", "reason"],
              additionalProperties: false,
              properties: {
                location: {
                  type: "object",
                  required: ["start", "end"],
                  additionalProperties: false,
                  properties: { start: position, end: position },
                },
                mutatorName: { type: "string", minLength: 1 },
                replacement: { type: "string" },
                original: { type: "string", minLength: 1 },
                reason: { type: "string", minLength: 20 },
              },
            },
          },
        },
      },
    },
  },
});

/** Read the reviewed registry with structural validation before any exclusions are applied. */
export const loadRegistry = () => {
  /** @type {unknown} */
  const registry = JSON.parse(readFileSync(new URL("./equivalents.json", import.meta.url), "utf8"));
  if (!validateRegistry(registry)) {
    throw new Error(
      `Invalid equivalent registry: ${new Ajv().errorsText(validateRegistry.errors)}`
    );
  }
  return registry;
};

export class ExactEquivalentIgnorer {
  static inject = [];
  /** @param {EquivalentRegistry} registry - Individually reviewed replacements. */
  constructor(registry = loadRegistry()) {
    this.registry = registry;
  }
  shouldIgnore() {
    return undefined;
  }
  /** @param {Mutant} mutant - Generated mutation.
   * @param {string} source - Original source text. */
  shouldIgnoreMutant(mutant, source) {
    const reportMutant = {
      ...mutant,
      location: {
        start: { line: mutant.location.start.line + 1, column: mutant.location.start.column + 1 },
        end: { line: mutant.location.end.line + 1, column: mutant.location.end.column + 1 },
      },
    };
    return equivalentReason(this.registry, reportMutant, source);
  }
}

export const strykerPlugins = [
  declareClassPlugin(PluginKind.Ignore, "exact-equivalents", ExactEquivalentIgnorer),
];

/**
 * @param {EquivalentRegistry} registry - Reviewed records.
 * @param {import("mutation-testing-report-schema/api").MutationTestResult} report - Fresh report.
 */
const verifyEquivalentCount = (registry, report) => {
  const expectedCount = Object.values(registry.files).reduce(
    (count, file) => count + file.mutants.length,
    0
  );
  const actualCount = Object.values(report.files)
    .flatMap((file) => file.mutants)
    .filter(
      (mutant) =>
        mutant.status === "Ignored" && mutant.statusReason?.startsWith("Reviewed equivalent:")
    ).length;
  if (expectedCount !== actualCount) throw new Error("Unexpected reviewed-equivalent count");
};

/**
 * Ensure every recorded exclusion was applied to this report's exact source and mutant.
 * Stale entries must be reviewed even when the remaining scored mutants all pass.
 * @param {EquivalentRegistry} registry - Reviewed source and replacement records.
 * @param {import("mutation-testing-report-schema/api").MutationTestResult} report - Fresh full-scope report.
 */
export const verifyEquivalentReport = (registry, report) => {
  verifyEquivalentCount(registry, report);
  for (const [name, file] of Object.entries(registry.files)) {
    const actual = report.files[name];
    if (!Object.hasOwn(report.files, name) || sourceHash(actual.source) !== file.sourceSha256) {
      throw new Error(`Stale equivalent source: ${name}`);
    }
    for (const entry of file.mutants) {
      const matched = actual.mutants.filter(
        (mutant) =>
          equivalentReason(registry, { ...mutant, fileName: `/report/${name}` }, actual.source) ===
            `Reviewed equivalent: ${entry.reason}` &&
          mutant.statusReason === `Reviewed equivalent: ${entry.reason}` &&
          mutant.mutatorName === entry.mutatorName &&
          mutant.replacement === entry.replacement &&
          mutant.location.start.line === entry.location.start.line &&
          mutant.location.start.column === entry.location.start.column
      );
      if (matched.length !== 1 || matched[0]?.status !== "Ignored") {
        throw new Error(
          `Stale equivalent mutant: ${name}:${entry.location.start.line} ${entry.replacement}`
        );
      }
    }
  }
};

/** @type {import("ajv").ValidateFunction<import("mutation-testing-report-schema/api").MutationTestResult>} */
const validateReport = new Ajv({ formats: { uri: true } }).compile(mutationReportSchema);
/** @param {string} path - Fresh report file to validate and read. */
export const loadMutationReport = (path) => {
  /** @type {unknown} */
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (!validateReport(report)) throw new Error("Invalid mutation report");
  return report;
};
