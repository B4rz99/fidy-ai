import { replacementDeliveryQueue } from "~/shell/email-authentication/replacement-protocol";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported email-replacement delivery queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: replacementDeliveryQueue.definition,
  identityFields: ["intentId"],
  userFields: ["userId"],
});
