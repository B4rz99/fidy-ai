import { Schema } from "effect";
import { expect, it } from "vitest";
import { confirmAppliedWorkflow, requireSameWorkflowPlan } from "./native-workflow-recovery-apply";
import {
  WorkflowPlanEvidence,
  instanceProof,
  interruptedRevision,
  smokeName,
  workflowId,
} from "./native-workflow-recovery-plan";

const fingerprint = "a".repeat(64);

const account = "b".repeat(32);

const approval = Schema.decodeSync(WorkflowPlanEvidence)({
  verifierRevision: "c".repeat(40),
  candidateRevision: interruptedRevision,
  failedRun: "44806738835",
  planRun: "44806470332",
  applied: false,
  candidateTraffic: 0,
  recoveryReady: false,
  missing: ["Smoke Workflow"],
  rawProtocolReadersOverlap: false,
  compatibilityReviewRevision: "b5b4b8149af0aad6cbd5d6f657c949d03d1f5e7d",
  change: { logicalId: workflowId, resourceType: "Cloudflare.Workflow", action: "create" },
  unchanged: [
    "ReleaseSmoke-" + interruptedRevision,
    "ReleaseSmokeBucket",
    "ReleaseSmokeQueue-" + interruptedRevision,
  ],
  stateProof: fingerprint,
  instanceProof: instanceProof("tracked"),
});

it("rejects a changed verifier, dependency state, or tracked Workflow instance before Apply", () => {
  expect(() =>
    requireSameWorkflowPlan({ approved: approval, observed: { ...approval } })
  ).not.toThrow();

  for (const change of [
    { verifierRevision: "d".repeat(40) },
    { stateProof: "e".repeat(64) },
    { instanceProof: "f".repeat(64) },
  ]) {
    expect(() =>
      requireSameWorkflowPlan({ approved: approval, observed: { ...approval, ...change } })
    ).toThrow("Approved Workflow scope or tracked state changed");
  }
});

it("requires the original instance to own the persisted Workflow for the exact private Smoke host", () => {
  const id = "c".repeat(32);

  const raw = {
    status: "created",
    fqn: workflowId,
    logicalId: workflowId,
    resourceType: "Cloudflare.Workflow",
    instanceId: "tracked",
    attr: {
      accountId: account,
      workflowId: id,
      workflowName: smokeName,
      className: "ReleaseSmokeWorkflowV2",
      scriptName: smokeName,
      schedules: [],
    },
  };

  expect(confirmAppliedWorkflow({ raw, account, approvedInstance: approval.instanceProof })).toBe(
    id
  );

  for (const changed of [
    { ...raw, instanceId: "foreign" },
    { ...raw, status: "creating" },
    { ...raw, attr: { ...raw.attr, scriptName: "foreign" } },
  ]) {
    expect(() =>
      confirmAppliedWorkflow({ raw: changed, account, approvedInstance: approval.instanceProof })
    ).toThrow();
  }
});
