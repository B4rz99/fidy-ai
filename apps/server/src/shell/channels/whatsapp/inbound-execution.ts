import { Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { UserId } from "~/core/identity/reference";
import { WhatsAppInboundJobId } from "./model";

/** Identifier-only durable handoff for one accepted User-owned WhatsApp message. */
export const WhatsAppInboundWork = Schema.Struct({
  version: Schema.Literal(1),
  userId: UserId,
  inboundJobId: WhatsAppInboundJobId,
});
export type WhatsAppInboundWork = typeof WhatsAppInboundWork.Type;

/** Retry budget shared by acquisition and exhausted-work retirement. */
export const maximumWhatsAppInboundAttempts = 10;

/** Stable SQL queue whose item identity is the accepted inbound job identity. */
export const whatsappInboundQueue = PersistedQueue.make({
  name: "whatsapp-inbound-turn",
  schema: WhatsAppInboundWork,
});
