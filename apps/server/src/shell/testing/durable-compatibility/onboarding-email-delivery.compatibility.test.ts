import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe } from "vitest";
import {
  OnboardingDeliveryFailed,
  OnboardingDeliveryPayload,
  OnboardingDeliverySuccess,
  OnboardingEmailDeliveryWorkflow,
  deliverOnboardingEmailActivityIdentity,
  onboardingDeliveryQueueName,
  onboardingEmailDeliveryQueueId,
} from "~/shell/onboarding/delivery-workflow";
import {
  type DurableWorkflowSpec,
  assertDurableWorkflowFixture,
  durableQueueSpec,
  loadDurableWorkflowFixture,
} from "~/shell/testing/durable-compatibility";

const spec: DurableWorkflowSpec = {
  workflow: OnboardingEmailDeliveryWorkflow,
  payloadSchema: OnboardingDeliveryPayload,
  successSchema: OnboardingDeliverySuccess,
  errorSchema: OnboardingDeliveryFailed,
  activities: {
    deliver: deliverOnboardingEmailActivityIdentity,
  },
  clocks: {},
  deferreds: {},
  queues: [
    durableQueueSpec({
      key: "delivery",
      name: onboardingDeliveryQueueName,
      schema: OnboardingDeliveryPayload,
      queueId: (payload) => Effect.succeed(onboardingEmailDeliveryQueueId(payload)),
    }),
  ],
};

describe("OnboardingEmailDelivery durable compatibility", () => {
  it.effect("decodes every checked-in persisted boundary and re-encodes it", () =>
    assertDurableWorkflowFixture(loadDurableWorkflowFixture("onboarding-email-delivery"), spec)
  );
});
