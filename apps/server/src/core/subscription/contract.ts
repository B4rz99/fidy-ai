import { canonicalEmailAddressChecks } from "~/core/email-authentication/contract";
import { BigDecimal, Schema, SchemaTransformation } from "effect";
import { IanaTimeZone, ServiceMarket } from "~/core/_shared/context";
import { Money, type ReadonlyMoney } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";
import { TrialPeriod, UserId } from "~/core/identity/contract";
import { AccessTier } from "~/core/access-tier/contract";

export const PriceId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PriceId"))
  .annotate({ identifier: "PriceId" });

export type PriceId = typeof PriceId.Type;

export const UpgradeDestination = Schema.Struct({
  url: Schema.URLFromString,
}).annotate({ identifier: "UpgradeDestination" });

export type UpgradeDestination = typeof UpgradeDestination.Type;

export const BillingPeriod = Schema.Literals(["weekly", "monthly", "yearly"]).annotate({
  identifier: "BillingPeriod",
});

export type BillingPeriod = typeof BillingPeriod.Type;

export const TaxTreatment = Schema.Literal("not-taxable").annotate({
  identifier: "TaxTreatment",
});

export type TaxTreatment = typeof TaxTreatment.Type;

export const LaunchPaymentMethods = Schema.Tuple([
  Schema.Literal("card"),
  Schema.Literal("nequi"),
  Schema.Literal("daviplata"),
]).annotate({ identifier: "LaunchPaymentMethods" });

export type LaunchPaymentMethods = typeof LaunchPaymentMethods.Type;

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

export const SubscriptionOffers = Schema.Tuple([Price, Price, Price])
  .check(authoritativeOfferSet)
  .annotate({ identifier: "SubscriptionOffers" });

export type SubscriptionOffers = typeof SubscriptionOffers.Type;

export const SubscriptionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("SubscriptionId"))
  .annotate({ identifier: "SubscriptionId" });

export type SubscriptionId = typeof SubscriptionId.Type;

export const PaymentRequestId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PaymentRequestId"))
  .annotate({ identifier: "PaymentRequestId" });

export type PaymentRequestId = typeof PaymentRequestId.Type;

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

export const PendingBillingAttempt = Schema.Struct({
  status: Schema.Literal("pending"),
  ...BillingAttemptSnapshot,
});

export const FailedBillingAttempt = Schema.Struct({
  status: Schema.Literal("failed"),
  ...BillingAttemptSnapshot,
  failedAt: UtcTimestamp,
});

export const SucceededBillingAttempt = Schema.Struct({
  status: Schema.Literal("succeeded"),
  ...BillingAttemptSnapshot,
  finalizedAt: UtcTimestamp,
  paidPeriodEndsAt: UtcTimestamp,
  renewalAnchor: UtcTimestamp,
});

export const BillingAttempt = Schema.Union([
  PendingBillingAttempt,
  FailedBillingAttempt,
  SucceededBillingAttempt,
]).annotate({ identifier: "BillingAttempt" });

export type BillingAttempt = typeof BillingAttempt.Type;

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

export const SubscriptionCancellation = Schema.Struct({
  cancelledAt: UtcTimestamp,
  paidThrough: UtcTimestamp,
  sourceCancellation: Schema.Literals(["detached", "void-pending", "voided"]),
}).annotate({ identifier: "SubscriptionCancellation" });

export type SubscriptionCancellation = typeof SubscriptionCancellation.Type;

const maximumRecentBillingAttempts = 10;

export const SubscriptionStatus = Schema.Struct({
  accessTier: AccessTier,
  hasProGrant: Schema.Boolean,
  trialPeriod: TrialPeriod,
  paidSubscription: Schema.OptionFromNullOr(PaidSubscription),
  cancellation: Schema.OptionFromNullOr(SubscriptionCancellation),
  recentAttempts: Schema.Array(BillingAttempt).check(
    Schema.isMaxLength(maximumRecentBillingAttempts)
  ),
}).annotate({ identifier: "SubscriptionStatus" });

export type SubscriptionStatus = typeof SubscriptionStatus.Type;

export const EnrollmentMethod = Schema.Literals(["card", "nequi", "daviplata"]).annotate({
  identifier: "EnrollmentMethod",
});

export type EnrollmentMethod = typeof EnrollmentMethod.Type;

export const EnrollmentAvailability = Schema.Struct({
  enabledMethods: Schema.UniqueArray(EnrollmentMethod).check(Schema.isMaxLength(3)),
}).annotate({ identifier: "EnrollmentAvailability" });

