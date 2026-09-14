import { consentDisclosureQueue } from "~/shell/channels/whatsapp/disclosure-workflow";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported WhatsApp consent-disclosure queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: consentDisclosureQueue.definition,
  identityFields: ["exchangeId"],
  userFields: [],
});
