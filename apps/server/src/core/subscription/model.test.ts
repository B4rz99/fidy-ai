import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { Price, SubscriptionOffers } from "./model";

const price = (
  id: string,
  billingPeriod: "weekly" | "monthly" | "yearly",
  amount: string
): typeof Price.Encoded => ({
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

const weekly = price("22700000-0000-4000-8000-000000000001", "weekly", "9900");
const monthly = price("22700000-0000-4000-8000-000000000002", "monthly", "28900");
const yearly = price("22700000-0000-4000-8000-000000000003", "yearly", "289900");

it("accepts the exact ordered launch Subscription offers", () => {
  const decoded = Schema.decodeUnknownResult(SubscriptionOffers)([weekly, monthly, yearly]);

  expect(Result.isSuccess(decoded)).toBe(true);
});

it("rejects a Price that is free or not denominated in COP", () => {
  const free = Schema.decodeUnknownResult(Price)({
    ...weekly,
    money: { amount: "0", currency: "COP" },
  });
  const foreignCurrency = Schema.decodeUnknownResult(Price)({
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
  const unsupportedMethod = Schema.decodeUnknownResult(Price)({
    ...weekly,
    paymentMethods: ["card", "pse", "daviplata"],
  });

  expect(Result.isFailure(reorderedPeriods) ? String(reorderedPeriods.failure) : "").toContain(
    'at [0]["billingPeriod"]'
  );
  expect(Result.isFailure(unsupportedMethod)).toBe(true);
});

it("rejects duplicate Price identities and reports the identity failure path", () => {
  const duplicateIdentity = Schema.decodeUnknownResult(SubscriptionOffers)([
    weekly,
    monthly,
    { ...yearly, id: monthly.id },
  ]);

  expect(Result.isFailure(duplicateIdentity) ? String(duplicateIdentity.failure) : "").toContain(
    'at ["id"]'
  );
});

it("reports the ordering path when an authoritative offer check sees a missing period", () => {
  const checkableOffers = SubscriptionOffers.mapElements(
    () => [Schema.Unknown, Schema.Unknown, Schema.Unknown] as const,
    { unsafePreserveChecks: true }
  );
  const missingPeriod = Schema.decodeUnknownResult(checkableOffers)([
    { id: weekly.id, billingPeriod: "weekly" },
    { id: monthly.id, billingPeriod: "monthly" },
    undefined,
  ]);

  expect(Result.isFailure(missingPeriod) ? String(missingPeriod.failure) : "").toContain(
    'at [2]["billingPeriod"]'
  );
});