export type EnrollmentAvailability = typeof EnrollmentAvailability.Type;

const DaviplataOtpEndpoint = Schema.String.check(
  Schema.isPattern(
    /^https:\/\/(?:(?:sandbox|production)\.wompi\.co\/[A-Za-z0-9/_-]{1,200}|api-sandbox\.wompi\.co\/v1\/webhook_events\/daviplata_response\/sandbox)$/u
  )
);

export const DaviplataOtpPolicy = Schema.Struct({
  sendUrl: DaviplataOtpEndpoint,
  confirmUrl: DaviplataOtpEndpoint,
}).annotate({ identifier: "DaviplataOtpPolicy" });

export type DaviplataOtpPolicy = typeof DaviplataOtpPolicy.Type;

export const maximumEnrollmentEvidenceCharacters = 4096;

export const maximumTransientPaymentTokenCharacters = 4096;

const sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const providerContentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32,128}$/u));

const boundedEvidenceText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumEnrollmentEvidenceCharacters)
);

export const PaymentEnrollmentId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PaymentEnrollmentId"))
  .annotate({ identifier: "PaymentEnrollmentId" });

export type PaymentEnrollmentId = typeof PaymentEnrollmentId.Type;

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

export const EndUserPolicyEvidence = Schema.Struct({
  kind: Schema.Literal("end-user-policy"),
  ...wompiContractEvidenceFields,
});

export const PersonalDataAuthorizationEvidence = Schema.Struct({
  kind: Schema.Literal("personal-data-authorization"),
  ...wompiContractEvidenceFields,
});

export const WompiContractEvidence = Schema.Union([
  EndUserPolicyEvidence,
  PersonalDataAuthorizationEvidence,
]).annotate({ identifier: "WompiContractEvidence" });

export type WompiContractEvidence = typeof WompiContractEvidence.Type;

export const WompiContractEvidenceSet = Schema.Struct({
  endUserPolicy: EndUserPolicyEvidence,
  personalDataAuthorization: PersonalDataAuthorizationEvidence,
}).annotate({ identifier: "WompiContractEvidenceSet" });

export type WompiContractEvidenceSet = typeof WompiContractEvidenceSet.Type;

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
  billingEmail: Schema.Union([BillingEmail, Schema.Literal("")]),
  contracts: WompiContractEvidenceSet,
  recurringDisclosure: RecurringDisclosure,
  wompiPublicKey: Schema.String.check(Schema.isPattern(/^pub_(?:test|prod)_[A-Za-z0-9_-]+$/u)),
  paymentSourceMode: Schema.Literals(["create", "reuse"]),
  expiresAt: UtcTimestamp,
} as const;

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

export const PaymentEnrollment = Schema.Union([
  PreparedPaymentEnrollment,
  CreatingPaymentEnrollment,
  AvailablePaymentEnrollment,
  RefusedPaymentEnrollment,
  ExpiredPaymentEnrollment,
  VerifyingPaymentEnrollment,
]).annotate({ identifier: "PaymentEnrollment" });

export type PaymentEnrollment = typeof PaymentEnrollment.Type;

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

export const RefundAttemptId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("RefundAttemptId"))
  .annotate({ identifier: "RefundAttemptId" });

export type RefundAttemptId = typeof RefundAttemptId.Type;

export const RefundRequestId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("RefundRequestId"))
  .annotate({ identifier: "RefundRequestId" });

export type RefundRequestId = typeof RefundRequestId.Type;

export const RefundMoney = Money.check(
  Schema.makeFilter<ReadonlyMoney>(
    (money) => BigDecimal.Order(money.amount, zero) > 0 || "Refund Money must be greater than zero"
  )
).annotate({ identifier: "RefundMoney" });

export type RefundMoney = typeof RefundMoney.Type;

export const RefundReason = Schema.Literals([
  "user-request",
  "duplicate-collection",
  "service-error",
]).annotate({ identifier: "RefundReason" });

export const RefundIntent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("refund"), money: RefundMoney }),
  Schema.Struct({ kind: Schema.Literal("card-void") }),
]).annotate({ identifier: "RefundIntent" });

export type RefundIntent = typeof RefundIntent.Type;

export const StartRefundInput = Schema.Struct({
  userId: UserId,
  billingAttemptId: BillingAttemptId,
  requestId: RefundRequestId,
  intent: RefundIntent,
  reason: RefundReason,
}).annotate({ identifier: "StartRefundInput" });

export type StartRefundInput = typeof StartRefundInput.Type;

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

export const renewalGraceMs = 259_200_000;
