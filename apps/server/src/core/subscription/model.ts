import { BigDecimal, Schema } from "effect";
import { ServiceMarket } from "~/core/_shared/context";
import { Money } from "~/core/_shared/money";
import { PriceRevisionId } from "./reference";

export { PriceRevisionId } from "./reference";

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
    return { path: ["money", "amount"], issue: "PriceRevision Money must be greater than zero" };
  }
  return revision.money.currency === "COP"
    ? undefined
    : { path: ["money", "currency"], issue: "Colombia PriceRevision Money must use COP" };
});

/** One immutable authoritative version of Subscription price and renewal terms. */
export const PriceRevision = Schema.Struct({
  id: PriceRevisionId,
  money: Money,
  billingPeriod: BillingPeriod,
  serviceMarket: ServiceMarket,
  taxTreatment: TaxTreatment,
  renewalTerms: RenewalTerms,
  paymentMethods: LaunchPaymentMethods,
})
  .check(colombiaPaidOffer)
  .annotate({ identifier: "PriceRevision" });
export type PriceRevision = typeof PriceRevision.Type;

const subscriptionOfferPeriodOrder: ReadonlyArray<BillingPeriod> = ["weekly", "monthly", "yearly"];
type OfferIdentityAndPeriod = Readonly<{
  id: PriceRevision["id"];
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
    : { path: ["id"], issue: "Subscription offers must have distinct PriceRevision identities" };
});

/** Exact authoritative offer set in weekly, monthly, yearly presentation order. */
export const SubscriptionOffers = Schema.Tuple([PriceRevision, PriceRevision, PriceRevision])
  .check(authoritativeOfferSet)
  .annotate({ identifier: "SubscriptionOffers" });
export type SubscriptionOffers = typeof SubscriptionOffers.Type;
