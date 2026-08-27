import { Schema, SchemaTransformation } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import { PendingConsentExchangeId } from "~/core/consent/reference";
import { UserId, WhatsAppCallerReference } from "~/core/identity/reference";
import { WebSessionId } from "~/core/web-session/reference";
import { EmailEnrollmentId } from "./reference";

const maximumEmailAddressLength = 254;
const mailboxGrammar =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const unambiguousGroup = "[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]";

const CanonicalEmailAddress = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isLowercased(),
  Schema.isMaxLength(maximumEmailAddressLength),
  Schema.isPattern(mailboxGrammar)
)
  .pipe(Schema.brand("EmailAddress"))
  .annotate({ identifier: "EmailAddress" });

/**
 * One mailbox normalized only by trimming and lowercasing. Provider-specific dot and plus-address
 * equivalence is deliberately absent, while the conservative launch grammar excludes quoted and
 * address-literal forms that cannot be represented consistently.
 */
export const EmailAddress = Schema.Trim.pipe(
  Schema.decodeTo(
    CanonicalEmailAddress,
    SchemaTransformation.transform({
      decode: (value) => value.toLowerCase(),
      encode: (value) => value,
    })
  )
);
export type EmailAddress = typeof EmailAddress.Type;

/** Random public lookup shown as the first two groups of an email verification code. */
export const EmailVerificationPublicCode = Schema.String.check(
  Schema.isPattern(new RegExp(`^${unambiguousGroup}{4}-${unambiguousGroup}{4}$`, "u"))
)
  .pipe(Schema.brand("EmailVerificationPublicCode"))
  .annotate({ identifier: "EmailVerificationPublicCode" });
export type EmailVerificationPublicCode = typeof EmailVerificationPublicCode.Type;

/** Fresh 80-bit mailbox-control proof that exists raw only in one claimed worker process. */
export const EmailVerificationProof = Schema.String.check(
  Schema.isPattern(new RegExp(`^${unambiguousGroup}{4}(?:-${unambiguousGroup}{4}){3}$`, "u"))
)
  .pipe(Schema.brand("EmailVerificationProof"))
  .annotate({ identifier: "EmailVerificationProof" });
export type EmailVerificationProof = typeof EmailVerificationProof.Type;

/** One browser field containing the public lookup and secret mailbox proof. */
export const EmailVerificationCode = Schema.String.check(
  Schema.isPattern(new RegExp(`^${unambiguousGroup}{4}(?:-${unambiguousGroup}{4}){5}$`, "u"))
)
  .pipe(Schema.brand("EmailVerificationCode"))
  .annotate({ identifier: "EmailVerificationCode" });
export type EmailVerificationCode = typeof EmailVerificationCode.Type;

/** Redacted decoder used wherever untrusted proof-bearing input first becomes structured. */
export const RedactedEmailVerificationCode = Schema.RedactedFromValue(EmailVerificationCode);
export type RedactedEmailVerificationCode = typeof RedactedEmailVerificationCode.Type;

/** Stable identity of one versioned durable proof-delivery intent. */
export const EmailDeliveryIntentId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailDeliveryIntentId"))
  .annotate({ identifier: "EmailDeliveryIntentId" });
export type EmailDeliveryIntentId = typeof EmailDeliveryIntentId.Type;

/** Random fence required to settle the exact delivery claim that generated one proof. */
export const EmailDeliveryClaimToken = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailDeliveryClaimToken"))
  .annotate({ identifier: "EmailDeliveryClaimToken" });
export type EmailDeliveryClaimToken = typeof EmailDeliveryClaimToken.Type;

/** Closed selector for the fixed content of one EmailAuthentication proof delivery. */
export const EmailProofPurpose = Schema.Literals([
  "verified-onboarding",
  "credential-replacement",
  "browser-pairing-approval",
]);
export type EmailProofPurpose = typeof EmailProofPurpose.Type;

/** Consent-owned accepted evidence referenced without importing Consent's model. */
export const AcceptedPendingConsentReference = Schema.Struct({
  pendingConsentExchangeId: PendingConsentExchangeId,
}).annotate({ identifier: "AcceptedPendingConsentReference" });
export type AcceptedPendingConsentReference = typeof AcceptedPendingConsentReference.Type;

