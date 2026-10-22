import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  DaviplataOtpPolicy,
  EnrollmentDecisions,
  PaymentEnrollment,
  PaymentSubmission,
  PreparedPaymentEnrollment,
  Price,
  SubscriptionOffers,
  WompiContractEvidence,
} from "./contract";

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
  const decoded = Schema.decodeResult(SubscriptionOffers)([weekly, monthly, yearly]);

  expect(Result.isSuccess(decoded)).toBe(true);
});

it("rejects a Price that is free or not denominated in COP", () => {
  const free = Schema.decodeResult(Price)({
    ...weekly,
    money: { amount: "0", currency: "COP" },
  });
  const foreignCurrency = Schema.decodeResult(Price)({
    ...weekly,
    money: { amount: "9.9", currency: "USD" },
  });

  expect(Result.isFailure(free) ? String(free.failure) : "").toContain('["money"]["amount"]');
  expect(Result.isFailure(foreignCurrency) ? String(foreignCurrency.failure) : "").toContain(
    '["money"]["currency"]'
  );
});

it("rejects reordered periods and payment methods outside the launch set", () => {
  const reorderedPeriods = Schema.decodeResult(SubscriptionOffers)([monthly, weekly, yearly]);
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
  const duplicateIdentity = Schema.decodeResult(SubscriptionOffers)([
    weekly,
    monthly,
    { ...yearly, id: monthly.id },
  ]);

  expect(Result.isFailure(duplicateIdentity) ? String(duplicateIdentity.failure) : "").toContain(
    'at ["id"]'
  );
});

it("preserves the displayed enrollment contracts and independently required authorization decisions", () => {
  const evidence = {
    permalink: "https://example.com/terms",
    displayedText: "Condiciones mostradas",
    contentSha256: "a".repeat(64),
    providerContentHash: "b".repeat(32),
    observedAt: "2026-10-22T12:00:00.000Z",
  };
  const prepared = {
    status: "prepared",
    enrollmentId: weekly.id,
    method: "card",
    price: weekly,
    billingEmail: "payer@example.com",
    contracts: {
      endUserPolicy: { ...evidence, kind: "end-user-policy" },
      personalDataAuthorization: { ...evidence, kind: "personal-data-authorization" },
    },
    recurringDisclosure: {
      revision: "wompi-card-enrollment-v2",
      displayedText: "Cobros periódicos autorizados",
      contentSha256: "c".repeat(64),
    },
    wompiPublicKey: "pub_test_key",
    paymentSourceMode: "create",
    expiresAt: "2026-10-22T12:15:00.000Z",
  };
  expect(
    Schema.encodeSync(PreparedPaymentEnrollment)(
      Schema.decodeUnknownSync(PreparedPaymentEnrollment)(prepared)
    )
  ).toEqual(prepared);
  const decisions = {
    acceptedEndUserPolicy: true,
    acceptedPersonalDataAuthorization: true,
    authorizedRecurringCharges: true,
  };
  expect(Result.isSuccess(Schema.decodeUnknownResult(EnrollmentDecisions)(decisions))).toBe(true);
  for (const key of [
    "acceptedEndUserPolicy",
    "acceptedPersonalDataAuthorization",
    "authorizedRecurringCharges",
  ] as const) {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(EnrollmentDecisions)({ ...decisions, [key]: false })
      )
    ).toBe(true);
  }
  const decodeEvidence = Schema.decodeUnknownResult(WompiContractEvidence);
  for (const kind of ["end-user-policy", "personal-data-authorization"]) {
    expect(Result.isSuccess(decodeEvidence({ ...evidence, kind }))).toBe(true);
  }
  for (const contentSha256 of [
    "a".repeat(63),
    "a".repeat(65),
    "z".repeat(64),
    `x${"a".repeat(64)}`,
    `${"a".repeat(64)}x`,
  ]) {
    expect(
      Result.isFailure(decodeEvidence({ ...evidence, kind: "end-user-policy", contentSha256 }))
    ).toBe(true);
  }
  expect(
    Result.isSuccess(
      decodeEvidence({ ...evidence, kind: "end-user-policy", providerContentHash: "f".repeat(128) })
    )
  ).toBe(true);
  for (const providerContentHash of [
    "a".repeat(31),
    "a".repeat(129),
    "z".repeat(32),
    `x${"a".repeat(32)}`,
    `${"a".repeat(32)}x`,
  ]) {
    expect(
      Result.isFailure(
        decodeEvidence({ ...evidence, kind: "end-user-policy", providerContentHash })
      )
    ).toBe(true);
  }
});

it("round trips pending payment submission and terminal enrollment outcomes without provider authority", () => {
  const attempt = {
    status: "pending",
    id: weekly.id,
    priceId: weekly.id,
    money: weekly.money,
    billingPeriod: "weekly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    timeZone: "America/Bogota",
    createdAt: "2026-10-22T12:00:00.000Z",
  };
  const submission = {
    status: "payment-pending",
    enrollmentId: weekly.id,
    billingAttempt: attempt,
  };
  expect(
    Schema.encodeSync(PaymentSubmission)(Schema.decodeUnknownSync(PaymentSubmission)(submission))
  ).toEqual(submission);
  for (const status of ["creating", "available", "expired", "verifying", "refused"]) {
    const value = {
      status,
      enrollmentId: weekly.id,
      method: "card",
      priceId: weekly.id,
      ...(status === "refused" ? { reason: "provider-declined" } : {}),
    };
    expect(
      Schema.encodeSync(PaymentEnrollment)(Schema.decodeUnknownSync(PaymentEnrollment)(value))
    ).toEqual(value);
  }
  expect(
    Result.isSuccess(
      Schema.decodeResult(PaymentSubmission)({
        status: "refused",
        enrollmentId: weekly.id,
        reason: "expired",
      })
    )
  ).toBe(true);
});

it("bounds DaviPlata OTP destinations to reviewed query-free Wompi paths", () => {
  const decode = Schema.decodeUnknownResult(DaviplataOtpPolicy);
  for (const url of [
    "https://sandbox.wompi.co/a_b-9",
    "https://production.wompi.co/path/OTP",
    "https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox",
  ]) {
    expect(Result.isSuccess(decode({ sendUrl: url, confirmUrl: url }))).toBe(true);
  }
  for (const url of [
    "http://sandbox.wompi.co/a",
    "https://evil.example/a",
    "xhttps://sandbox.wompi.co/a",
    "https://sandbox.wompi.co/a?token=x",
    "https://sandbox.wompi.co/",
    `https://sandbox.wompi.co/${"a".repeat(201)}`,
  ]) {
    expect(Result.isFailure(decode({ sendUrl: url, confirmUrl: url }))).toBe(true);
  }
});
