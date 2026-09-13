import { consentDisclosureEvidenceQueue } from "~/shell/channels/whatsapp/disclosure-workflow";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported WhatsApp disclosure-evidence queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: consentDisclosureEvidenceQueue.definition,
  identityFields: ["exchangeId", "attemptId", "evidenceRevision"],
  userFields: [],
});
