import { Schema } from "effect";

const maximumChannelNameLength = 32;

const maximumProviderNameLength = 64;

const maximumProviderMessageIdLength = 256;

export const DisclosureDeliveryCorrelationToken = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("DisclosureDeliveryCorrelationToken"))
  .annotate({ identifier: "DisclosureDeliveryCorrelationToken" });

export type DisclosureDeliveryCorrelationToken = typeof DisclosureDeliveryCorrelationToken.Type;

export const ProviderMessageEvidence = Schema.Struct({
  channel: Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(maximumChannelNameLength)
  ),
  provider: Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(maximumProviderNameLength)
  ),
  providerMessageId: Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(maximumProviderMessageIdLength)
  ),
}).annotate({ identifier: "ProviderMessageEvidence" });

export type ProviderMessageEvidence = typeof ProviderMessageEvidence.Type;

export const WhatsAppProviderMessageId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumProviderMessageIdLength)
).pipe(Schema.brand("WhatsAppProviderMessageId"));

export type WhatsAppProviderMessageId = typeof WhatsAppProviderMessageId.Type;
