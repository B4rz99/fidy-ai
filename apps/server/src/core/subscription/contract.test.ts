import { expect, it } from "vitest";
import { Schema } from "effect";
import { SubscriptionCancellation } from "./contract";

it("preserves cancellation instants and provider progress on the wire", () => {
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
