import { BigDecimal, Schema } from "effect";
import { IanaTimeZone, ServiceMarket } from "~/core/_shared/context";
import { Money } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";
import { PriceId } from "./reference";

export { PriceId } from "./reference";

/** Subscription-owned private fact recording whether paid Pro access is active. */
export const SubscriptionStanding = Schema.Struct({
  paidProActive: Schema.Boolean,
}).annotate({ identifier: "SubscriptionStanding" });
export type SubscriptionStanding = typeof SubscriptionStanding.Type;

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

/** Private Wompi merchant reference used only to correlate authenticated provider evidence. */
export const WompiTransactionReference = Schema.String.check(
  Schema.isPattern(/^fidy-[0-9a-f-]{36}$/u)
)
  .pipe(Schema.brand("WompiTransactionReference"))
  .annotate({ identifier: "WompiTransactionReference" });
export type WompiTransactionReference = typeof WompiTransactionReference.Type;

const maximumWompiTransactionIdCharacters = 128;

/** Private Wompi transaction identity retained only behind the Subscription shell seam. */
export const WompiTransactionId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumWompiTransactionIdCharacters)
)
  .pipe(Schema.brand("WompiTransactionId"))
  .annotate({ identifier: "WompiTransactionId" });
export type WompiTransactionId = typeof WompiTransactionId.Type;

/** Provider environment snapshotted with each BillingAttempt and checked during settlement. */
export const WompiEnvironment = Schema.Literals(["sandbox", "production"]).annotate({
  identifier: "WompiEnvironment",
});
export type WompiEnvironment = typeof WompiEnvironment.Type;

/** Provider transaction state accepted from bounded Wompi responses and signed events. */
export const WompiBillingStatus = Schema.Literals([
  "PENDING",
  "APPROVED",
  "DECLINED",
  "VOIDED",
  "ERROR",
]);
export type WompiBillingStatus = typeof WompiBillingStatus.Type;

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