const PendingEmailEnrollmentBase = {
  id: EmailEnrollmentId,
  publicCode: EmailVerificationPublicCode,
  caller: WhatsAppCallerReference,
  consent: AcceptedPendingConsentReference,
  expiresAt: UtcTimestamp,
};
/** Maximum provider deliveries across initial submission, replacement, and explicit resend. */
export const maximumEmailDeliveryGenerations = 5;
const sha256ByteLength = 32;
const sha256DigestLength = Schema.makeFilter<{ readonly length: number }>((digest) =>
  digest.length === sha256ByteLength ? undefined : "Expected a 32-byte SHA-256 digest"
);

/** Irreversible SHA-256 digest of one current email verification proof. */
export const EmailVerificationDigest = Schema.Uint8Array.check(sha256DigestLength).annotate({
  identifier: "EmailVerificationDigest",
});
export type EmailVerificationDigest = typeof EmailVerificationDigest.Type;

/** Proof-bearing state reconstructed from the replacement workflow's paired nullable columns. */
export const EmailReplacementProofState = Schema.Union([
  Schema.TaggedStruct("AwaitingDelivery", {}),
  Schema.TaggedStruct("AwaitingProof", {
    proofDigest: EmailVerificationDigest,
    proofExpiresAt: UtcTimestamp,
  }),
]);
export type EmailReplacementProofState = typeof EmailReplacementProofState.Type;

/** One admitted email delivery generation within the fixed five-generation workflow bound. */
export const EmailDeliveryGeneration = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: maximumEmailDeliveryGenerations })
).annotate({ identifier: "EmailDeliveryGeneration" });
export type EmailDeliveryGeneration = typeof EmailDeliveryGeneration.Type;

/** Persisted failed-proof count before the fifth failure deletes its bounded workflow. */
export const EmailWrongProofAttempts = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 4 })
).annotate({ identifier: "EmailWrongProofAttempts" });
export type EmailWrongProofAttempts = typeof EmailWrongProofAttempts.Type;

const PendingEmailEnrollmentDelivery = {
  ...PendingEmailEnrollmentBase,
  email: EmailAddress,
  deliveryGeneration: EmailDeliveryGeneration,
  resendAvailableAt: UtcTimestamp,
  wrongProofAttempts: EmailWrongProofAttempts,
};

/** Canonical bounded pre-User lifecycle; persisted nullable fields decode into these variants. */
export const PendingEmailEnrollment = Schema.Union([
  Schema.TaggedStruct("AwaitingEmail", PendingEmailEnrollmentBase),
  Schema.TaggedStruct("AwaitingProofDelivery", PendingEmailEnrollmentDelivery),
  Schema.TaggedStruct("AwaitingProof", {
    ...PendingEmailEnrollmentDelivery,
    proofDigest: EmailVerificationDigest,
    proofExpiresAt: UtcTimestamp,
  }),
]);
export type PendingEmailEnrollment = typeof PendingEmailEnrollment.Type;

/**
 * Mandatory mailbox credential for one stable User. It may approve an existing
 * BrowserLoginPairing but is neither User identity nor direct WebSession authority.
 */
export const VerifiedEmailCredential = Schema.Struct({
  userId: UserId,
  email: EmailAddress,
  verifiedAt: UtcTimestamp,
}).annotate({ identifier: "VerifiedEmailCredential" });
export type VerifiedEmailCredential = typeof VerifiedEmailCredential.Type;

/** Stable identity of one retained committed credential-lifecycle event. */
export const VerifiedEmailCredentialLifecycleEventId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("VerifiedEmailCredentialLifecycleEventId"))
  .annotate({ identifier: "VerifiedEmailCredentialLifecycleEventId" });
export type VerifiedEmailCredentialLifecycleEventId =
  typeof VerifiedEmailCredentialLifecycleEventId.Type;

/**
 * Metadata-only evidence of a committed credential replacement. It deliberately cannot represent
 * a mailbox, workflow, proof, request body, provider value, prose, or financial fact.
 */
export const VerifiedEmailCredentialLifecycleEvent = Schema.Struct({
  id: VerifiedEmailCredentialLifecycleEventId,
  subjectUserId: UserId,
  authorizingWebSessionId: WebSessionId,
  kind: Schema.Literal("Replaced"),
  occurredAt: UtcTimestamp,
}).annotate({ identifier: "VerifiedEmailCredentialLifecycleEvent" });
export type VerifiedEmailCredentialLifecycleEvent =
  typeof VerifiedEmailCredentialLifecycleEvent.Type;

