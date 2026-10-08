import { type DateTime, Schema, SchemaTransformation } from "effect";

const maximumEmailAddressLength = 254;
const mailboxGrammar =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/** Public canonical mailbox checks shared by slices that own email-shaped values. */
export const canonicalEmailAddressChecks = [
  Schema.isNonEmpty(),
  Schema.isLowercased(),
  Schema.isMaxLength(maximumEmailAddressLength),
  Schema.isPattern(mailboxGrammar),
] as const;

const unambiguousGroup = "[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]";

const CanonicalEmailAddress = Schema.String.check(...canonicalEmailAddressChecks)
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

/** One browser field containing the public lookup and secret mailbox proof. */
export const EmailVerificationCode = Schema.String.check(
  Schema.isPattern(new RegExp(`^${unambiguousGroup}{4}(?:-${unambiguousGroup}{4}){5}$`, "u"))
)
  .pipe(Schema.brand("EmailVerificationCode"))
  .annotate({ identifier: "EmailVerificationCode" });
export type EmailVerificationCode = typeof EmailVerificationCode.Type;

/** Closed selector for the fixed content of one EmailAuthentication proof delivery. */
export const EmailProofPurpose = Schema.Literals([
  "credential-replacement",
  "browser-pairing-approval",
]);
export type EmailProofPurpose = typeof EmailProofPurpose.Type;

/** Maximum provider deliveries across initial submission, replacement, and explicit resend. */
export const maximumEmailDeliveryGenerations = 5;

/** Fixed public delay attached to every non-enumerating email-login start response. */
export const browserPairingEmailRetryAfterSeconds = 60;

/** Persistence action selected for one locked replacement-workflow request. */
export type EmailReplacementRequestDecision = "Start" | "ReplaceExpired" | "UseExisting" | "Reject";

/** Exhaustive result of comparing one submitted proof with locked enrollment state. */
export type ProofAttemptDecision =
  | Readonly<{ _tag: "Accept" }>
  | Readonly<{ _tag: "Wrong"; wrongAttempts: number }>
  | Readonly<{ _tag: "Delete" }>
  | Readonly<{ _tag: "Expired" }>;

/**
 * Decides proof use against already-locked current-generation state. Both lifetimes are half-open;
 * the fifth wrong proof requests physical deletion rather than a durable terminal secret state.
 */
export type ProofAttemptInput = Readonly<{
  digestMatches: boolean;
  wrongAttempts: number;
  proofExpiresAt: DateTime.Utc;
  enrollmentExpiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;
