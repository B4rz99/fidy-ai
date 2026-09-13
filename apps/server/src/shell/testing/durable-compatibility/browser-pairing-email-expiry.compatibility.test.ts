import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe } from "vitest";
import {
  pairingEmailActivityIdentities,
  pairingEmailExpiryClockName,
} from "~/shell/email-authentication/authentication-delivery-worker";
import {
  BrowserPairingEmailExpiryWorkflow,
  PairingExpiryPayload,
  pairingExpiryQueueId,
  pairingExpiryQueueName,
} from "~/shell/email-authentication/pairing-email-execution";
import {
  type DurableWorkflowSpec,
  assertDurableWorkflowFixture,
  durableClockSpec,
  durableQueueSpec,
  loadDurableWorkflowFixture,
} from "~/shell/testing/durable-compatibility";

const spec: DurableWorkflowSpec = {
  workflow: BrowserPairingEmailExpiryWorkflow,
  payloadSchema: PairingExpiryPayload,
  successSchema: Schema.Void,
  errorSchema: Schema.Never,
  activities: {
    deadline: pairingEmailActivityIdentities.deadline,
    expire: pairingEmailActivityIdentities.expire,
  },
  clocks: {
    expiry: durableClockSpec(pairingEmailExpiryClockName),
  },
  deferreds: {},
  queues: [
    durableQueueSpec({
      key: "expiry",
      name: pairingExpiryQueueName,
      schema: PairingExpiryPayload,
      queueId: (payload) => Effect.succeed(pairingExpiryQueueId(payload)),
    }),
  ],
};

describe("BrowserPairingEmailExpiry durable compatibility", () => {
  it.effect("decodes every checked-in persisted boundary and re-encodes it", () =>
    assertDurableWorkflowFixture(loadDurableWorkflowFixture("browser-pairing-email-expiry"), spec)
  );
});
