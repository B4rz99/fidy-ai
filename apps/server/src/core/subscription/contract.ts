import { canonicalEmailAddressChecks } from "~/core/email-authentication/contract";
import { BigDecimal, Schema, SchemaTransformation } from "effect";
import { IanaTimeZone, ServiceMarket } from "~/core/_shared/context";
import { Money } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";
import { PriceId } from "./reference";
import { TrialPeriod } from "~/core/identity/contract";
import { AccessTier } from "~/core/access-tier/contract";

export { PriceId } from "./reference";

/** The canonical public web destination where a User can start a Pro Subscription. */
export const UpgradeDestination = Schema.Struct({
  url: Schema.URLFromString,
}).annotate({ identifier: "UpgradeDestination" });
export type UpgradeDestination = typeof UpgradeDestination.Type;

/** Exact Subscription billing cadences offered at launch. */
export const BillingPeriod = Schema.Literals(["weekly", "monthly", "yearly"]).annotate({
  identifier: "BillingPeriod",
});
export type BillingPeriod = typeof BillingPeriod.Type;

/** Minimal consumer tax fact approved for the launch offers. */
export const TaxTreatment = Schema.Literal("not-taxable").annotate({
  identifier: "TaxTreatment",
});
export type TaxTreatment = typeof TaxTreatment.Type;

/** The only payment-method families presented for MVP enrollment. */
export const LaunchPaymentMethods = Schema.Tuple([
  Schema.Literal("card"),
  Schema.Literal("nequi"),
  Schema.Literal("daviplata"),
]).annotate({ identifier: "LaunchPaymentMethods" });
export type LaunchPaymentMethods = typeof LaunchPaymentMethods.Type;

/** Immutable renewal and cancellation terms disclosed before payment-method entry. */
export const RenewalTerms = Schema.Struct({
  automaticRenewal: Schema.Literal(true),
  renewalReminder: Schema.Literal("none"),
  cancellation: Schema.Literal("future-renewals-only"),
  paidAccessEnds: Schema.Literal("paid-period-end"),
}).annotate({ identifier: "RenewalTerms" });
export type RenewalTerms = typeof RenewalTerms.Type;

const zero = BigDecimal.make(0n, 0);
const colombiaPaidOffer = Schema.makeFilter<{
  readonly money: {
    readonly amount: Readonly<BigDecimal.BigDecimal>;
    readonly currency: string;
  };
}>((revision) => {
  if (BigDecimal.Order(revision.money.amount, zero) !== 1) {
    return {
      path: ["money", "amount"],
      issue: "Price Money must be greater than zero",
    };
  }
  return revision.money.currency === "COP"
    ? undefined
    : {
        path: ["money", "currency"],
        issue: "Colombia Price Money must use COP",
      };
});

/** One immutable authoritative version of Subscription price and renewal terms. */
export const Price = Schema.Struct({
  id: PriceId,
  money: Money,
  billingPeriod: BillingPeriod,
  serviceMarket: ServiceMarket,
  taxTreatment: TaxTreatment,
  renewalTerms: RenewalTerms,
  paymentMethods: LaunchPaymentMethods,
})
  .check(colombiaPaidOffer)
  .annotate({ identifier: "Price" });
export type Price = typeof Price.Type;

const subscriptionOfferPeriodOrder: ReadonlyArray<BillingPeriod> = ["weekly", "monthly", "yearly"];
type OfferIdentityAndPeriod = Readonly<{
  id: Price["id"];
  billingPeriod: BillingPeriod;
}>;
const authoritativeOfferSet = Schema.makeFilter<
  readonly [OfferIdentityAndPeriod, OfferIdentityAndPeriod, OfferIdentityAndPeriod]
>((offers) => {
  for (const [index, expectedPeriod] of subscriptionOfferPeriodOrder.entries()) {
    if (offers[index]?.billingPeriod !== expectedPeriod) {
      return {
        path: [index, "billingPeriod"],
        issue: `Subscription offers must be ordered ${subscriptionOfferPeriodOrder.join(", ")}`,
      };
    }
  }
  return new Set(offers.map((offer) => offer.id)).size === offers.length
    ? undefined
    : {
        path: ["id"],
        issue: "Subscription offers must have distinct Price identities",
      };
});

