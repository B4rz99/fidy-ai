import { Schema, SchemaTransformation } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import { PendingConsentExchangeId } from "~/core/consent/reference";
import { UserId, WhatsAppCallerReference } from "~/core/identity/reference";
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

/** Random public lookup shown as the first two groups of the combined verification code. */
export const EmailEnrollmentPublicCode = Schema.String.check(
  Schema.isPattern(new RegExp(`^${unambiguousGroup}{4}-${unambiguousGroup}{4}$`, "u"))
)
  .pipe(Schema.brand("EmailEnrollmentPublicCode"))
  .annotate({ identifier: "EmailEnrollmentPublicCode" });
export type EmailEnrollmentPublicCode = typeof EmailEnrollmentPublicCode.Type;

/** Fresh 80-bit mailbox-control proof that exists raw only in one claimed worker process. */
export const EmailVerificationProof = Schema.String.check(
  Schema.isPattern(new RegExp(`^${unambiguousGroup}{4}(?:-${unambiguousGroup}{4}){3}$`, "u"))
)
  .pipe(Schema.brand("EmailVerificationProof"))
  .annotate({ identifier: "EmailVerificationProof" });
export type EmailVerificationProof = typeof EmailVerificationProof.Type;

/** One browser field containing the public enrollment lookup and secret mailbox proof. */
export const EmailEnrollmentCombinedCode = Schema.String.check(
  Schema.isPattern(new RegExp(`^${unambiguousGroup}{4}(?:-${unambiguousGroup}{4}){5}$`, "u"))
)
  .pipe(Schema.brand("EmailEnrollmentCombinedCode"))
  .annotate({ identifier: "EmailEnrollmentCombinedCode" });
export type EmailEnrollmentCombinedCode = typeof EmailEnrollmentCombinedCode.Type;

/** Redacted decoder used wherever untrusted proof-bearing input first becomes structured. */
export const RedactedEmailEnrollmentCombinedCode = Schema.RedactedFromValue(
  EmailEnrollmentCombinedCode
);
export type RedactedEmailEnrollmentCombinedCode = typeof RedactedEmailEnrollmentCombinedCode.Type;

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

/** Consent-owned accepted evidence referenced without importing Consent's model. */
export const AcceptedPendingConsentReference = Schema.Struct({
  pendingConsentExchangeId: PendingConsentExchangeId,
}).annotate({ identifier: "AcceptedPendingConsentReference" });
export type AcceptedPendingConsentReference = typeof AcceptedPendingConsentReference.Type;

const PendingEmailEnrollmentBase = {
  id: EmailEnrollmentId,
  publicCode: EmailEnrollmentPublicCode,
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

const PendingEmailEnrollmentDelivery = {
  ...PendingEmailEnrollmentBase,
  email: EmailAddress,
  deliveryGeneration: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: maximumEmailDeliveryGenerations })
  ),
  resendAvailableAt: UtcTimestamp,
  wrongProofAttempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
};

/** Canonical bounded pre-User lifecycle; persisted nullable fields decode into these variants. */
export const PendingEmailEnrollment = Schema.Union([
  Schema.TaggedStruct("AwaitingEmail", PendingEmailEnrollmentBase),
  Schema.TaggedStruct("AwaitingProofDelivery", PendingEmailEnrollmentDelivery),
  Schema.TaggedStruct("AwaitingProof", {
    ...PendingEmailEnrollmentDelivery,
    proofDigest: Schema.Uint8Array.check(sha256DigestLength),
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

export { EmailEnrollmentId };
