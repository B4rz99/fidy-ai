import { statementIngestionQueue } from "~/shell/ingestion/worker";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported statement-ingestion queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: statementIngestionQueue.definition,
  identityFields: ["submissionId"],
  userFields: ["userId"],
});
