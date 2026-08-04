import { Schema } from "effect";
import type { Array as EffectArray, DateTime } from "effect";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import type { E164PhoneNumber } from "~/core/identity/reference";
import type { TranscriptText } from "~/core/transcript/model";

/** Immutable WhatsApp message identifier retained as evidence, never identity or authority. */
export const WhatsAppProviderMessageId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256)
).pipe(Schema.brand("WhatsAppProviderMessageId"));
export type WhatsAppProviderMessageId = typeof WhatsAppProviderMessageId.Type;

/** Opaque retry key for one authenticated WhatsApp delivery. */
export const WhatsAppDeliveryKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256)
).pipe(Schema.brand("WhatsAppDeliveryKey"));
export type WhatsAppDeliveryKey = typeof WhatsAppDeliveryKey.Type;

/** Business sender identifier required to route a WhatsApp reply. */
export const WhatsAppBusinessPhoneNumberId = Schema.String.check(
  Schema.isPattern(/^[0-9]{1,32}$/u)
).pipe(Schema.brand("WhatsAppBusinessPhoneNumberId"));
export type WhatsAppBusinessPhoneNumberId = typeof WhatsAppBusinessPhoneNumberId.Type;

/** Provider-qualified evidence projected into the WhatsApp operational slice. */
export const WhatsAppMessageEvidence = Schema.Struct({
  ...ProviderMessageEvidence.fields,
  channel: Schema.Literal("whatsapp"),
  providerMessageId: WhatsAppProviderMessageId,
}).annotate({ identifier: "WhatsAppMessageEvidence" });
export type WhatsAppMessageEvidence = typeof WhatsAppMessageEvidence.Type;

/** Audio-media identifier retained as WhatsApp provider evidence only. */
export const WhatsAppMediaId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(256)
).pipe(Schema.brand("WhatsAppMediaId"));
export type WhatsAppMediaId = typeof WhatsAppMediaId.Type;

/** Validated text accepted by the WhatsApp slice after provider authentication and projection. */
export type WhatsAppInboundContent =
  | Readonly<{ readonly _tag: "Text"; readonly text: TranscriptText }>
  | Readonly<{
      readonly _tag: "VoiceTranscript";
      readonly text: TranscriptText;
      readonly mediaId: WhatsAppMediaId;
    }>;

/** Provider-independent input for one authenticated WhatsApp event. */
export type WhatsAppInboundEvent = Readonly<{
  readonly messageEvidence: WhatsAppMessageEvidence;
  readonly phoneNumber: E164PhoneNumber;
  readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  readonly occurredAt: DateTime.Utc;
  readonly receivedAt: DateTime.Utc;
  readonly content: WhatsAppInboundContent;
}>;

/** One authenticated WhatsApp delivery normalized to a non-empty event collection. */
export type WhatsAppWebhookReceipt = Readonly<{
  readonly deliveryKey: WhatsAppDeliveryKey;
  readonly events: EffectArray.NonEmptyReadonlyArray<WhatsAppInboundEvent>;
}>;
