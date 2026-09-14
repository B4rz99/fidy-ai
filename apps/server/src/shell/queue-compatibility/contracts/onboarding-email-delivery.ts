import { onboardingEmailDeliveryQueue } from "~/shell/onboarding/delivery-workflow";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported onboarding delivery queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: onboardingEmailDeliveryQueue.definition,
  identityFields: ["intentId"],
  userFields: [],
});
