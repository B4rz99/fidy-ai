import { Effect, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { UserId } from "~/core/identity/reference";
import { maxAttemptsForDurableQueue } from "~/shell/durable-queue-policy";
import { WhatsAppInboundJobId } from "./model";

/** Identifier-only durable handoff for one accepted User-owned WhatsApp message. */
export const WhatsAppInboundWork = Schema.Struct({
  version: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  userId: UserId,
  inboundJobId: WhatsAppInboundJobId,
}).annotate({ identifier: "WhatsAppInboundWork" });
export type WhatsAppInboundWork = typeof WhatsAppInboundWork.Type;

/** Retry budget shared by acquisition and exhausted-work retirement, declared by queue policy. */
export const maximumWhatsAppInboundAttempts = maxAttemptsForDurableQueue("whatsapp-inbound-turn");

/** Stable persisted queue whose item identity is the accepted inbound job identity. */
export const whatsappInboundQueueName = "whatsapp-inbound-turn";
export const whatsappInboundQueue = PersistedQueue.make({
  name: whatsappInboundQueueName,
  schema: WhatsAppInboundWork,
});

/** Native queue primary key: the inbound job this work carries. */
export const whatsappInboundQueueId = (work: WhatsAppInboundWork): string => work.inboundJobId;
