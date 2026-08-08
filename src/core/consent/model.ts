import { Schema } from "effect";
import { Locale, ServiceMarket } from "~/core/_shared/context";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import { UserId, WhatsAppCallerReference } from "~/core/identity/reference";
import { InsightKind } from "~/core/insights/reference";
import { AgentTokenId } from "~/core/tokens/reference";
import { UtcTimestamp } from "~/core/_shared/time";

const maximumLegalFactLength = 1_000;
const maximumPolicyUrlLength = 2_048;
const maximumDisclosureTextLength = 8_000;

const legalFact = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumLegalFactLength)
);

/** Stable identity of one append-only ConsentRecord. */
export const ConsentRecordId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("ConsentRecordId"))
  .annotate({ identifier: "ConsentRecordId" });
export type ConsentRecordId = typeof ConsentRecordId.Type;

/** Stable identity of one temporary pre-User disclosure exchange. */
export const PendingConsentExchangeId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PendingConsentExchangeId"))
  .annotate({ identifier: "PendingConsentExchangeId" });
export type PendingConsentExchangeId = typeof PendingConsentExchangeId.Type;

/** Immutable source-control identifier of one full policy version. */
export const PolicyRevision = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
)
  .pipe(Schema.brand("PolicyRevision"))
  .annotate({ identifier: "PolicyRevision" });
export type PolicyRevision = typeof PolicyRevision.Type;

/** Immutable identifier of the shorter disclosure presented in chat. */
export const DisclosureRevision = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
)
  .pipe(Schema.brand("DisclosureRevision"))
  .annotate({ identifier: "DisclosureRevision" });
export type DisclosureRevision = typeof DisclosureRevision.Type;

/** Lowercase SHA-256 digest that pins exact source-controlled content bytes. */
export const Sha256Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
  .pipe(Schema.brand("Sha256Digest"))
  .annotate({ identifier: "Sha256Digest" });
export type Sha256Digest = typeof Sha256Digest.Type;

/** Stable HTTPS location of a source-controlled policy revision. */
export const PolicyUrl = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumPolicyUrlLength),
  Schema.isPattern(/^https:\/\/[^\s]+$/u)
)
  .pipe(Schema.brand("PolicyUrl"))
  .annotate({ identifier: "PolicyUrl" });
export type PolicyUrl = typeof PolicyUrl.Type;

/** Exact public policy version represented by Fidy's stable policy URL. */
export const PolicySnapshot = Schema.Struct({
  publicUrl: PolicyUrl,
  revision: PolicyRevision,
  contentSha256: Sha256Digest,
}).annotate({ identifier: "PolicySnapshot" });
export type PolicySnapshot = typeof PolicySnapshot.Type;

/**
 * Exact aviso de privacidad presented before onboarding. Structured legal facts
 * remain independently queryable while `text` preserves what the User saw.
 */
export const DisclosureSnapshot = Schema.Struct({
  serviceMarket: ServiceMarket,
  locale: Locale,
  revision: DisclosureRevision,
  contentSha256: Sha256Digest,
  text: Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(maximumDisclosureTextLength)
  ),
  policy: PolicySnapshot,
  purposes: Schema.UniqueArray(legalFact).check(Schema.isNonEmpty()),
  dataCategories: Schema.UniqueArray(legalFact).check(Schema.isNonEmpty()),
  duration: legalFact,
  revocationMethod: legalFact,
}).annotate({ identifier: "DisclosureSnapshot" });
export type DisclosureSnapshot = typeof DisclosureSnapshot.Type;

/** Capability authorized by one grant, using references owned by the named slice. */
export const ConsentGrant = Schema.Union([
  Schema.TaggedStruct("Onboarding", {}),
  Schema.TaggedStruct("AgentToken", { tokenId: AgentTokenId }),
  Schema.TaggedStruct("InsightDelivery", { insightKind: InsightKind }),
]);
export type ConsentGrant = typeof ConsentGrant.Type;

/** Append-only grant or symmetric revocation; an existing grant is never updated. */
export const ConsentEvent = Schema.Union([
  Schema.TaggedStruct("Granted", { grant: ConsentGrant }),
  Schema.TaggedStruct("Revoked", { grantId: ConsentRecordId }),
]);
export type ConsentEvent = typeof ConsentEvent.Type;

/**
 * Immutable evidence tying one decision to a stable User and the exact legal and
 * provider-qualified message context that made the decision interpretable.
 */
export const ConsentRecord = Schema.Struct({
  id: ConsentRecordId,
  subjectUserId: UserId,
  event: ConsentEvent,
  disclosure: DisclosureSnapshot,
  occurredAt: UtcTimestamp,
  disclosureMessage: ProviderMessageEvidence,
  decisionMessage: ProviderMessageEvidence,
}).annotate({ identifier: "ConsentRecord" });
export type ConsentRecord = typeof ConsentRecord.Type;

/**
 * Temporary pre-User state. Outbound evidence is impossible before delivery and
 * mandatory while a decision is pending. Both variants retain only the provider
 * key that initiated the exchange, never its financial content.
 */
export const PendingConsentExchange = Schema.Union([
  Schema.TaggedStruct("AwaitingDisclosureDelivery", {
    id: PendingConsentExchangeId,
    caller: WhatsAppCallerReference,
    disclosure: DisclosureSnapshot,
    initiatingMessage: ProviderMessageEvidence,
    createdAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  }),
  Schema.TaggedStruct("AwaitingDecision", {
    id: PendingConsentExchangeId,
    caller: WhatsAppCallerReference,
    disclosure: DisclosureSnapshot,
    initiatingMessage: ProviderMessageEvidence,
    disclosureMessage: ProviderMessageEvidence,
    createdAt: UtcTimestamp,
    disclosedAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  }),
]);
export type PendingConsentExchange = typeof PendingConsentExchange.Type;

/** A consent reply decoded from either free text or an explicit channel choice. */
export const ConsentInboundContent = Schema.Union([
  Schema.TaggedStruct("Text", { text: Schema.NonEmptyString }),
  Schema.TaggedStruct("Choice", {
    choice: Schema.Literals(["accept", "decline"]),
  }),
]);
export type ConsentInboundContent = typeof ConsentInboundContent.Type;
