import { describe, expect, it } from "vitest";
import { compareDashboardCohorts } from "./dashboard-qualification";

const cohort = {
  dataset: "small",
  revision: "baseline",
  fixtureDigest: "fixture-a",
  harnessDigest: "harness-a",
  dependenciesDigest: "dependencies-a",
  profile: "desktop",
  network: "normal",
  browser: "Chromium pinned",
  users: 1,
  tabs: 1,
  ingestion: false,
  history: "routine",
  layout: "default",
  pacedIntervalMs: 12000,
  cpuRate: 1,
  samples: [{ journey: "direct", outcome: "ready", durationMs: 10 }],
} as const;

describe("matched Dashboard qualification", () => {
  it("refuses a faster candidate measured with a different browser", () => {
    expect(
      compareDashboardCohorts(cohort, { ...cohort, revision: "candidate", browser: "other" })
    ).toMatchObject({ status: "unmatched", differences: ["browser"] });
  });
  it("compares direct and return p95 separately while retaining refusals outside the percentiles", () => {
    const baseline = {
      ...cohort,
      samples: Array.from({ length: 30 }, () => [
        { journey: "direct", outcome: "ready", durationMs: 100 } as const,
        { journey: "return", outcome: "ready", durationMs: 20 } as const,
      ]).flat(),
    };
    const candidate = {
      ...baseline,
      revision: "candidate",
      samples: [
        ...Array.from({ length: 30 }, () => [
          { journey: "direct", outcome: "ready", durationMs: 9 } as const,
          { journey: "return", outcome: "ready", durationMs: 3 } as const,
        ]).flat(),
        { journey: "direct", outcome: "refused", durationMs: 0.01 } as const,
      ],
    };
    expect(compareDashboardCohorts(baseline, candidate)).toMatchObject({
      status: "measured",
      direct: {
        baseline: { offered: 30, ready: 30, statistics: { p95Ms: 100 } },
        candidate: { offered: 31, ready: 30, refusals: 1, statistics: { p95Ms: 9 } },
        target: { status: "met", maximumP95Ms: 10 },
      },
      return: { target: { status: "unmet", maximumP95Ms: 2 } },
    });
  });
  it("withholds qualification when fewer than thirty successful fresh paints remain", () => {
    const baseline = {
      ...cohort,
      samples: Array.from(
        { length: 30 },
        () =>
          ({
            journey: "direct",
            outcome: "ready",
            durationMs: 100,
          }) as const
      ),
    };
    const candidate = {
      ...baseline,
      revision: "candidate",
      samples: [
        ...baseline.samples.slice(1),
        { journey: "direct", outcome: "refused", durationMs: 0.01 } as const,
      ],
    };
    expect(compareDashboardCohorts(baseline, candidate)).toMatchObject({
      direct: {
        target: { status: "insufficient", requiredSuccessfulSamples: 30 },
        candidate: { offered: 30, ready: 29, refusals: 1 },
      },
    });
  });
});
