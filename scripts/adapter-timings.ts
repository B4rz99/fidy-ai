#!/usr/bin/env bun

import { Schema } from "effect";

const successfulReport = Schema.Struct({
  success: Schema.Literal(true),
  numFailedTests: Schema.Literal(0),
  numPendingTests: Schema.Literal(0),
  numTodoTests: Schema.Literal(0),
  testResults: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literal("passed"),
      startTime: Schema.Finite,
      endTime: Schema.Finite,
    })
  ),
});
const timingRun = Schema.Struct({
  runId: Schema.String,
  revision: Schema.String,
  platform: Schema.Literal("linux"),
  configuration: Schema.String,
  reports: Schema.Array(successfulReport),
});
export const timingRuns = Schema.Array(timingRun);

const millisecondsPerSecond = 1000;
const runSamples = (run: typeof timingRun.Type): ReadonlyMap<string, number> => {
  if (run.reports.length !== 4) throw new Error("Each run must contain all four shards");
  const files = new Map<string, number>();
  for (const result of run.reports.flatMap((report) => report.testResults)) {
    const marker = "/apps/server/cloudflare/";
    const position = result.name.replaceAll("\\", "/").lastIndexOf(marker);
    if (position < 0) throw new Error(`Not a Cloudflare file: ${result.name}`);
    const file = result.name.replaceAll("\\", "/").slice(position + marker.length);
    const seconds = (result.endTime - result.startTime) / millisecondsPerSecond;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Invalid timing: ${file}`);
    if (files.has(file)) throw new Error(`File assigned twice: ${file}`);
    files.set(file, seconds);
  }
  if (files.size === 0) throw new Error("Empty run");
  return files;
};

/** Aggregates complete equivalent Linux runs. Rejects missing/duplicate files instead of
 * inventing measurements; ranges and individual samples retain noise alongside the median.
 */
export const medianAdapterTimings = (
  runs: typeof timingRuns.Type
): ReadonlyArray<
  Readonly<{
    file: string;
    seconds: number;
    samples: ReadonlyArray<number>;
    minimum: number;
    maximum: number;
  }>
> => {
  const first = runs[0];
  if (runs.length < 3 || first === undefined) throw new Error("At least three runs are required");
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
    throw new Error("Runs must have distinct IDs (include the attempt for reruns)");
  }
  const samples = runs.map((run) => {
    if (run.revision !== first.revision || run.configuration !== first.configuration) {
      throw new Error("Runs must use the same revision and configuration");
    }
    return runSamples(run);
  });
  const files = [...(samples[0]?.keys() ?? [])].sort();
  if (
    samples.some(
      (sample) => sample.size !== files.length || files.some((file) => !sample.has(file))
    )
  ) {
    throw new Error("Missing samples: every run must contain the same file set");
  }
  return files.map((file) => {
    const values = samples.map((sample) => {
      const value = sample.get(file);
      if (value === undefined) throw new Error(`Missing sample: ${file}`);
      return value;
    });
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const seconds =
      sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
    return {
      file,
      seconds,
      samples: values,
      minimum: sorted[0] ?? 0,
      maximum: sorted[sorted.length - 1] ?? 0,
    };
  });
};

if (import.meta.main) {
  const path = Bun.argv[2];
  if (path === undefined || Bun.argv.length !== 3) {
    throw new Error("Usage: bun scripts/adapter-timings.ts runs.json");
  }
  const runs = Schema.decodeSync(Schema.fromJsonString(timingRuns))(await Bun.file(path).text());
  process.stdout.write(
    JSON.stringify(
      {
        runs: runs.map(({ reports: _reports, ...metadata }) => metadata),
        files: medianAdapterTimings(runs),
      },
      null,
      2
    ) + "\n"
  );
}
