import { Schema } from "effect";
import { Locale, ServiceMarket } from "~/core/_shared/context";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import { UserId, WhatsAppCallerReference } from "~/core/identity/reference";
import { InsightKind } from "~/core/insights/reference";
import { PATId } from "~/core/tokens/reference";
import { UtcTimestamp } from "~/core/_shared/time";
import { WebSessionId } from "~/core/web-session/reference";
import {
  ConsentRecordId,
  DisclosureRevision,
  PendingConsentExchangeId,
  PolicyRevision,
  Sha256Digest,
} from "./reference";

const maximumLegalFactLength = 1_000;
const maximumPolicyUrlLength = 2_048;
const maximumDisclosureTextLength = 8_000;

const legalFact = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumLegalFactLength)
);

export {
  ConsentRecordId,
  DisclosureRevision,
  PendingConsentExchangeId,
  PolicyRevision,
  Sha256Digest,
};

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
  Schema.TaggedStruct("PAT", { tokenId: PATId }),
  Schema.TaggedStruct("InsightDelivery", { insightKind: InsightKind }),
]);
export type ConsentGrant = typeof ConsentGrant.Type;

/** Append-only grant or symmetric revocation; an existing grant is never updated. */
export const ConsentEvent = Schema.Union([
  Schema.TaggedStruct("Granted", { grant: ConsentGrant }),
  Schema.TaggedStruct("Revoked", { grantId: ConsentRecordId }),
]);
export type ConsentEvent = typeof ConsentEvent.Type;

/** Closed evidence for the channel or policy that produced one Consent decision. */
export const ConsentDecisionEvidence = Schema.Union([
  Schema.TaggedStruct("ProviderQualifiedMessages", {
    disclosureMessage: ProviderMessageEvidence,
    decisionMessage: ProviderMessageEvidence,
  }),
  Schema.TaggedStruct("AuthenticatedWeb", {
    webSessionId: WebSessionId,
  }),
  Schema.TaggedStruct("AutomaticPolicy", {
    policy: Schema.Literals(["pat-approved-unclaimed-expiry", "pat-fixed-lifetime-expiry"]),
  }),
]).annotate({ identifier: "ConsentDecisionEvidence" });
export type ConsentDecisionEvidence = typeof ConsentDecisionEvidence.Type;

/**
 * Immutable evidence tying one decision to a stable User, exact legal context,
 * and the honest origin that made the decision interpretable.
 */
export const ConsentRecord = Schema.Struct({
  id: ConsentRecordId,
  subjectUserId: UserId,
  event: ConsentEvent,
  disclosure: DisclosureSnapshot,
  occurredAt: UtcTimestamp,
  evidence: ConsentDecisionEvidence,
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
