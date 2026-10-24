import { describe, expect, it } from "vitest";
import { operationalSeverity } from "./operations";
import type { AlertSignal, PendingSignal } from "./contract";

const severities = (signals: ReadonlyArray<AlertSignal>): ReadonlyArray<string> =>
  signals.map(operationalSeverity);

const pending = (overrides: Partial<PendingSignal> = {}): PendingSignal => ({
  component: "async-health" as const,
  operation: "billing" as const,
  state: "healthy" as const,
  sampledRejectedEmailWork: 0,
  rejectionSampleLimited: false,
  sampledPending: 0,
  sampleLimited: false,
  oldestPendingAgeMilliseconds: 0,
  expiredUndelivered: 0,
  failedWorkflows: 0,
  unavailableWorkflows: 0,
  ...overrides,
});

describe("operator alert decisions", () => {
  it("escalates stalled accepted work without interpreting its bounded sample as a total", () => {
    expect(
      severities([
        pending({ sampledPending: 8, sampleLimited: true, oldestPendingAgeMilliseconds: 600_000 }),
      ])
    ).toEqual(["critical"]);
  });

  it("treats an unreadable measurement as unavailable rather than healthy", () => {
    expect(
      severities([{ component: "async-health", operation: "billing", state: "unavailable" }])
    ).toEqual(["warning"]);
    expect(operationalSeverity(pending({ state: "attention", unavailableWorkflows: 1 }))).toBe(
      "warning"
    );
  });

  it("reports dead letters and confirmed failed Workflows immediately", () => {
    expect(
      severities([
        {
          component: "async-health",
          operation: "deadLetters",
          state: "attention",
          backlogCount: 1,
          backlogBytes: 20,
        },
        pending({ state: "attention", failedWorkflows: 1 }),
      ])
    ).toEqual(["critical", "critical"]);
  });

  it("alerts when a primary Queue accumulates work even before a D1 outbox ages", () => {
    expect(
      severities([
        {
          component: "async-health",
          operation: "billingQueue",
          state: "attention",
          backlogCount: 150,
          backlogBytes: 3_000,
        },
      ])
    ).toEqual(["warning"]);
  });

  it("does not treat a successful send as Queue or Workflow execution", () => {
    expect(
      severities([
        { component: "capability", operation: "queueExecution", state: "unavailable" },
        {
          component: "capability",
          operation: "workflowExecution",
          state: "attention",
          lastSucceededMs: 100,
        },
      ])
    ).toEqual(["warning", "critical"]);
  });

  it("alerts on overdue statement-byte retention without exposing object keys", () => {
    expect(
      severities([
        {
          component: "async-health",
          operation: "retention",
          state: "attention",
          sampledOverdue: 8,
          sampleLimited: true,
          oldestOverdueAgeMilliseconds: 86_400_000,
        },
      ])
    ).toEqual(["critical"]);
  });

  it("does not call a single rejected email proof a callback rejection spike", () => {
    expect(severities([pending({ state: "attention", sampledRejectedEmailWork: 1 })])).toEqual([
      "none",
    ]);
  });
});
