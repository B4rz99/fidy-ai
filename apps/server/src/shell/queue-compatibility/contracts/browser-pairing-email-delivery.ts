import { pairingDeliveryQueue } from "~/shell/email-authentication/pairing-email-execution";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported browser-pairing delivery queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: pairingDeliveryQueue.definition,
  identityFields: ["intentId"],
  userFields: ["userId"],
});
