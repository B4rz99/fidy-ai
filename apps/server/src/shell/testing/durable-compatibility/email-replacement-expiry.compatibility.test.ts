import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe } from "vitest";
import {
  ReplacementExpiryPayload,
  ReplacementExpiryWorkflow,
  replacementExpiryQueueId,
  replacementExpiryQueueName,
} from "~/shell/email-authentication/replacement-protocol";
import {
  replacementActivityIdentities,
  replacementExpiryClockName,
} from "~/shell/email-authentication/replacement-workflow";
import {
  type DurableWorkflowSpec,
  assertDurableWorkflowFixture,
  durableClockSpec,
  durableQueueSpec,
  loadDurableWorkflowFixture,
} from "~/shell/testing/durable-compatibility";

const spec: DurableWorkflowSpec = {
  workflow: ReplacementExpiryWorkflow,
  payloadSchema: ReplacementExpiryPayload,
  successSchema: Schema.Void,
  errorSchema: Schema.Never,
  activities: { check: replacementActivityIdentities.checkExpiry },
  clocks: {
    "expiry-1": durableClockSpec(replacementExpiryClockName(1)),
    "expiry-2": durableClockSpec(replacementExpiryClockName(2)),
    "expiry-3": durableClockSpec(replacementExpiryClockName(3)),
    "expiry-100": durableClockSpec(replacementExpiryClockName(100)),
  },
  deferreds: {},
  queues: [
    durableQueueSpec({
      key: "expiry",
      name: replacementExpiryQueueName,
      schema: ReplacementExpiryPayload,
      queueId: (payload) => Effect.succeed(replacementExpiryQueueId(payload)),
    }),
  ],
};

describe("EmailReplacementExpiry durable compatibility", () => {
  it.effect("decodes every checked-in persisted boundary and re-encodes it", () =>
    assertDurableWorkflowFixture(loadDurableWorkflowFixture("email-replacement-expiry"), spec)
  );
});
