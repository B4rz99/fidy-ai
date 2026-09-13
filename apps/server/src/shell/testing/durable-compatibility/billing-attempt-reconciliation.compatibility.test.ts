import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe } from "vitest";
import {
  BillingAttemptReconciliationPayload,
  BillingAttemptReconciliationSuccess,
  BillingAttemptReconciliationWorkflow,
  billingAttemptActivityIdentities,
  billingAttemptQueueId,
  billingAttemptReconciliationClockName,
} from "~/shell/subscription/billing-attempt-execution";
import { billingAttemptQueueName } from "~/shell/subscription/billing-repo";
import {
  type DurableWorkflowSpec,
  assertDurableWorkflowFixture,
  durableClockSpec,
  durableQueueSpec,
  loadDurableWorkflowFixture,
} from "~/shell/testing/durable-compatibility";

const spec: DurableWorkflowSpec = {
  workflow: BillingAttemptReconciliationWorkflow,
  payloadSchema: BillingAttemptReconciliationPayload,
  successSchema: BillingAttemptReconciliationSuccess,
  errorSchema: Schema.Never,
  activities: {
    reconcile: billingAttemptActivityIdentities.reconcile,
    escalate: billingAttemptActivityIdentities.escalate,
  },
  clocks: {
    "wait-1": durableClockSpec(billingAttemptReconciliationClockName(1)),
    "wait-100": durableClockSpec(billingAttemptReconciliationClockName(100)),
  },
  deferreds: {},
  queues: [
    durableQueueSpec({
      key: "reconciliation",
      name: billingAttemptQueueName,
      schema: BillingAttemptReconciliationPayload,
      queueId: (payload) => Effect.succeed(billingAttemptQueueId(payload)),
    }),
  ],
};

describe("BillingAttemptReconciliation durable compatibility", () => {
  it.effect("decodes every checked-in persisted boundary and re-encodes it", () =>
    assertDurableWorkflowFixture(loadDurableWorkflowFixture("billing-attempt-reconciliation"), spec)
  );
});
