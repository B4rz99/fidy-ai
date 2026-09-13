import { forwardedEmailWorkflowQueue } from "~/shell/ingestion/forwarded-email-execution";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported forwarded-email ingestion queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: forwardedEmailWorkflowQueue.definition,
  identityFields: ["receivedEmailId"],
  userFields: ["userId"],
});
