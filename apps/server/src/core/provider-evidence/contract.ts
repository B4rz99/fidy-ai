import { Schema } from "effect";

const maximumChannelNameLength = 32;
const maximumProviderNameLength = 64;
const maximumProviderMessageIdLength = 256;

/**
 * Opaque callback capability correlating provider evidence without subject identity. The delivery
 * module must generate each value freshly and unpredictably; UUID shape alone is not authority.
 */
export const DisclosureDeliveryCorrelationToken = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("DisclosureDeliveryCorrelationToken"))
  .annotate({ identifier: "DisclosureDeliveryCorrelationToken" });
export type DisclosureDeliveryCorrelationToken = typeof DisclosureDeliveryCorrelationToken.Type;

/**
 * Immutable evidence identifying one provider message. Channel and provider
 * qualify the external message id but never establish User identity or select
 * an adapter.
 */
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
