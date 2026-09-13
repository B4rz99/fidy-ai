import { whatsappInboundQueue } from "~/shell/channels/whatsapp/inbound-execution";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported WhatsApp inbound-turn queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: whatsappInboundQueue.definition,
  identityFields: ["inboundJobId"],
  userFields: ["userId"],
});
