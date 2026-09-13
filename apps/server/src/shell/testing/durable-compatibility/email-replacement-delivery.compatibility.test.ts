import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe } from "vitest";
import {
  ReplacementDeliveryPayload,
  ReplacementDeliveryResult,
  ReplacementDeliveryWorkflow,
  replacementDeliveryQueueId,
  replacementDeliveryQueueName,
} from "~/shell/email-authentication/replacement-protocol";
import {
  replacementActivityIdentities,
  replacementDatabaseRetryClockName,
} from "~/shell/email-authentication/replacement-workflow";
import {
  type DurableWorkflowSpec,
  assertDurableWorkflowFixture,
  durableClockSpec,
  durableQueueSpec,
  loadDurableWorkflowFixture,
} from "~/shell/testing/durable-compatibility";

const spec: DurableWorkflowSpec = {
  workflow: ReplacementDeliveryWorkflow,
  payloadSchema: ReplacementDeliveryPayload,
  successSchema: ReplacementDeliveryResult,
  errorSchema: Schema.Never,
  activities: { deliver: replacementActivityIdentities.deliver },
  clocks: {
    "database-retry-1-1": durableClockSpec(
      replacementDatabaseRetryClockName({ attempt: 1, databaseAttempt: 1 })
    ),
    "database-retry-3-2": durableClockSpec(
      replacementDatabaseRetryClockName({ attempt: 3, databaseAttempt: 2 })
    ),
  },
  deferreds: {},
  queues: [
    durableQueueSpec({
      key: "delivery",
      name: replacementDeliveryQueueName,
      schema: ReplacementDeliveryPayload,
      queueId: (payload) => Effect.succeed(replacementDeliveryQueueId(payload)),
    }),
  ],
};

describe("EmailReplacementDelivery durable compatibility", () => {
  it.effect("decodes every checked-in persisted boundary and re-encodes it", () =>
    assertDurableWorkflowFixture(loadDurableWorkflowFixture("email-replacement-delivery"), spec)
  );
});
