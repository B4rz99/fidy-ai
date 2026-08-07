import { Schema } from "effect";

const maximumChannelNameLength = 32;
const maximumProviderNameLength = 64;
const maximumProviderMessageIdLength = 256;

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
