import { expect, it } from "vitest";
import { Schema } from "effect";
import { ConsentIngressExchange, PATRevocationOrigin } from "./contract";

it("retains evidence at each Consent ingress phase", () => {
  const identity = {
    initiatingMessageId: "message",
    initiatingBodySha256: "a".repeat(64),
    businessPhoneNumberId: "12345",
    expiresAtMs: 10000,
  };
  const proof = {
    disclosureMessageId: "disclosure",
    disclosedAtMs: 1000,
    decisionNotBeforeMs: 2000,
  };
  const phases = [
    ...["awaiting_delivery", "outbound_started"].map((stage) => ({
      _tag: "BeforeDelivery",
      stage,
      disclosureMessageId: null,
    })),
    { _tag: "AwaitingDecision", ...proof },
    ...["accepted", "declined"].map((decision) => ({ _tag: "Settled", decision, ...proof })),
  ];
  for (const phase of phases) {
    const value = { ...identity, phase };
    expect(
      Schema.encodeSync(ConsentIngressExchange)(
        Schema.decodeUnknownSync(ConsentIngressExchange)(value)
      )
    ).toEqual(value);
  }
  for (const origin of [
    "user-revoke-one",
    "user-revoke-all",
    "user-revoke-unclaimed",
    "approved-unclaimed-expiry",
    "fixed-lifetime-expiry",
  ]) {
    expect(Schema.decodeUnknownSync(PATRevocationOrigin)(origin)).toBe(origin);
  }
});
