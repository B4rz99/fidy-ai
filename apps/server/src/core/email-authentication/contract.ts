import { Data, type DateTime, Schema, SchemaTransformation } from "effect";

const maximumEmailAddressLength = 254;

const mailboxGrammar =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

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

export const EmailVerificationCode = Schema.String.check(
  Schema.isPattern(new RegExp(`^${unambiguousGroup}{4}(?:-${unambiguousGroup}{4}){5}$`, "u"))
)
  .pipe(Schema.brand("EmailVerificationCode"))
  .annotate({ identifier: "EmailVerificationCode" });

export type EmailVerificationCode = typeof EmailVerificationCode.Type;

export const EmailProofPurpose = Schema.Literals([
  "credential-replacement",
  "browser-pairing-approval",
]);

export type EmailProofPurpose = typeof EmailProofPurpose.Type;

export const maximumEmailDeliveryGenerations = 5;

export const browserPairingEmailRetryAfterSeconds = 60;

export type EmailReplacementRequestDecision = "Start" | "ReplaceExpired" | "UseExisting" | "Reject";

export type ProofAttemptDecision = Data.TaggedEnum<{
  Accept: {};
  Wrong: { readonly wrongAttempts: number };
  Delete: {};
  Expired: {};
}>;

export const ProofAttemptDecision = Data.taggedEnum<ProofAttemptDecision>();

export type ProofAttemptInput = Readonly<{
  digestMatches: boolean;
  wrongAttempts: number;
  proofExpiresAt: DateTime.Utc;
  enrollmentExpiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;
