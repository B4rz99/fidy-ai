import { expect, it } from "vitest";
import { Schema } from "effect";
import { ConsentIngressExchange, PATRevocationOrigin } from "~/core/consent/contract";

it("retains evidence at each Consent ingress phase", () => {
  const identity = {
    initiatingMessageId: "message",
    initiatingBodySha256: "a".repeat(64),
    businessPhoneNumberId: "12345",
    expiresAtMs: 10000,
  };

  const Phase = ConsentIngressExchange.fields.phase.pipe(Schema.toTaggedUnion("_tag")).cases;

  const proof = {
    disclosureMessageId: Phase.AwaitingDecision.fields.disclosureMessageId.make("disclosure"),
    disclosedAtMs: 1000,
    decisionNotBeforeMs: 2000,
  };

  const phases = [
    ...(["awaiting_delivery", "outbound_started"] as const).map((stage) =>
      Phase.BeforeDelivery.make({ stage, disclosureMessageId: null })
    ),
    Phase.AwaitingDecision.make(proof),
    ...(["accepted", "declined"] as const).map((decision) =>
      Phase.Settled.make({ decision, ...proof })
    ),
  ];

  for (const phase of phases) {
    const value = { ...identity, phase };
    expect(
      Schema.encodeSync(ConsentIngressExchange)(Schema.decodeSync(ConsentIngressExchange)(value))
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
