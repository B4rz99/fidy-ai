import { Data, Schema, type Types } from "effect";
import { Locale, ServiceMarket } from "~/core/_shared/context";
import {
  ProviderMessageEvidence,
  WhatsAppProviderMessageId,
} from "~/core/provider-evidence/contract";
import {
  UserId,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppCallerReference,
} from "~/core/identity/contract";
import { InsightKind } from "~/core/insights/contract";
import { PATId } from "~/core/tokens/contract";
import { UtcTimestamp } from "~/core/_shared/time";
import { WebSessionId } from "~/core/web-session/contract";

export const PendingConsentExchangeId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PendingConsentExchangeId"))
  .annotate({ identifier: "PendingConsentExchangeId" });

export type PendingConsentExchangeId = typeof PendingConsentExchangeId.Type;

export const ConsentRecordId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("ConsentRecordId"))
  .annotate({ identifier: "ConsentRecordId" });

export type ConsentRecordId = typeof ConsentRecordId.Type;

export const PolicyRevision = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
)
  .pipe(Schema.brand("PolicyRevision"))
  .annotate({ identifier: "PolicyRevision" });

export type PolicyRevision = typeof PolicyRevision.Type;

export const DisclosureRevision = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
)
  .pipe(Schema.brand("DisclosureRevision"))
  .annotate({ identifier: "DisclosureRevision" });

export type DisclosureRevision = typeof DisclosureRevision.Type;

export const Sha256Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
  .pipe(Schema.brand("Sha256Digest"))
  .annotate({ identifier: "Sha256Digest" });

export type Sha256Digest = typeof Sha256Digest.Type;

const maximumLegalFactLength = 1_000;

const maximumPolicyUrlLength = 2_048;

const maximumDisclosureTextLength = 8_000;

const legalFact = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumLegalFactLength)
);

export const PolicyUrl = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumPolicyUrlLength),
  Schema.isPattern(/^https:\/\/[^\s]+$/u)
)
  .pipe(Schema.brand("PolicyUrl"))
  .annotate({ identifier: "PolicyUrl" });

export type PolicyUrl = typeof PolicyUrl.Type;

export const PolicySnapshot = Schema.Struct({
  publicUrl: PolicyUrl,
  revision: PolicyRevision,
  contentSha256: Sha256Digest,
}).annotate({ identifier: "PolicySnapshot" });

export type PolicySnapshot = typeof PolicySnapshot.Type;

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

export const ConsentGrant = Schema.Union([
  Schema.TaggedStruct("Onboarding", {}),
  Schema.TaggedStruct("PAT", { tokenId: PATId }),
  Schema.TaggedStruct("InsightDelivery", { insightKind: InsightKind }),
]);

export type ConsentGrant = typeof ConsentGrant.Type;

export const ConsentEvent = Schema.Union([
  Schema.TaggedStruct("Granted", { grant: ConsentGrant }),
  Schema.TaggedStruct("Revoked", { grantId: ConsentRecordId }),
]);

export type ConsentEvent = typeof ConsentEvent.Type;

export const ProviderQualifiedMessages = Schema.TaggedStruct("ProviderQualifiedMessages", {
  disclosureMessage: ProviderMessageEvidence,
  decisionMessage: ProviderMessageEvidence,
}).annotate({ identifier: "ProviderQualifiedMessages" });

export type ProviderQualifiedMessages = typeof ProviderQualifiedMessages.Type;

export const ConsentDecisionEvidence = Schema.Union([
  ProviderQualifiedMessages,
  Schema.TaggedStruct("AuthenticatedWeb", {
    webSessionId: WebSessionId,
  }),
  Schema.TaggedStruct("AutomaticPolicy", {
    policy: Schema.Literals(["pat-approved-unclaimed-expiry", "pat-fixed-lifetime-expiry"]),
  }),
]).annotate({ identifier: "ConsentDecisionEvidence" });

export type ConsentDecisionEvidence = typeof ConsentDecisionEvidence.Type;

export const ConsentRecord = Schema.Struct({
  id: ConsentRecordId,
  subjectUserId: UserId,
  event: ConsentEvent,
  disclosure: DisclosureSnapshot,
  occurredAt: UtcTimestamp,
  evidence: ConsentDecisionEvidence,
}).annotate({ identifier: "ConsentRecord" });

export type ConsentRecord = typeof ConsentRecord.Type;

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

export const ConsentInboundContent = Schema.Union([
  Schema.TaggedStruct("Text", { text: Schema.NonEmptyString }),
  Schema.TaggedStruct("Choice", {
    choice: Schema.Literals(["accept", "decline"]),
  }),
]);

export type ConsentInboundContent = typeof ConsentInboundContent.Type;

export type ConsentReplyDecision = Data.TaggedEnum<{
  Accepted: {};
  Declined: {};
  Clarify: {};
}>;

