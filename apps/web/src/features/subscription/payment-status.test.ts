import { Schema } from "effect";
import { expect, it } from "vitest";
import { PaymentEnrollmentId, PaymentSubmission, PriceId } from "@/transport/client";
import {
  isAwaitingPaymentStatus,
  paymentStatusRefreshDelay,
  paymentSubmissionIsTerminal,
} from "./payment-status";

const enrollmentId = PaymentEnrollmentId.make("22700000-0000-4000-8000-000000000090");

const defaultBillingAttemptFixture = {
  id: "22700000-0000-4000-8000-000000000091",
  priceId: PriceId.make("22700000-0000-4000-8000-000000000002"),
  money: { amount: "28900", currency: "COP" as const },
  billingPeriod: "monthly" as const,
  serviceMarket: "CO" as const,
  taxTreatment: "not-taxable" as const,
  timeZone: "America/Bogota",
  createdAt: "2026-03-01T00:00:00Z",
  status: "pending" as const,
};

const paymentSubmissionFixture = (
  billingAttemptOverrides: Partial<Readonly<{ status: "pending" | "failed" | "succeeded" }>> = {}
): Extract<PaymentSubmission, { status: "payment-pending" }> => {
  const fixture = { ...defaultBillingAttemptFixture, ...billingAttemptOverrides };
  const commonBillingAttempt = {
    id: fixture.id,
    priceId: fixture.priceId,
    money: fixture.money,
    billingPeriod: fixture.billingPeriod,
    serviceMarket: fixture.serviceMarket,
    taxTreatment: fixture.taxTreatment,
    timeZone: fixture.timeZone,
    createdAt: fixture.createdAt,
  };
  let submission: PaymentSubmission;
  if (fixture.status === "succeeded") {
    submission = Schema.decodeSync(PaymentSubmission)({
      status: "payment-pending",
      enrollmentId,
      billingAttempt: {
        ...commonBillingAttempt,
        status: "succeeded",
        finalizedAt: "2026-03-01T00:01:00Z",
        paidPeriodEndsAt: "2026-04-01T00:01:00Z",
        renewalAnchor: "2026-04-01T00:01:00Z",
      },
    });
  } else if (fixture.status === "failed") {
    submission = Schema.decodeSync(PaymentSubmission)({
      status: "payment-pending",
      enrollmentId,
      billingAttempt: {
        ...commonBillingAttempt,
        status: "failed",
        failedAt: "2026-03-01T00:01:00Z",
      },
    });
  } else {
    submission = Schema.decodeSync(PaymentSubmission)({
      status: "payment-pending",
      enrollmentId,
      billingAttempt: { ...commonBillingAttempt, status: "pending" },
    });
  }
  if (submission.status !== "payment-pending") {
    throw new Error("payment submission fixture did not decode");
  }
  return submission;
};

it("uses adaptive payment-status refresh intervals", () => {
  const firstBackoffRefresh = 3;
  const finalBackoffRefresh = 9;
  expect(paymentStatusRefreshDelay(0)).toBe("1 second");
  expect(paymentStatusRefreshDelay(firstBackoffRefresh)).toBe("5 seconds");
  expect(paymentStatusRefreshDelay(finalBackoffRefresh)).toBe("10 seconds");
});

it("refreshes only nonterminal payment submissions", () => {
  expect(
    isAwaitingPaymentStatus({
      status: "source-verifying",
      enrollmentId,
    })
  ).toBe(true);
  expect(isAwaitingPaymentStatus(paymentSubmissionFixture())).toBe(true);
  expect(isAwaitingPaymentStatus(paymentSubmissionFixture({ status: "succeeded" }))).toBe(false);
  expect(
    isAwaitingPaymentStatus({
      status: "refused",
      enrollmentId,
      reason: "provider-declined",
    })
  ).toBe(false);
});

it("releases retained payment requests only for terminal submissions", () => {
  const pending = paymentSubmissionFixture();
  const succeeded = paymentSubmissionFixture({ status: "succeeded" });
  expect(paymentSubmissionIsTerminal(pending)).toBe(false);
  expect(paymentSubmissionIsTerminal(succeeded)).toBe(true);
  expect(
    paymentSubmissionIsTerminal({
      status: "source-verifying",
      enrollmentId,
    })
  ).toBe(false);
  expect(
    paymentSubmissionIsTerminal({
      status: "refused",
      enrollmentId,
      reason: "provider-declined",
    })
  ).toBe(true);
});
