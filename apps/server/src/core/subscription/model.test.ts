import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { PriceRevision, SubscriptionOffers } from "./model";

const priceRevision = (
  id: string,
  billingPeriod: "weekly" | "monthly" | "yearly",
  amount: string
): typeof PriceRevision.Encoded => ({
  id,
  money: { amount, currency: "COP" },
  billingPeriod,
  serviceMarket: "CO",
  taxTreatment: "not-taxable",
  renewalTerms: {
    automaticRenewal: true,
    renewalReminder: "none",
    cancellation: "future-renewals-only",
    paidAccessEnds: "paid-period-end",
  },
  paymentMethods: ["card", "nequi", "daviplata"],
});

const weekly = priceRevision("22700000-0000-4000-8000-000000000001", "weekly", "9900");
const monthly = priceRevision("22700000-0000-4000-8000-000000000002", "monthly", "28900");
const yearly = priceRevision("22700000-0000-4000-8000-000000000003", "yearly", "289900");

it("accepts the exact ordered launch Subscription offers", () => {
  const decoded = Schema.decodeUnknownResult(SubscriptionOffers)([weekly, monthly, yearly]);

  expect(Result.isSuccess(decoded)).toBe(true);
});

it("rejects a PriceRevision that is free or not denominated in COP", () => {
  const free = Schema.decodeUnknownResult(PriceRevision)({
    ...weekly,
    money: { amount: "0", currency: "COP" },
  });
  const foreignCurrency = Schema.decodeUnknownResult(PriceRevision)({
    ...weekly,
    money: { amount: "9.9", currency: "USD" },
  });

  expect(Result.isFailure(free) ? String(free.failure) : "").toContain('["money"]["amount"]');
  expect(Result.isFailure(foreignCurrency) ? String(foreignCurrency.failure) : "").toContain(
    '["money"]["currency"]'
  );
});

it("rejects reordered periods and payment methods outside the launch set", () => {
  const reorderedPeriods = Schema.decodeUnknownResult(SubscriptionOffers)([
    monthly,
    weekly,
    yearly,
  ]);
  const unsupportedMethod = Schema.decodeUnknownResult(PriceRevision)({
    ...weekly,
    paymentMethods: ["card", "pse", "daviplata"],
  });

  expect(Result.isFailure(reorderedPeriods)).toBe(true);
  expect(Result.isFailure(unsupportedMethod)).toBe(true);
});
