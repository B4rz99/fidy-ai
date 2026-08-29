import { Schema, SchemaTransformation } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import { canonicalEmailAddressChecks } from "~/core/email-authentication/reference";
import { Price, PriceId } from "./model";

/** Maximum safe displayed-term snapshot retained with one CardEnrollment. */
export const maximumEnrollmentEvidenceCharacters = 4096;
/** Maximum opaque transient provider token admitted at the browser-only boundary. */
export const maximumTransientCardTokenCharacters = 4096;
const sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const providerContentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32,128}$/u));
const boundedEvidenceText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumEnrollmentEvidenceCharacters)
);

/** Stable identity of one short-lived card-enrollment intent. */
export const CardEnrollmentId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("CardEnrollmentId"))
  .annotate({ identifier: "CardEnrollmentId" });
export type CardEnrollmentId = typeof CardEnrollmentId.Type;

/** Billing destination selected explicitly for Wompi and later automatic charges. */
export const BillingEmail = Schema.Trim.pipe(
  Schema.decodeTo(
    Schema.String.check(...canonicalEmailAddressChecks).pipe(Schema.brand("BillingEmail")),
    SchemaTransformation.transform({
      decode: (value) => value.toLowerCase(),
      encode: (value) => value,
    })
  )
).annotate({ identifier: "BillingEmail" });
export type BillingEmail = typeof BillingEmail.Type;

const wompiContractEvidenceFields = {
  permalink: Schema.URLFromString,
  displayedText: boundedEvidenceText,
  contentSha256: sha256Hex,
  providerContentHash,
  observedAt: UtcTimestamp,
} as const;
/** Immutable safe snapshot of Wompi's end-user policy shown before enrollment. */
export const EndUserPolicyEvidence = Schema.Struct({
  kind: Schema.Literal("end-user-policy"),
  ...wompiContractEvidenceFields,
});
/** Immutable safe snapshot of Wompi's personal-data authorization shown before enrollment. */
export const PersonalDataAuthorizationEvidence = Schema.Struct({
  kind: Schema.Literal("personal-data-authorization"),
  ...wompiContractEvidenceFields,
});

/** One safe immutable snapshot of a linked Wompi contract as displayed by Fidy. */
export const WompiContractEvidence = Schema.Union([
  EndUserPolicyEvidence,
  PersonalDataAuthorizationEvidence,
]).annotate({ identifier: "WompiContractEvidence" });
export type WompiContractEvidence = typeof WompiContractEvidence.Type;

/** Both semantically distinct Wompi contracts, named so duplicates are unrepresentable. */
export const WompiContractEvidenceSet = Schema.Struct({
  endUserPolicy: EndUserPolicyEvidence,
  personalDataAuthorization: PersonalDataAuthorizationEvidence,
}).annotate({ identifier: "WompiContractEvidenceSet" });
export type WompiContractEvidenceSet = typeof WompiContractEvidenceSet.Type;

/** Private Wompi identity retained only behind the Subscription shell boundary. */
export const WompiSourceId = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("WompiSourceId"))
  .annotate({ identifier: "WompiSourceId" });
export type WompiSourceId = typeof WompiSourceId.Type;

/** Private Fidy identity of one reusable card payment source. */
export const CardPaymentSourceId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("CardPaymentSourceId"))
  .annotate({ identifier: "CardPaymentSourceId" });
export type CardPaymentSourceId = typeof CardPaymentSourceId.Type;

/** Fidy-owned recurring-charge disclosure bound to one immutable Price. */
export const RecurringDisclosure = Schema.Struct({
  revision: Schema.Literal("wompi-card-enrollment-v1"),
  displayedText: boundedEvidenceText,
  contentSha256: sha256Hex,
}).annotate({ identifier: "RecurringDisclosure" });
export type RecurringDisclosure = typeof RecurringDisclosure.Type;

/** Exactly three independent decisions; a combined consent cannot satisfy this contract. */
export const CardEnrollmentDecisions = Schema.Struct({
  acceptedEndUserPolicy: Schema.Literal(true),
  acceptedPersonalDataAuthorization: Schema.Literal(true),
  authorizedRecurringCharges: Schema.Literal(true),
}).annotate({ identifier: "CardEnrollmentDecisions" });
export type CardEnrollmentDecisions = typeof CardEnrollmentDecisions.Type;

/** Browser-safe prepared state containing every term required before card entry. */
export const PreparedCardEnrollment = Schema.Struct({
  status: Schema.Literal("prepared"),
  enrollmentId: CardEnrollmentId,
  price: Price,
  billingEmail: BillingEmail,
  contracts: WompiContractEvidenceSet,
  recurringDisclosure: RecurringDisclosure,
  wompiPublicKey: Schema.String.check(Schema.isPattern(/^pub_(?:test|prod)_[A-Za-z0-9_-]+$/u)),
  paymentSourceMode: Schema.Literals(["create", "reuse"]),
  expiresAt: UtcTimestamp,
}).annotate({ identifier: "PreparedCardEnrollment" });

const CreatingCardEnrollment = Schema.Struct({
  status: Schema.Literal("creating"),
  enrollmentId: CardEnrollmentId,
  priceId: PriceId,
});
const AvailableCardEnrollment = Schema.Struct({
  status: Schema.Literal("available"),
  enrollmentId: CardEnrollmentId,
  priceId: PriceId,
});
const RefusedCardEnrollment = Schema.Struct({
  status: Schema.Literal("refused"),
  enrollmentId: CardEnrollmentId,
  priceId: PriceId,
  reason: Schema.Literals(["provider-declined", "provider-error", "terms-changed"]),
});
const ExpiredCardEnrollment = Schema.Struct({
  status: Schema.Literal("expired"),
  enrollmentId: CardEnrollmentId,
  priceId: PriceId,
});
const VerifyingCardEnrollment = Schema.Struct({
  status: Schema.Literal("verifying"),
  enrollmentId: CardEnrollmentId,
  priceId: PriceId,
});

/** Closed browser-visible enrollment lifecycle; provider source identity is intentionally absent. */
export const CardEnrollment = Schema.Union([
  PreparedCardEnrollment,
  CreatingCardEnrollment,
  AvailableCardEnrollment,
  RefusedCardEnrollment,
  ExpiredCardEnrollment,
  VerifyingCardEnrollment,
]).annotate({ identifier: "CardEnrollment" });
export type CardEnrollment = typeof CardEnrollment.Type;
