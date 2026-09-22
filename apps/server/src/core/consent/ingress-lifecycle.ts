import { Option, Schema } from "effect";
import { WhatsAppBusinessPhoneNumberId } from "~/core/identity/reference";
import { WhatsAppProviderMessageId } from "~/core/provider-evidence/contract";
import { Sha256Digest } from "./reference";

/** Temporary Consent evidence; delivery and settlement phases carry the proof each decision requires. */
export const ConsentIngressExchange = Schema.Struct({
  initiatingMessageId: WhatsAppProviderMessageId,
  initiatingBodySha256: Sha256Digest,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  expiresAtMs: Schema.Finite,
  phase: Schema.Union([
    Schema.TaggedStruct("BeforeDelivery", {
      stage: Schema.Literals(["awaiting_delivery", "outbound_started"]),
      disclosureMessageId: Schema.NullOr(WhatsAppProviderMessageId),
    }),
    Schema.TaggedStruct("AwaitingDecision", {
      disclosureMessageId: WhatsAppProviderMessageId,
      disclosedAtMs: Schema.Finite,
      decisionNotBeforeMs: Schema.Finite,
    }),
    Schema.TaggedStruct("Settled", {
      decision: Schema.Literals(["accepted", "declined"]),
      disclosureMessageId: WhatsAppProviderMessageId,
      disclosedAtMs: Schema.Finite,
      decisionNotBeforeMs: Schema.Finite,
    }),
  ]),
});
export type ConsentIngressExchange = typeof ConsentIngressExchange.Type;

/** Provider-qualified message facts supplied by ingress after authentication and bounded decoding. */
export type ConsentIngressMessage = Readonly<{
  providerMessageId: WhatsAppProviderMessageId;
  bodySha256: Sha256Digest;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  occurredAtMs: number;
  receivedAtMs: number;
}>;

/** Only a later message following proven delivery can become a decision. */
export const canRecordConsentIngressDecision = ({
  exchange,
  message,
}: Readonly<{ exchange: ConsentIngressExchange; message: ConsentIngressMessage }>): boolean =>
  exchange.phase._tag === "AwaitingDecision" &&
  message.occurredAtMs > exchange.phase.disclosedAtMs &&
  message.occurredAtMs > exchange.phase.decisionNotBeforeMs &&
  exchange.businessPhoneNumberId === message.businessPhoneNumberId &&
  exchange.initiatingMessageId !== message.providerMessageId;

/** An expired message predating the former exchange cannot initiate a new one. */
export const classifyConsentIngressReplay = ({
  exchange,
  message,
}: Readonly<{
  exchange: Option.Option<ConsentIngressExchange>;
  message: ConsentIngressMessage;
}>): "new" | "replay" | "conflict" => {
  if (Option.isNone(exchange)) return "new";
  if (exchange.value.expiresAtMs <= message.receivedAtMs) {
    return exchange.value.initiatingMessageId === message.providerMessageId ||
      message.occurredAtMs < exchange.value.expiresAtMs
      ? "conflict"
      : "new";
  }
  return exchange.value.initiatingMessageId === message.providerMessageId &&
    exchange.value.initiatingBodySha256 === message.bodySha256
    ? "replay"
    : "conflict";
};

/** A delivered or settled exchange must not initiate another disclosure. */
export const isConsentIngressDecisionPhase = (exchange: ConsentIngressExchange): boolean =>
  exchange.phase._tag !== "BeforeDelivery";