export const ConsentReplyDecision = Data.taggedEnum<ConsentReplyDecision>();

type AwaitingDisclosureDelivery = Types.ExtractTag<
  PendingConsentExchange,
  "AwaitingDisclosureDelivery"
>;

type ReadonlyPolicySnapshot = Readonly<PolicySnapshot>;

type ReadonlyDisclosureSnapshot = Omit<
  Readonly<DisclosureSnapshot>,
  "policy" | "purposes" | "dataCategories"
> & {
  readonly policy: ReadonlyPolicySnapshot;
  readonly purposes: ReadonlyArray<DisclosureSnapshot["purposes"][number]>;
  readonly dataCategories: ReadonlyArray<DisclosureSnapshot["dataCategories"][number]>;
};

export type PendingConsentInput = Omit<
  Readonly<AwaitingDisclosureDelivery>,
  "_tag" | "caller" | "disclosure" | "expiresAt"
> & {
  readonly disclosure: ReadonlyDisclosureSnapshot;
};

export type PendingConsentDraft = Omit<AwaitingDisclosureDelivery, "caller">;

export const PendingConsentDraft = Data.taggedEnum<PendingConsentDraft>();

export const ConsentIngressExchange = Schema.Struct({
  initiatingMessageId: WhatsAppProviderMessageId,
  initiatingBodySha256: Sha256Digest,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  expiresAtMs: Schema.Finite,
  phase: Schema.Union([
    Schema.TaggedStruct("BeforeDelivery", {
      stage: Schema.Literals(["awaiting_delivery", "outbound_started"]),
      disclosureMessageId: Schema.NullOr(WhatsAppProviderMessageId),
    }),
    Schema.TaggedStruct("AwaitingDecision", {
      disclosureMessageId: WhatsAppProviderMessageId,
      disclosedAtMs: Schema.Finite,
      decisionNotBeforeMs: Schema.Finite,
    }),
    Schema.TaggedStruct("Settled", {
      decision: Schema.Literals(["accepted", "declined"]),
      disclosureMessageId: WhatsAppProviderMessageId,
      disclosedAtMs: Schema.Finite,
      decisionNotBeforeMs: Schema.Finite,
    }),
  ]),
});

export type ConsentIngressExchange = typeof ConsentIngressExchange.Type;

export type ConsentIngressMessage = Readonly<{
  providerMessageId: WhatsAppProviderMessageId;
  bodySha256: Sha256Digest;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  occurredAtMs: number;
  receivedAtMs: number;
}>;

export const PATRevocationOrigin = Schema.Literals([
  "user-revoke-one",
  "user-revoke-all",
  "user-revoke-unclaimed",
  "approved-unclaimed-expiry",
  "fixed-lifetime-expiry",
]);

export type PATRevocationOrigin = typeof PATRevocationOrigin.Type;

const PATRevocationStatement = { revision: Schema.String, text: Schema.String };

export const AuthenticatedWebPATRevocation = Schema.TaggedStruct(
  "AuthenticatedWeb",
  PATRevocationStatement
);

export const ApprovedUnclaimedExpiryPATRevocation = Schema.TaggedStruct("AutomaticPolicy", {
  ...PATRevocationStatement,
  policyReason: Schema.Literal("pat-approved-unclaimed-expiry"),
});

export const FixedLifetimeExpiryPATRevocation = Schema.TaggedStruct("AutomaticPolicy", {
  ...PATRevocationStatement,
  policyReason: Schema.Literal("pat-fixed-lifetime-expiry"),
});

export type PATRevocationDisclosures = Readonly<{
  "user-revoke-one": typeof AuthenticatedWebPATRevocation.Type;
  "user-revoke-all": typeof AuthenticatedWebPATRevocation.Type;
  "user-revoke-unclaimed": typeof AuthenticatedWebPATRevocation.Type;
  "approved-unclaimed-expiry": typeof ApprovedUnclaimedExpiryPATRevocation.Type;
  "fixed-lifetime-expiry": typeof FixedLifetimeExpiryPATRevocation.Type;
}>;

export type PATRevocationDisclosure<Origin extends PATRevocationOrigin = PATRevocationOrigin> =
  PATRevocationDisclosures[Origin];

export const WebOnboardingConsentGrantId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)
).pipe(Schema.brand("WebOnboardingConsentGrantId"));

export const OnboardingConsentGrantId = Schema.Union([
  ConsentRecordId,
  WebOnboardingConsentGrantId,
]);

export type OnboardingConsentGrantId = typeof OnboardingConsentGrantId.Type;

export const OnboardingConsentBasis = Schema.Struct({
  grantId: OnboardingConsentGrantId,
  disclosureRevision: DisclosureRevision,
  disclosureSha256: Sha256Digest,
  policyRevision: PolicyRevision,
  policySha256: Sha256Digest,
});

export type OnboardingConsentBasis = typeof OnboardingConsentBasis.Type;