/** Stable identity of one User's bounded active credential-replacement workflow. */
export const EmailReplacementWorkflowId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailReplacementWorkflowId"))
  .annotate({ identifier: "EmailReplacementWorkflowId" });
export type EmailReplacementWorkflowId = typeof EmailReplacementWorkflowId.Type;

/** One User's bounded active transition toward a candidate verified-email credential. */
export const EmailReplacementWorkflow = Schema.Struct({
  id: EmailReplacementWorkflowId,
  candidateEmailAddress: EmailAddress,
  publicCode: EmailVerificationPublicCode,
  startedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  deliveryGeneration: EmailDeliveryGeneration,
  resendAvailableAt: UtcTimestamp,
  proofState: EmailReplacementProofState,
  wrongProofAttempts: EmailWrongProofAttempts,
}).annotate({ identifier: "EmailReplacementWorkflow" });
export type EmailReplacementWorkflow = typeof EmailReplacementWorkflow.Type;

/** Random lease fence for one globally claimed replacement-retention step. */
export const EmailReplacementRetentionClaimToken = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailReplacementRetentionClaimToken"))
  .annotate({ identifier: "EmailReplacementRetentionClaimToken" });
export type EmailReplacementRetentionClaimToken = typeof EmailReplacementRetentionClaimToken.Type;

/** Durable identity of one HMAC-only browser-pairing email start request. */
export const BrowserPairingEmailStartRequestId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("BrowserPairingEmailStartRequestId"))
  .annotate({ identifier: "BrowserPairingEmailStartRequestId" });
export type BrowserPairingEmailStartRequestId = typeof BrowserPairingEmailStartRequestId.Type;

/** Lease fence for one globally claimed browser-pairing email start request. */
export const BrowserPairingEmailStartRequestClaimToken = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("BrowserPairingEmailStartRequestClaimToken"))
  .annotate({ identifier: "BrowserPairingEmailStartRequestClaimToken" });
export type BrowserPairingEmailStartRequestClaimToken =
  typeof BrowserPairingEmailStartRequestClaimToken.Type;

/** Stable identity of one User-owned email approval workflow for an existing browser pairing. */
export const BrowserPairingEmailWorkflowId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("BrowserPairingEmailWorkflowId"))
  .annotate({ identifier: "BrowserPairingEmailWorkflowId" });
export type BrowserPairingEmailWorkflowId = typeof BrowserPairingEmailWorkflowId.Type;

/** Random lease fence for one globally discovered, User-scoped retention step. */
export const BrowserPairingEmailRetentionClaimToken = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("BrowserPairingEmailRetentionClaimToken"))
  .annotate({ identifier: "BrowserPairingEmailRetentionClaimToken" });
export type BrowserPairingEmailRetentionClaimToken =
  typeof BrowserPairingEmailRetentionClaimToken.Type;

const BrowserPairingEmailWorkflowBase = {
  id: BrowserPairingEmailWorkflowId,
  pairingId: BrowserLoginPairingId,
  credentialVerifiedAt: UtcTimestamp,
  publicCode: EmailVerificationPublicCode,
  startedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  deliveryGeneration: EmailDeliveryGeneration,
  resendAvailableAt: UtcTimestamp,
  wrongProofAttempts: EmailWrongProofAttempts,
};

/** Workflow projection before a current-generation mailbox proof has been armed. */
export const BrowserPairingEmailWorkflowAwaitingDelivery = Schema.TaggedStruct(
  "AwaitingDelivery",
  BrowserPairingEmailWorkflowBase
);
/** Workflow projection carrying the digest and expiry of the currently armed mailbox proof. */
export const BrowserPairingEmailWorkflowAwaitingProof = Schema.TaggedStruct("AwaitingProof", {
  ...BrowserPairingEmailWorkflowBase,
  proofDigest: EmailVerificationDigest,
  proofExpiresAt: UtcTimestamp,
});
/** Exactly one active proof-delivery lifecycle pinned to one pairing and credential revision. */
export const BrowserPairingEmailWorkflow = Schema.Union([
  BrowserPairingEmailWorkflowAwaitingDelivery,
  BrowserPairingEmailWorkflowAwaitingProof,
]).annotate({ identifier: "BrowserPairingEmailWorkflow" });
export type BrowserPairingEmailWorkflow = typeof BrowserPairingEmailWorkflow.Type;

export { EmailEnrollmentId };
