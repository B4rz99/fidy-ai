import { expect, it } from "vitest";
import { BigDecimal, Option, Result, Schema } from "effect";
import { Money } from "~/core/_shared/money";
import { RefundAttempt, RefundIntent } from "./contract";
import { refundMinorUnits } from "./operations";

it("preserves exact COP minor units and refuses unsafe or fractional provider integers", () => {
  expect(refundMinorUnits(Schema.decodeSync(Money)({ amount: "0.29", currency: "COP" }))).toEqual(
    Option.some(29)
  );
  expect(refundMinorUnits({ amount: BigDecimal.make(1001n, 3), currency: "COP" })).toEqual(
    Option.none()
  );
  expect(
    refundMinorUnits(Schema.decodeSync(Money)({ amount: "90071992547409.92", currency: "COP" }))
  ).toEqual(Option.none());
});
it("refuses zero and excessive precision without inventing partial card voids", () => {
  expect(
    Schema.decodeOption(RefundIntent)({
      kind: "refund",
      money: { amount: "0", currency: "COP" },
    })
  ).toEqual(Option.none());
  expect(
    Schema.decodeOption(RefundIntent)({
      kind: "refund",
      money: { amount: "1.001", currency: "COP" },
    })
  ).toEqual(Option.none());
});

it("refuses foreign or zero refund Money and accepts the exact largest safe minor-unit value", () => {
  expect(refundMinorUnits(Schema.decodeSync(Money)({ amount: "0", currency: "COP" }))).toEqual(
    Option.none()
  );
  expect(refundMinorUnits(Schema.decodeSync(Money)({ amount: "1", currency: "USD" }))).toEqual(
    Option.none()
  );
  expect(
    refundMinorUnits(Schema.decodeSync(Money)({ amount: "90071992547409.91", currency: "COP" }))
  ).toEqual(Option.some(Number.MAX_SAFE_INTEGER));
});

it("round trips positive retained refund outcomes with their closed correction treatment", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const snapshot = {
    id,
    userId: id,
    subscriptionId: id,
    billingAttemptId: id,
    priceId: id,
    kind: "refund",
    money: { amount: "100", currency: "COP" },
    requestId: id,
    reason: "user-request",
    treatment: {
      policyId: "refund-ends-paid-period-v1",
      taxTreatment: "not-taxable",
      paidPeriodEffect: "end-refunded-period-at-verification",
      renewalEffect: "stop-future-renewals",
      accounting: { kind: "sandbox-only" },
    },
    createdAt: "2026-10-22T12:00:00.000Z",
  };
  for (const outcome of [
    { status: "pending", progress: "outcome-unknown" },
    { status: "succeeded", verifiedAt: "2026-10-22T12:01:00.000Z" },
    { status: "failed", failedAt: "2026-10-22T12:01:00.000Z", failure: "provider-refused" },
  ]) {
    const value = { ...snapshot, ...outcome };
    expect(
      Schema.encodeSync(RefundAttempt)(Schema.decodeUnknownSync(RefundAttempt)(value))
    ).toEqual(value);
  }
  expect(
    Result.isSuccess(
      Schema.decodeResult(RefundIntent)({
        kind: "refund",
        money: { amount: "0.01", currency: "COP" },
      })
    )
  ).toBe(true);
});
