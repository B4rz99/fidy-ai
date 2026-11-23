import { describe, expect, it } from "vitest";
import type { selectChecks } from "./ci-changes";
import { type CiJob, evaluateMergeGate } from "./merge-gate";

type Plan = ReturnType<typeof selectChecks>;

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  builds: false,
  unit: false,
  "cloudflare-adapters": false,
  "cloudflare-infra": false,
  "security-sast": false,
  "security-sca": false,
  ...overrides,
});

const always = [
  { name: "Select affected checks", conclusion: "success" },
  { name: "Workspace Gate", conclusion: "success" },
  { name: "Secrets", conclusion: "success" },
];

const job = (name: string, conclusion = "success"): CiJob => ({ name, conclusion });

describe("merge gate", () => {
  it("accepts selected successes and explicitly skipped unselected jobs", () => {
    const verdict = evaluateMergeGate({
      plan: plan({ unit: true }),
      native: false,
      jobs: [...always, job("Unit and artifact tests"), job("Builds", "skipped")],
    });

    expect(verdict.passed).toBe(true);
  });

  it("rejects a selected job that did not succeed", () => {
    for (const conclusion of ["failure", "cancelled", "skipped"]) {
      const verdict = evaluateMergeGate({
        plan: plan({ builds: true }),
        native: false,
        jobs: [...always, job("Builds", conclusion)],
      });

      expect(verdict.passed).toBe(false);
    }
  });

  it("rejects an unselected job that ran", () => {
    const verdict = evaluateMergeGate({
      plan: plan(),
      native: false,
      jobs: [...always, job("Builds")],
    });

    expect(verdict.passed).toBe(false);
  });

  it("counts every matrix instance of a selected group", () => {
    const shards = ["1/4", "2/4", "3/4", "4/4"].map((shard) =>
      job(`Cloudflare adapters (${shard})`)
    );

    expect(
      evaluateMergeGate({
        plan: plan({ "cloudflare-adapters": true }),
        native: false,
        jobs: [...always, ...shards],
      }).passed
    ).toBe(true);
    expect(
      evaluateMergeGate({
        plan: plan({ "cloudflare-adapters": true }),
        native: false,
        jobs: [
          ...always,
          ...shards.slice(0, 1),
          job("Cloudflare adapters (2/4)", "failure"),
          ...shards.slice(2),
        ],
      }).passed
    ).toBe(false);
  });

  it("requires the always-on jobs and a successful run conclusion", () => {
    expect(
      evaluateMergeGate({
        plan: plan(),
        native: false,
        jobs: [job("Select affected checks"), job("Workspace Gate")],
      }).passed
    ).toBe(false);
  });
});
