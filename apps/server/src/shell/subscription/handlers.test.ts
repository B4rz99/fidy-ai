import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { encodeMoneyAmount } from "~/core/_shared/money";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Subscription access",
  (it) => {
    it.effect("returns the configured Free-callable upgrade destination", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;

        const response = yield* client.subscription.getUpgradeUrl();

        expect(response.data.url).toEqual(new URL("https://fidyapp.com/upgrade"));
        expect(response.next).toEqual([]);
      })
    );

    it.effect("returns the three authoritative Colombia PriceRevisions", () =>
      Effect.gen(function* () {
        const client = yield* ApiHarnessClient;

        const response = yield* client.subscription.listSubscriptionOffers();

        expect(
          response.data.map((revision) => ({
            id: revision.id,
            amount: encodeMoneyAmount(revision.money.amount),
            currency: revision.money.currency,
            billingPeriod: revision.billingPeriod,
            serviceMarket: revision.serviceMarket,
            taxTreatment: revision.taxTreatment,
            renewalTerms: revision.renewalTerms,
            paymentMethods: revision.paymentMethods,
          }))
        ).toEqual([
          {
            id: "22700000-0000-4000-8000-000000000001",
            amount: "9900",
            currency: "COP",
            billingPeriod: "weekly",
            serviceMarket: "CO",
            taxTreatment: "not-taxable",
            renewalTerms: {
              automaticRenewal: true,
              renewalReminder: "none",
              cancellation: "future-renewals-only",
              paidAccessEnds: "paid-period-end",
            },
            paymentMethods: ["card", "nequi", "daviplata"],
          },
          {
            id: "22700000-0000-4000-8000-000000000002",
            amount: "28900",
            currency: "COP",
            billingPeriod: "monthly",
            serviceMarket: "CO",
            taxTreatment: "not-taxable",
            renewalTerms: {
              automaticRenewal: true,
              renewalReminder: "none",
              cancellation: "future-renewals-only",
              paidAccessEnds: "paid-period-end",
            },
            paymentMethods: ["card", "nequi", "daviplata"],
          },
          {
            id: "22700000-0000-4000-8000-000000000003",
            amount: "289900",
            currency: "COP",
            billingPeriod: "yearly",
            serviceMarket: "CO",
            taxTreatment: "not-taxable",
            renewalTerms: {
              automaticRenewal: true,
              renewalReminder: "none",
              cancellation: "future-renewals-only",
              paidAccessEnds: "paid-period-end",
            },
            paymentMethods: ["card", "nequi", "daviplata"],
          },
        ]);
        expect(response.next).toEqual([]);
      })
    );
  }
);
