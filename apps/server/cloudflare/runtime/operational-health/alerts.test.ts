import { describe, expect, it } from "vitest";
import { decideOperationalAlerts } from "./operations";
import type { PendingSignal } from "./contract";

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
      decideOperationalAlerts([
        pending({ sampledPending: 8, sampleLimited: true, oldestPendingAgeMilliseconds: 600_000 }),
      ])
    ).toEqual([{ kind: "pending_work", owner: "billing", severity: "critical" }]);
  });

  it("treats an unreadable measurement as unavailable rather than healthy", () => {
    expect(
      decideOperationalAlerts([
        { component: "async-health", operation: "billing", state: "unavailable" },
      ])
    ).toEqual([{ kind: "inspection_unavailable", owner: "billing", severity: "warning" }]);
  });

  it("reports dead letters and confirmed failed Workflows immediately", () => {
    expect(
      decideOperationalAlerts([
        {
          component: "async-health",
          operation: "deadLetters",
          state: "attention",
          backlogCount: 1,
          backlogBytes: 20,
        },
        pending({ state: "attention", failedWorkflows: 1 }),
      ])
    ).toEqual([
      { kind: "dead_letters", owner: "deadLetters", severity: "critical" },
      { kind: "workflow_failure", owner: "billing", severity: "critical" },
    ]);
  });

  it("alerts when a primary Queue accumulates work even before a D1 outbox ages", () => {
    expect(
      decideOperationalAlerts([
        {
          component: "async-health",
          operation: "billingQueue",
          state: "attention",
          backlogCount: 150,
          backlogBytes: 3_000,
        },
      ])
    ).toEqual([{ kind: "queue_backlog", owner: "billingQueue", severity: "warning" }]);
  });

  it("does not treat a successful send as Queue or Workflow execution", () => {
    expect(
      decideOperationalAlerts([
        { component: "capability", operation: "queueExecution", state: "unavailable" },
        {
          component: "capability",
          operation: "workflowExecution",
          state: "attention",
          lastSucceededMs: 100,
        },
      ])
    ).toEqual([
      { kind: "inspection_unavailable", owner: "queueExecution", severity: "warning" },
      { kind: "capability_unusable", owner: "workflowExecution", severity: "critical" },
    ]);
  });

  it("alerts on overdue statement-byte retention without exposing object keys", () => {
    expect(
      decideOperationalAlerts([
        {
          component: "async-health",
          operation: "retention",
          state: "attention",
          sampledOverdue: 8,
          sampleLimited: true,
          oldestOverdueAgeMilliseconds: 86_400_000,
        },
      ])
    ).toEqual([{ kind: "retention_lag", owner: "retention", severity: "critical" }]);
  });

  it("alerts on Workflow failures without relying on Tail Worker measurements", () => {
    expect(
      decideOperationalAlerts([
        {
          component: "workflow-execution",
          operation: "workflowFailures",
          state: "attention",
          recentCount: 1,
          fiveMinuteCount: 1,
        },
        { component: "workflow-execution", operation: "workflowFailures", state: "unavailable" },
      ])
    ).toEqual([
      { kind: "workflow_failure", owner: "workflowFailures", severity: "critical" },
      { kind: "inspection_unavailable", owner: "workflowFailures", severity: "warning" },
    ]);
  });

  it("does not call a single rejected email proof a callback rejection spike", () => {
    expect(
      decideOperationalAlerts([pending({ state: "attention", sampledRejectedEmailWork: 1 })])
    ).toEqual([]);
  });
});
