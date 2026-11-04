import { describe, expect, it } from "vitest";
import { compareDashboardCohorts } from "./dashboard-qualification";

const cohort = {
  dataset: "small",
  revision: "baseline",
  browserDigest: "browser-a",
  adapterDigest: "adapter-a",
  surface: "legacy-cross-origin",
  runtime: "Bun pinned",
  compression: "identity",
  build: "production",
  epoch: "2026-11-04T12:00:00.000Z",
  setup: "ready",
  activitySatisfied: true,
  preparedUsers: 1,
  samplesPerActor: 30,
  sourceClean: true,
  scheduleSatisfied: true,
  requestedRevisionMatches: true,
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
  samples: [{ journey: "direct", outcome: "ready", durationMs: 10, user: 0, tab: 0, attempt: 0 }],
} as const;

describe("matched Dashboard qualification", () => {
  it("pins implementation adapters separately while matching the exact observer and logical fixtures", () => {
    expect(
      compareDashboardCohorts(cohort, {
        ...cohort,
        revision: "candidate",
        adapterDigest: "adapter-b",
        surface: "same-origin",
      })
    ).toMatchObject({ status: "measured" });
  });
  it("rejects changed logical facts even when implementation adapters intentionally differ", () => {
    expect(
      compareDashboardCohorts(cohort, {
        ...cohort,
        revision: "candidate",
        adapterDigest: "adapter-b",
        surface: "same-origin",
        fixtureDigest: "different-financial-history",
      })
    ).toMatchObject({ status: "unmatched", differences: ["fixtureDigest"] });
  });
  it("refuses a faster candidate measured with a different browser", () => {
    expect(
      compareDashboardCohorts(cohort, { ...cohort, revision: "candidate", browser: "other" })
    ).toMatchObject({ status: "unmatched", differences: ["browser"] });
  });
  it("compares direct and return p95 separately while retaining refusals outside the percentiles", () => {
    const baseline = {
      ...cohort,
      samples: Array.from({ length: 30 }, (_, attempt) => [
        { journey: "direct", outcome: "ready", durationMs: 100, user: 0, tab: 0, attempt } as const,
        { journey: "return", outcome: "ready", durationMs: 20, user: 0, tab: 0, attempt } as const,
      ]).flat(),
    };
    const candidate = {
      ...baseline,
      revision: "candidate",
      samples: [
        ...Array.from({ length: 30 }, (_, attempt) => [
          { journey: "direct", outcome: "ready", durationMs: 9, user: 0, tab: 0, attempt } as const,
          { journey: "return", outcome: "ready", durationMs: 3, user: 0, tab: 0, attempt } as const,
        ]).flat(),
        {
          journey: "direct",
          outcome: "refused",
          durationMs: 0.01,
          user: 0,
          tab: 0,
          attempt: 30,
        } as const,
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
        (_, attempt) =>
          ({
            journey: "direct",
            outcome: "ready",
            durationMs: 100,
            user: 0,
            tab: 0,
            attempt,
          }) as const
      ),
    };
    const candidate = {
      ...baseline,
      revision: "candidate",
      samples: [
        ...baseline.samples.slice(1),
        {
          journey: "direct",
          outcome: "refused",
          durationMs: 0.01,
          user: 0,
          tab: 0,
          attempt: 30,
        } as const,
      ],
    };
    expect(compareDashboardCohorts(baseline, candidate)).toMatchObject({
      direct: {
        target: { status: "insufficient", requiredSuccessfulSamples: 30 },
        candidate: { offered: 30, ready: 29, refusals: 1 },
      },
    });
  });
  it("does not let a fast represented User conceal missing concurrent participants", () => {
    const partial = {
      ...cohort,
      users: 8 as const,
      preparedUsers: 8,
      samples: Array.from(
        { length: 30 },
        (_, attempt) =>
          ({
            user: 0,
            tab: 0,
            attempt,
            journey: "direct",
            outcome: "ready",
            durationMs: 1,
          }) as const
      ),
    };
    expect(compareDashboardCohorts(partial, { ...partial, revision: "candidate" })).toMatchObject({
      direct: {
        target: { status: "insufficient", incompleteActors: 7 },
      },
    });
  });
});
