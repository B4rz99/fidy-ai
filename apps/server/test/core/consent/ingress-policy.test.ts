import { Option, Schema } from "effect";
import { expect, it } from "vitest";
import { ConsentIngressExchange, type ConsentIngressMessage } from "~/core/consent/contract";
import {
  canRecordConsentIngressDecision,
  classifyConsentIngressReplay,
  isConsentIngressDecisionPhase,
} from "~/core/consent/operations";

const Phase = ConsentIngressExchange.fields.phase.pipe(Schema.toTaggedUnion("_tag")).cases;

const exchange = Schema.decodeSync(ConsentIngressExchange)({
  initiatingMessageId: "initial",
  initiatingBodySha256: "a".repeat(64),
  businessPhoneNumberId: "123",
  expiresAtMs: 10_000,
  phase: Phase.AwaitingDecision.make({
    disclosureMessageId: Phase.AwaitingDecision.fields.disclosureMessageId.make("disclosure"),
    disclosedAtMs: 100,
    decisionNotBeforeMs: 200,
  }),
});

const message: ConsentIngressMessage = {
  providerMessageId: exchange.initiatingMessageId,
  bodySha256: exchange.initiatingBodySha256,
  businessPhoneNumberId: exchange.businessPhoneNumberId,
  occurredAtMs: 300,
  receivedAtMs: 400,
};

it("accepts a decision only after proven delivery and the last disclosure boundary on the same endpoint", () => {
  const reply = {
    ...message,
    providerMessageId: Schema.decodeSync(ConsentIngressExchange.fields.initiatingMessageId)(
      "reply"
    ),
  };

  expect(canRecordConsentIngressDecision({ exchange, message: reply })).toBe(true);

  for (const occurredAtMs of [99, 100, 199, 200]) {
    expect(canRecordConsentIngressDecision({ exchange, message: { ...reply, occurredAtMs } })).toBe(
      false
    );
  }

  expect(
    canRecordConsentIngressDecision({
      exchange: {
        ...exchange,
        phase: Phase.AwaitingDecision.make({
          disclosureMessageId: exchange.initiatingMessageId,
          disclosedAtMs: 400,
          decisionNotBeforeMs: 200,
        }),
      },
      message: { ...reply, occurredAtMs: 400 },
    })
  ).toBe(false);
  expect(canRecordConsentIngressDecision({ exchange, message })).toBe(false);
  expect(
    canRecordConsentIngressDecision({
      exchange,
      message: {
        ...reply,
        businessPhoneNumberId: Schema.decodeSync(
          ConsentIngressExchange.fields.businessPhoneNumberId
        )("456"),
      },
    })
  ).toBe(false);

  const before = {
    ...exchange,
    phase: Phase.BeforeDelivery.make({
      stage: "awaiting_delivery",
      disclosureMessageId: null,
    }),
  };

  expect(canRecordConsentIngressDecision({ exchange: before, message: reply })).toBe(false);
  expect(isConsentIngressDecisionPhase(before)).toBe(false);
  expect(isConsentIngressDecisionPhase(exchange)).toBe(true);

  const settled = {
    ...exchange,
    phase: Phase.Settled.make({
      decision: "accepted",
      disclosureMessageId: exchange.initiatingMessageId,
      disclosedAtMs: 100,
      decisionNotBeforeMs: 200,
    }),
  };

  expect(isConsentIngressDecisionPhase(settled)).toBe(true);
  expect(canRecordConsentIngressDecision({ exchange: settled, message: reply })).toBe(false);
});

it("recognizes only the identical live initiation as replay and fences expired messages", () => {
  const classify = (
    input: ConsentIngressMessage,
    retained = Option.some(exchange)
  ): "new" | "replay" | "conflict" =>
    classifyConsentIngressReplay({ exchange: retained, message: input });

  expect(classify(message, Option.none())).toBe("new");
  expect(classify(message)).toBe("replay");
  expect(
    classify({
      ...message,
      bodySha256: Schema.decodeSync(ConsentIngressExchange.fields.initiatingBodySha256)(
        "b".repeat(64)
      ),
    })
  ).toBe("conflict");

  const different = {
    ...message,
    providerMessageId: Schema.decodeSync(ConsentIngressExchange.fields.initiatingMessageId)(
      "other"
    ),
  };

  expect(classify(different)).toBe("conflict");

  for (const receivedAtMs of [10_000, 10_001]) {
    expect(classify({ ...message, receivedAtMs, occurredAtMs: 10_001 })).toBe("conflict");
    expect(classify({ ...different, receivedAtMs, occurredAtMs: 9_999 })).toBe("conflict");
    expect(classify({ ...different, receivedAtMs, occurredAtMs: 10_000 })).toBe("new");
    expect(classify({ ...different, receivedAtMs, occurredAtMs: 10_001 })).toBe("new");
  }
});
