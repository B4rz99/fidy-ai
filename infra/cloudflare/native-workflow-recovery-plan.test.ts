import { expect, it } from "vitest";
import { interruptedRevision, qualifyWorkflowRecoveryPlan } from "./native-workflow-recovery-plan";

const workflow = "ReleaseSmokeWorkflowV2-" + interruptedRevision;

const host = "ReleaseSmoke-" + interruptedRevision;

const name = "fidy-native-smoke-" + interruptedRevision;

const properties = { workflowName: name, className: "ReleaseSmokeWorkflowV2" };

const observedPlan = (): Parameters<typeof qualifyWorkflowRecoveryPlan>[0] => ({
  selectedFqns: new Set([workflow, host]),
  cycleMembers: new Set(),
  deletions: {},
  actions: {},
  actionDeletions: {},
  resources: {
    [workflow]: {
      action: "create",
      resource: { LogicalId: workflow, Type: "Cloudflare.Workflow" },
      bindings: [{ data: { scriptName: name } }],
      downstream: [],
      props: properties,
      state: {
        status: "creating",
        logicalId: workflow,
        fqn: workflow,
        resourceType: "Cloudflare.Workflow",
        props: properties,
        instanceId: "already tracked",
      },
    },
    [host]: {
      action: "noop",
      resource: { LogicalId: host, Type: "Cloudflare.Worker", RemovalPolicy: "retain" },
      bindings: [],
      downstream: [workflow],
      state: {
        status: "created",
        logicalId: host,
        fqn: host,
        resourceType: "Cloudflare.Worker",
        instanceId: "already tracked",
        attr: { workerName: name },
        downstream: [workflow],
        removalPolicy: "retain",
      },
    },
  },
});

it("qualifies one Workflow create with the existing exact hosting Worker untouched", () => {
  expect(qualifyWorkflowRecoveryPlan(observedPlan())).toEqual([host]);
});

it("refuses a host update, metadata change, or unexpected selected cycle", () => {
  const observed = observedPlan();
  const same = observed.resources[host];

  if (same === undefined) throw Error("Missing host in test inventory");

  for (const edit of [
    { ...same, action: "update" },
    { ...same, downstream: [] },
  ]) {
    expect(() =>
      qualifyWorkflowRecoveryPlan({
        ...observed,
        resources: { ...observed.resources, [host]: edit },
      })
    ).toThrow("would change an upstream resource");
  }

  expect(() =>
    qualifyWorkflowRecoveryPlan({ ...observed, cycleMembers: new Set([workflow]) })
  ).toThrow("requires a scoped acyclic plan");
});

it("refuses untracked Workflow state and a plan bound to a different Smoke Worker", () => {
  const observed = observedPlan();
  const same = observed.resources[workflow];

  if (same === undefined) throw Error("Missing Workflow in test inventory");
  expect(() =>
    qualifyWorkflowRecoveryPlan({
      ...observed,
      resources: {
        ...observed.resources,
        [workflow]: { ...same, state: undefined },
      },
    })
  ).toThrow("changed its state identity");
  expect(() =>
    qualifyWorkflowRecoveryPlan({
      ...observed,
      resources: {
        ...observed.resources,
        [workflow]: { ...same, bindings: [{ data: { scriptName: "foreign" } }] },
      },
    })
  ).toThrow("Missing exact interrupted Workflow state");
});

it("refuses any plan that could adopt the Workflow", () => {
  const observed = observedPlan();
  const tracked = observed.resources[workflow];

  if (tracked === undefined) throw Error("Missing Workflow in test inventory");
  expect(() =>
    qualifyWorkflowRecoveryPlan({
      ...observed,
      resources: {
        ...observed.resources,
        [workflow]: { ...tracked, deferredAdoption: { adopt: true } },
      },
    })
  ).toThrow("Missing exact interrupted Workflow state");
});
