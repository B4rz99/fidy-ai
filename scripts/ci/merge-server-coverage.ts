#!/usr/bin/env bun

import { type CoverageMapData, createCoverageMap } from "istanbul-lib-coverage";

const coverageThreshold = 90;
const coverageMetrics = ["branches", "functions", "lines", "statements"] as const;

const usage = (): never => {
  process.stderr.write(
    "Usage: bun scripts/ci/merge-server-coverage.ts --input DIRECTORY --output FILE\n"
  );
  process.exit(2);
};

const readArgument = (name: string): string => {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return usage();
  return process.argv[index + 1] ?? usage();
};

const inputDirectory = readArgument("--input");
const outputFile = readArgument("--output");
const reports = Array.from(
  new Bun.Glob("**/coverage-final.json").scanSync({ cwd: inputDirectory, absolute: true })
).sort();
if (reports.length === 0) {
  process.stderr.write(`No coverage-final.json reports found under ${inputDirectory}\n`);
  process.exit(1);
}

const isCoverageMapData = (value: unknown): value is CoverageMapData =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const parseJson = (text: string): unknown => JSON.parse(text);
const reportText = await Promise.all(reports.map((report) => Bun.file(report).text()));
const reportData = reportText.map((text, index): CoverageMapData => {
  const parsed = parseJson(text);
  if (!isCoverageMapData(parsed)) throw new Error(`Invalid coverage report: ${reports[index]}`);
  return parsed;
});

const coverage = createCoverageMap({});
for (const report of reportData) coverage.merge(report);

const outputSeparator = outputFile.lastIndexOf("/");
if (outputSeparator > 0) {
  const result = Bun.spawnSync(["mkdir", "-p", outputFile.slice(0, outputSeparator)], {
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    process.stderr.write(new TextDecoder().decode(result.stderr));
    process.exit(1);
  }
}
await Bun.write(outputFile, `${JSON.stringify(coverage.toJSON())}\n`);

const summary = coverage.getCoverageSummary().toJSON();
const failures: string[] = [];
for (const metric of coverageMetrics) {
  const percentage = summary[metric].pct;
  process.stdout.write(`${metric}: ${percentage}%\n`);
  if (typeof percentage !== "number" || percentage < coverageThreshold) {
    failures.push(`${metric} coverage ${percentage}% is below ${coverageThreshold}%`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Merged ${reports.length} server coverage reports into ${outputFile}\n`);
