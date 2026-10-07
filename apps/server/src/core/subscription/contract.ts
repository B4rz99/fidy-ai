import { canonicalEmailAddressChecks } from "~/core/email-authentication/contract";
import { BigDecimal, Schema, SchemaTransformation } from "effect";
import { IanaTimeZone, ServiceMarket } from "~/core/_shared/context";
import { Money, type ReadonlyMoney } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";
import { TrialPeriod, UserId } from "~/core/identity/contract";
import { AccessTier } from "~/core/access-tier/contract";

/** Stable identity of one immutable set of Subscription price terms. */
export const PriceId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PriceId"))
  .annotate({ identifier: "PriceId" });
export type PriceId = typeof PriceId.Type;

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

/** Families represented by immutable Price terms, not a promise of current executable availability. */
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

/** Payment authorization mechanism, independent of the card issuer. */
export const EnrollmentMethod = Schema.Literals(["card", "nequi", "daviplata"]).annotate({
  identifier: "EnrollmentMethod",
});
export type EnrollmentMethod = typeof EnrollmentMethod.Type;

/** Current executable methods, independent of the methods represented by immutable Price terms. */
export const EnrollmentAvailability = Schema.Struct({
  enabledMethods: Schema.UniqueArray(EnrollmentMethod).check(Schema.isMaxLength(3)),
}).annotate({ identifier: "EnrollmentAvailability" });
export type EnrollmentAvailability = typeof EnrollmentAvailability.Type;

const DaviplataOtpEndpoint = Schema.String.check(
  Schema.isPattern(/^https:\/\/(?:sandbox|production)\.wompi\.co\/[A-Za-z0-9/_-]{1,200}$/u)
);

/** Exact reviewed provider destinations. Returned OTP service URLs must equal these, never extend them. */
export const DaviplataOtpPolicy = Schema.Struct({
  sendUrl: DaviplataOtpEndpoint,
  confirmUrl: DaviplataOtpEndpoint,
}).annotate({ identifier: "DaviplataOtpPolicy" });
export type DaviplataOtpPolicy = typeof DaviplataOtpPolicy.Type;

/** Maximum safe displayed-term snapshot retained with one payment enrollment. */
export const maximumEnrollmentEvidenceCharacters = 4096;
/** Maximum opaque transient provider token admitted at the browser-only boundary. */
export const maximumTransientPaymentTokenCharacters = 4096;
const sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const providerContentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32,128}$/u));
const boundedEvidenceText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumEnrollmentEvidenceCharacters)
);

/** Stable identity of one short-lived payment-enrollment intent. */
export const PaymentEnrollmentId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PaymentEnrollmentId"))
  .annotate({ identifier: "PaymentEnrollmentId" });
export type PaymentEnrollmentId = typeof PaymentEnrollmentId.Type;

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
  revision: Schema.Literals([
    "wompi-card-enrollment-v1",
    "wompi-card-enrollment-v2",
    "wompi-nequi-enrollment-v1",
    "wompi-daviplata-enrollment-v1",
  ]),
  displayedText: boundedEvidenceText,
  contentSha256: sha256Hex,
}).annotate({ identifier: "RecurringDisclosure" });
export type RecurringDisclosure = typeof RecurringDisclosure.Type;

/** Exactly three independent decisions; a combined consent cannot satisfy this contract. */
export const EnrollmentDecisions = Schema.Struct({
  acceptedEndUserPolicy: Schema.Literal(true),
  acceptedPersonalDataAuthorization: Schema.Literal(true),
  authorizedRecurringCharges: Schema.Literal(true),
}).annotate({ identifier: "EnrollmentDecisions" });
export type EnrollmentDecisions = typeof EnrollmentDecisions.Type;

