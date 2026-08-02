import { Schema } from "effect";

/**
 * Immutable evidence identifying one provider message. Channel and provider
 * qualify the external message id but never establish User identity or select
 * an adapter.
 */
export const ProviderMessageEvidence = Schema.Struct({
  channel: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(32)),
  provider: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(64)),
  providerMessageId: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(256)),
}).annotate({ identifier: "ProviderMessageEvidence" });
export type ProviderMessageEvidence = typeof ProviderMessageEvidence.Type;
