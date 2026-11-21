import { DateTime, Effect, Option } from "effect";
import type {
  ConsentInboundContent,
  ConsentIngressExchange,
  ConsentIngressMessage,
  ConsentReplyDecision,
  PATRevocationDisclosure,
  PATRevocationOrigin,
  PendingConsentDraft,
  PendingConsentInput,
} from "./contract";
import { acceptedReplies, declinedReplies, normalizeReply } from "~/core/consent/internal/replies";

const patRevocationRevision = "pat-revocation-2026-09";

const patRevocationDisclosures = {
  "user-revoke-one": {
    _tag: "AuthenticatedWeb",
    revision: patRevocationRevision,
    text: "User revoked this PAT.",
  },
  "user-revoke-all": {
    _tag: "AuthenticatedWeb",
    revision: patRevocationRevision,
    text: "User revoked all active PATs.",
  },
  "user-revoke-unclaimed": {
    _tag: "AuthenticatedWeb",
    revision: patRevocationRevision,
    text: "User revoked all unclaimed PAT approvals.",
  },
  "approved-unclaimed-expiry": {
    _tag: "AutomaticPolicy",
    revision: patRevocationRevision,
    text: "Unclaimed PAT approval expired under the fixed claim deadline.",
    policyReason: "pat-approved-unclaimed-expiry",
  },
  "fixed-lifetime-expiry": {
    _tag: "AutomaticPolicy",
    revision: patRevocationRevision,
    text: "PAT expired at the fixed lifetime deadline.",
    policyReason: "pat-fixed-lifetime-expiry",
  },
} as const satisfies Record<PATRevocationOrigin, PATRevocationDisclosure>;

export const decideConsentReply = (
  content: ConsentInboundContent
): Effect.Effect<ConsentReplyDecision> => {
  if (content._tag === "Choice") {
    return Effect.succeed(
      content.choice === "accept" ? { _tag: "Accepted" } : { _tag: "Declined" }
    );
  }

  const reply = normalizeReply(content.text);

  if (declinedReplies.has(reply)) return Effect.succeed({ _tag: "Declined" });

  if (acceptedReplies.has(reply)) return Effect.succeed({ _tag: "Accepted" });

  return Effect.succeed({ _tag: "Clarify" });
};

export const makePendingConsentDraft = (
  input: PendingConsentInput
): Effect.Effect<PendingConsentDraft> =>
  Effect.succeed({
    _tag: "AwaitingDisclosureDelivery",
    ...input,
    disclosure: {
      ...input.disclosure,
      purposes: [...input.disclosure.purposes],
      dataCategories: [...input.disclosure.dataCategories],
    },
    expiresAt: DateTime.add(input.createdAt, { hours: 24 }),
  });

export const hasPendingConsentExpired = (
  input: Readonly<{
    readonly pending: Readonly<{ readonly expiresAt: DateTime.Utc }>;
    readonly now: DateTime.Utc;
  }>
): Effect.Effect<boolean> =>
  Effect.succeed(DateTime.isGreaterThanOrEqualTo(input.now, input.pending.expiresAt));

export const canRecordConsentIngressDecision = ({
  exchange,
  message,
}: Readonly<{ exchange: ConsentIngressExchange; message: ConsentIngressMessage }>): boolean =>
  exchange.phase._tag === "AwaitingDecision" &&
  message.occurredAtMs > exchange.phase.disclosedAtMs &&
  message.occurredAtMs > exchange.phase.decisionNotBeforeMs &&
  exchange.businessPhoneNumberId === message.businessPhoneNumberId &&
  exchange.initiatingMessageId !== message.providerMessageId;

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

export const isConsentIngressDecisionPhase = (exchange: ConsentIngressExchange): boolean =>
  exchange.phase._tag !== "BeforeDelivery";

export const decidePATRevocation = <Origin extends PATRevocationOrigin>(
  origin: Origin
): PATRevocationDisclosure<Origin> => patRevocationDisclosures[origin];
