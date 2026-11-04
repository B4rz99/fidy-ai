import { describe, expect, it } from "vitest";
import { summarizeDashboardSamples } from "../e2e/dashboard-measurement";

describe("Dashboard cohort reporting", () => {
  it("retains refused and timed-out attempts without counting them as fast paints", () => {
    expect(
      summarizeDashboardSamples([
        { outcome: "ready", durationMs: 10 },
        { outcome: "ready", durationMs: 20 },
        { outcome: "refused", durationMs: 1 },
        { outcome: "timeout", durationMs: 30000 },
        { outcome: "no-fresh-read", durationMs: 2 },
      ])
    ).toEqual({
      offered: 5,
      ready: 2,
      refusals: 1,
      timeouts: 1,
      missingFreshReads: 1,
      statistics: { status: "available", p95Ms: 20, p99Ms: 20, maximumMs: 20 },
    });
  });
  it("reports no latency percentile when every attempted read failed", () => {
    expect(summarizeDashboardSamples([{ outcome: "timeout", durationMs: 30000 }])).toEqual({
      offered: 1,
      ready: 0,
      refusals: 0,
      timeouts: 1,
      missingFreshReads: 0,
      statistics: { status: "unavailable" },
    });
  });
});
