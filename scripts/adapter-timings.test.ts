import { expect, it } from "vitest";
import { medianAdapterTimings, timingRuns } from "./adapter-timings";
import { Schema } from "effect";

const run = (runId: string, seconds: number): (typeof timingRuns.Type)[number] => ({
  runId,
  revision: "same-revision",
  platform: "linux",
  configuration: "four-serial-shards",
  reports: [0, 1, 2, 3].map((index) => ({
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: `/runner/apps/server/cloudflare/file-${index}.test.ts`,
        status: "passed",
        startTime: 1000,
        endTime: 1000 + seconds * 1000,
      },
    ],
  })),
});

it("uses the median without discarding a noisy run and preserves the sample range", () => {
  const runs = [run("1", 10), run("2", 80), run("3", 12)];
  expect(medianAdapterTimings(runs)[0]).toEqual({
    file: "file-0.test.ts",
    seconds: 12,
    samples: [10, 80, 12],
    minimum: 10,
    maximum: 80,
  });
  expect(
    medianAdapterTimings(
      runs.map((sample) => ({ ...sample, reports: [...sample.reports].reverse() }))
    )
  ).toEqual(medianAdapterTimings(runs));
  expect(medianAdapterTimings([...runs, run("4", 8)])[0]?.seconds).toBe(11);
});

it("refuses incomplete, duplicated, or non-equivalent evidence", () => {
  const runs = [run("1", 10), run("2", 11), run("3", 12)];
  expect(() => medianAdapterTimings(runs.slice(0, 2))).toThrow("three");
  expect(() => medianAdapterTimings([run("1", 10), run("1", 10), run("3", 12)])).toThrow(
    "distinct"
  );
  expect(() =>
    medianAdapterTimings([run("1", 10), run("2", 11), { ...run("3", 12), revision: "other" }])
  ).toThrow("revision");
  expect(() =>
    medianAdapterTimings([
      run("1", 10),
      run("2", 11),
      { ...run("3", 12), configuration: "different-workers" },
    ])
  ).toThrow("configuration");
  expect(() => medianAdapterTimings([run("1", 10), run("2", 11), run("3", 0)])).toThrow("Invalid");
  expect(() =>
    medianAdapterTimings([run("1", 10), run("2", 11), { ...run("3", 12), reports: [] }])
  ).toThrow("four");
  const missing = run("3", 12);
  expect(() =>
    medianAdapterTimings([
      run("1", 10),
      run("2", 11),
      {
        ...missing,
        reports: missing.reports.map((report, index) =>
          index === 0 ? { ...report, testResults: [] } : report
        ),
      },
    ])
  ).toThrow("Missing");
  expect(() =>
    medianAdapterTimings([
      run("1", 10),
      run("2", 11),
      {
        ...missing,
        reports: missing.reports.map(() => ({
          success: true,
          numFailedTests: 0,
          numPendingTests: 0,
          numTodoTests: 0,
          testResults: [
            {
              name: "/runner/apps/server/cloudflare/duplicate.test.ts",
              status: "passed",
              startTime: 0,
              endTime: 1000,
            },
          ],
        })),
      },
    ])
  ).toThrow("twice");
});

it("rejects failed, skipped, or non-Linux reports before aggregating", () => {
  const decode = Schema.decodeUnknownSync(timingRuns);
  expect(() => decode([{ ...run("1", 10), platform: "darwin" }])).toThrow();
  for (const field of ["numFailedTests", "numPendingTests", "numTodoTests"]) {
    const sample = run("1", 10);
    expect(() =>
      decode([{ ...sample, reports: sample.reports.map((report) => ({ ...report, [field]: 1 })) }])
    ).toThrow();
  }
});