const PreparedEnrollmentFields = {
  status: Schema.Literal("prepared"),
  enrollmentId: PaymentEnrollmentId,
  price: Price,
  billingEmail: BillingEmail,
  contracts: WompiContractEvidenceSet,
  recurringDisclosure: RecurringDisclosure,
  wompiPublicKey: Schema.String.check(Schema.isPattern(/^pub_(?:test|prod)_[A-Za-z0-9_-]+$/u)),
  paymentSourceMode: Schema.Literals(["create", "reuse"]),
  expiresAt: UtcTimestamp,
} as const;

/** Every displayed term before method entry, with exact OTP destinations required for DaviPlata. */
export const PreparedPaymentEnrollment = Schema.Union([
  Schema.Struct({ ...PreparedEnrollmentFields, method: Schema.Literals(["card", "nequi"]) }),
  Schema.Struct({
    ...PreparedEnrollmentFields,
    method: Schema.Literal("daviplata"),
    daviplataOtpPolicy: DaviplataOtpPolicy,
  }),
]).annotate({ identifier: "PreparedPaymentEnrollment" });

const CreatingPaymentEnrollment = Schema.Struct({
  status: Schema.Literal("creating"),
  enrollmentId: PaymentEnrollmentId,
  method: EnrollmentMethod,
  priceId: PriceId,
});
const AvailablePaymentEnrollment = Schema.Struct({
  status: Schema.Literal("available"),
  enrollmentId: PaymentEnrollmentId,
  method: EnrollmentMethod,
  priceId: PriceId,
});
const RefusedPaymentEnrollment = Schema.Struct({
  status: Schema.Literal("refused"),
  enrollmentId: PaymentEnrollmentId,
  method: EnrollmentMethod,
  priceId: PriceId,
  reason: Schema.Literals(["provider-declined", "provider-error", "terms-changed"]),
});
const ExpiredPaymentEnrollment = Schema.Struct({
  status: Schema.Literal("expired"),
  enrollmentId: PaymentEnrollmentId,
  method: EnrollmentMethod,
  priceId: PriceId,
});
const VerifyingPaymentEnrollment = Schema.Struct({
  status: Schema.Literal("verifying"),
  enrollmentId: PaymentEnrollmentId,
  method: EnrollmentMethod,
  priceId: PriceId,
});

/** Closed browser-visible enrollment lifecycle; provider source identity is intentionally absent. */
export const PaymentEnrollment = Schema.Union([
  PreparedPaymentEnrollment,
  CreatingPaymentEnrollment,
  AvailablePaymentEnrollment,
  RefusedPaymentEnrollment,
  ExpiredPaymentEnrollment,
  VerifyingPaymentEnrollment,
]).annotate({ identifier: "PaymentEnrollment" });
export type PaymentEnrollment = typeof PaymentEnrollment.Type;

/** Closed result of the one-click browser payment action. */
export const PaymentSubmission = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("payment-pending"),
    enrollmentId: PaymentEnrollmentId,
    billingAttempt: BillingAttempt,
  }),
  Schema.Struct({ status: Schema.Literal("source-verifying"), enrollmentId: PaymentEnrollmentId }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    enrollmentId: PaymentEnrollmentId,
    reason: Schema.Literals(["provider-declined", "provider-error", "terms-changed", "expired"]),
  }),
]).annotate({ identifier: "PaymentSubmission" });
export type PaymentSubmission = typeof PaymentSubmission.Type;

/** Stable identity of one asynchronous billing correction; provider identities remain private. */
export const RefundAttemptId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("RefundAttemptId"))
  .annotate({ identifier: "RefundAttemptId" });
export type RefundAttemptId = typeof RefundAttemptId.Type;

/** Caller-selected retry identity scoped to one User; changing the intent requires a new identity. */
export const RefundRequestId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("RefundRequestId"))
  .annotate({ identifier: "RefundRequestId" });
export type RefundRequestId = typeof RefundRequestId.Type;

/** A correction moves positive exact Money; zero never reserves refundable capacity. */
export const RefundMoney = Money.check(
  Schema.makeFilter<ReadonlyMoney>(
    (money) => BigDecimal.Order(money.amount, zero) > 0 || "Refund Money must be greater than zero"
  )
).annotate({ identifier: "RefundMoney" });
export type RefundMoney = typeof RefundMoney.Type;

