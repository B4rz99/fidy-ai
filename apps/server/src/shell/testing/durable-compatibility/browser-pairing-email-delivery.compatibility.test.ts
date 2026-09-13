import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe } from "vitest";
import {
  pairingEmailActivityIdentities,
  pairingEmailRetryClockName,
} from "~/shell/email-authentication/authentication-delivery-worker";
import {
  BrowserPairingEmailDeliveryWorkflow,
  PairingDeliveryPayload,
  PairingDeliveryResult,
  PairingStartPayload,
  pairingDeliveryQueueId,
  pairingDeliveryQueueName,
  pairingStartQueueId,
  pairingStartQueueName,
} from "~/shell/email-authentication/pairing-email-execution";
import {
  type DurableWorkflowSpec,
  assertDurableWorkflowFixture,
  durableClockSpec,
  durableQueueSpec,
  loadDurableWorkflowFixture,
} from "~/shell/testing/durable-compatibility";

const spec: DurableWorkflowSpec = {
  workflow: BrowserPairingEmailDeliveryWorkflow,
  payloadSchema: PairingDeliveryPayload,
  successSchema: PairingDeliveryResult,
  errorSchema: Schema.Never,
  activities: {
    deliver: pairingEmailActivityIdentities.deliver,
  },
  clocks: {
    "retry-1": durableClockSpec(pairingEmailRetryClockName(1)),
    "retry-2": durableClockSpec(pairingEmailRetryClockName(2)),
  },
  deferreds: {},
  queues: [
    durableQueueSpec({
      key: "start",
      name: pairingStartQueueName,
      schema: PairingStartPayload,
      queueId: (payload) => Effect.succeed(pairingStartQueueId(payload)),
    }),
    durableQueueSpec({
      key: "delivery",
      name: pairingDeliveryQueueName,
      schema: PairingDeliveryPayload,
      queueId: (payload) => Effect.succeed(pairingDeliveryQueueId(payload)),
    }),
  ],
};

describe("BrowserPairingEmailDelivery durable compatibility", () => {
  it.effect("decodes every checked-in persisted boundary and re-encodes it", () =>
    assertDurableWorkflowFixture(loadDurableWorkflowFixture("browser-pairing-email-delivery"), spec)
  );
});