/** Exact authoritative offer set in weekly, monthly, yearly presentation order. */
export const SubscriptionOffers = Schema.Tuple([Price, Price, Price])
  .check(authoritativeOfferSet)
  .annotate({ identifier: "SubscriptionOffers" });
export type SubscriptionOffers = typeof SubscriptionOffers.Type;

/** Stable identity of one ongoing paid Subscription. */
export const SubscriptionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("SubscriptionId"))
  .annotate({ identifier: "SubscriptionId" });
export type SubscriptionId = typeof SubscriptionId.Type;

/** Browser-generated identity of one intentional payment action, scoped by User in persistence. */
export const PaymentRequestId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PaymentRequestId"))
  .annotate({ identifier: "PaymentRequestId" });
export type PaymentRequestId = typeof PaymentRequestId.Type;

/** Stable Fidy identity of one attempt to collect Subscription Money and its successful period. */
export const BillingAttemptId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("BillingAttemptId"))
  .annotate({ identifier: "BillingAttemptId" });
export type BillingAttemptId = typeof BillingAttemptId.Type;

const BillingAttemptSnapshot = {
  id: BillingAttemptId,
  priceId: PriceId,
  money: Money,
  billingPeriod: BillingPeriod,
  serviceMarket: ServiceMarket,
  taxTreatment: TaxTreatment,
  timeZone: IanaTimeZone,
  createdAt: UtcTimestamp,
};

/** Browser-safe projection of an unsettled BillingAttempt. */
export const PendingBillingAttempt = Schema.Struct({
  status: Schema.Literal("pending"),
  ...BillingAttemptSnapshot,
});
/** Browser-safe projection of a BillingAttempt settled by verified negative evidence. */
export const FailedBillingAttempt = Schema.Struct({
  status: Schema.Literal("failed"),
  ...BillingAttemptSnapshot,
  failedAt: UtcTimestamp,
});
/** Browser-safe projection of a BillingAttempt settled by verified approval. */
export const SucceededBillingAttempt = Schema.Struct({
  status: Schema.Literal("succeeded"),
  ...BillingAttemptSnapshot,
  finalizedAt: UtcTimestamp,
  paidPeriodEndsAt: UtcTimestamp,
  renewalAnchor: UtcTimestamp,
});

/** Browser-safe BillingAttempt projection; all provider and payment-source references are absent. */
export const BillingAttempt = Schema.Union([
  PendingBillingAttempt,
  FailedBillingAttempt,
  SucceededBillingAttempt,
]).annotate({ identifier: "BillingAttempt" });
export type BillingAttempt = typeof BillingAttempt.Type;

/** Current paid period, retaining the exact Price snapshot that was charged. */
export const PaidSubscription = Schema.Struct({
  priceId: PriceId,
  money: Money,
  billingPeriod: BillingPeriod,
  serviceMarket: ServiceMarket,
  taxTreatment: TaxTreatment,
  startsAt: UtcTimestamp,
  endsAt: UtcTimestamp,
  renewalAnchor: UtcTimestamp,
}).annotate({ identifier: "PaidSubscription" });

const maximumRecentBillingAttempts = 10;

/** Standing at one decision instant, including expired evidence without hiding existing data. */
export const SubscriptionStatus = Schema.Struct({
  accessTier: AccessTier,
  trialPeriod: TrialPeriod,
  paidSubscription: Schema.OptionFromNullOr(PaidSubscription),
  recentAttempts: Schema.Array(BillingAttempt).check(
    Schema.isMaxLength(maximumRecentBillingAttempts)
  ),
}).annotate({ identifier: "SubscriptionStatus" });
export type SubscriptionStatus = typeof SubscriptionStatus.Type;

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

/** Closed result of the one-click browser payment action. */
export const CardPaymentSubmission = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("payment-pending"),
    enrollmentId: CardEnrollmentId,
    billingAttempt: BillingAttempt,
  }),
  Schema.Struct({ status: Schema.Literal("source-verifying"), enrollmentId: CardEnrollmentId }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    enrollmentId: CardEnrollmentId,
    reason: Schema.Literals(["provider-declined", "provider-error", "terms-changed", "expired"]),
  }),
]).annotate({ identifier: "CardPaymentSubmission" });
export type CardPaymentSubmission = typeof CardPaymentSubmission.Type;