/** Closed support reason; arbitrary support notes never become retained payment evidence. */
export const RefundReason = Schema.Literals([
  "user-request",
  "duplicate-collection",
  "service-error",
]).annotate({ identifier: "RefundReason" });

/** Card voids always address the complete charge; a partial void cannot be requested. */
export const RefundIntent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("refund"), money: RefundMoney }),
  Schema.Struct({ kind: Schema.Literal("card-void") }),
]).annotate({ identifier: "RefundIntent" });
export type RefundIntent = typeof RefundIntent.Type;

/** Support addresses Fidy identities; neither a User credential nor a provider id grants this authority. */
export const StartRefundInput = Schema.Struct({
  userId: UserId,
  billingAttemptId: BillingAttemptId,
  requestId: RefundRequestId,
  intent: RefundIntent,
  reason: RefundReason,
}).annotate({ identifier: "StartRefundInput" });
export type StartRefundInput = typeof StartRefundInput.Type;

/** Sandbox evidence is explicitly provisional, never a legal determination for a real sale. */
export const CorrectionTreatment = Schema.Struct({
  policyId: Schema.Literal("refund-ends-paid-period-v1"),
  taxTreatment: TaxTreatment,
  paidPeriodEffect: Schema.Literal("end-refunded-period-at-verification"),
  renewalEffect: Schema.Literal("stop-future-renewals"),
  accounting: Schema.Struct({ kind: Schema.Literal("sandbox-only") }),
}).annotate({ identifier: "CorrectionTreatment" });
export type CorrectionTreatment = typeof CorrectionTreatment.Type;

const RefundSnapshot = {
  id: RefundAttemptId,
  userId: UserId,
  subscriptionId: SubscriptionId,
  billingAttemptId: BillingAttemptId,
  priceId: PriceId,
  kind: Schema.Literals(["refund", "card-void"]),
  money: RefundMoney,
  requestId: RefundRequestId,
  reason: RefundReason,
  treatment: CorrectionTreatment,
  createdAt: UtcTimestamp,
};

/** Safe retained correction history; submission ambiguity remains pending and reserves its Money. */
export const RefundAttempt = Schema.Union([
  Schema.Struct({
    ...RefundSnapshot,
    status: Schema.Literal("pending"),
    progress: Schema.Literals(["queued", "verifying", "outcome-unknown"]),
  }),
  Schema.Struct({
    ...RefundSnapshot,
    status: Schema.Literal("succeeded"),
    verifiedAt: UtcTimestamp,
  }),
  Schema.Struct({
    ...RefundSnapshot,
    status: Schema.Literal("failed"),
    failedAt: UtcTimestamp,
    failure: Schema.Literals(["provider-declined", "provider-cancelled", "provider-refused"]),
  }),
]).annotate({ identifier: "RefundAttempt" });
export type RefundAttempt = typeof RefundAttempt.Type;

/** Closed support failures contain neither provider payloads nor persistence diagnostics. */
export const RefundStartFailure = Schema.Literals([
  "unsupported",
  "charge-unavailable",
  "amount-exceeds-remaining",
  "currency-mismatch",
  "idempotency-conflict",
  "limited",
  "unavailable",
]).annotate({ identifier: "RefundStartFailure" });
export type RefundStartFailure = typeof RefundStartFailure.Type;

/** Fixed post-boundary Pro continuation for an unstopped Subscription; paid history is unchanged. */
export const renewalGraceMs = 259_200_000;

/** Retained cancellation stops future collection while preserving the already-paid interval. */
export const SubscriptionCancellation = Schema.Struct({
  cancelledAt: UtcTimestamp,
  paidThrough: UtcTimestamp,
  sourceCancellation: Schema.Literals(["detached", "void-pending", "voided"]),
}).annotate({ identifier: "SubscriptionCancellation" });
export type SubscriptionCancellation = typeof SubscriptionCancellation.Type;
