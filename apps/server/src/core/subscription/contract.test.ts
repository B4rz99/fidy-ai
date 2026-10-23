import { expect, it } from "vitest";
import { Schema } from "effect";
import { RefundStartFailure, SubscriptionCancellation } from "./contract";

it("retains closed refund refusals and provider cancellation progress", () => {
  for (const value of [
    "unsupported",
    "charge-unavailable",
    "amount-exceeds-remaining",
    "currency-mismatch",
    "idempotency-conflict",
    "limited",
    "unavailable",
  ]) {
    expect(Schema.decodeUnknownSync(RefundStartFailure)(value)).toBe(value);
  }
  for (const sourceCancellation of ["detached", "void-pending", "voided"]) {
    const value = {
      cancelledAt: "2026-10-01T00:00:00.000Z",
      paidThrough: "2026-11-01T00:00:00.000Z",
      sourceCancellation,
    };
    const codec = Schema.toCodecJson(SubscriptionCancellation);
    expect(Schema.encodeSync(codec)(Schema.decodeSync(codec)(value))).toEqual(value);
  }
});
