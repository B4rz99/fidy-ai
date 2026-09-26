import { expect, it } from "vitest";
import { Option } from "effect";
import { projectSubscriptionOffers, projectSubscriptionStatus } from "./queries";

const trial = {
  started_at_ms: Date.parse("2026-09-01T12:00:00Z"),
  trial_ends_at_ms: Date.parse("2026-09-08T12:00:00Z"),
  price_id: null,
  amount: null,
  currency: null,
  billing_period: null,
  service_market: null,
  tax_treatment: null,
  starts_at_ms: null,
  ends_at_ms: null,
  renewal_anchor_ms: null,
};

it("ends the original TrialPeriod at its half-open boundary without hiding history", () => {
  const result = projectSubscriptionStatus({
    standingRow: trial,
    attemptRows: [],
    now: trial.trial_ends_at_ms,
  });
  expect(result.accessTier).toBe("free");
  expect(result.trialPeriod.endsAt.epochMilliseconds).toBe(trial.trial_ends_at_ms);
  expect(Option.isNone(result.paidSubscription)).toBe(true);
});

it("derives Pro from a paid period while exposing its exact immutable Price snapshot", () => {
  const result = projectSubscriptionStatus({
    standingRow: {
      ...trial,
      price_id: "22700000-0000-4000-8000-000000000001",
      amount: "9900",
      currency: "COP",
      billing_period: "weekly",
      service_market: "CO",
      tax_treatment: "not-taxable",
      starts_at_ms: Date.parse("2026-09-09T12:00:00Z"),
      ends_at_ms: Date.parse("2026-09-16T12:00:00Z"),
      renewal_anchor_ms: Date.parse("2026-09-16T12:00:00Z"),
    },
    attemptRows: [],
    now: Date.parse("2026-09-10T12:00:00Z"),
  });
  expect(result.accessTier).toBe("pro");
  expect(Option.isSome(result.paidSubscription)).toBe(true);
  if (Option.isSome(result.paidSubscription)) {
    expect(result.paidSubscription.value.money.currency).toBe("COP");
    expect(result.paidSubscription.value.endsAt.epochMilliseconds).toBe(
      Date.parse("2026-09-16T12:00:00Z")
    );
  }
});

it("rejects an incomplete offer set rather than presenting partial Prices", () => {
  expect(() => projectSubscriptionOffers([])).toThrow();
});
