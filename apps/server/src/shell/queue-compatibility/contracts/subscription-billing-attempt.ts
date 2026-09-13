import { billingAttemptQueue } from "~/shell/subscription/billing-attempt-execution";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported subscription billing-attempt queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: billingAttemptQueue.definition,
  identityFields: ["billingAttemptId"],
  userFields: ["userId"],
});
