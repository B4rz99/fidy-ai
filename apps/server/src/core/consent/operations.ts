import { DateTime, Effect, Match, Option, Predicate } from "effect";
import {
  ApprovedUnclaimedExpiryPATRevocation,
  AuthenticatedWebPATRevocation,
  type ConsentInboundContent,
  type ConsentIngressExchange,
  type ConsentIngressMessage,
  ConsentReplyDecision,
  FixedLifetimeExpiryPATRevocation,
  type PATRevocationDisclosure,
  type PATRevocationDisclosures,
  type PATRevocationOrigin,
  PendingConsentDraft,
  type PendingConsentInput,
} from "./contract";
import { acceptedReplies, declinedReplies, normalizeReply } from "~/core/consent/internal/replies";

const patRevocationRevision = "pat-revocation-2026-09";

const patRevocationDisclosures: PATRevocationDisclosures = {
  "user-revoke-one": AuthenticatedWebPATRevocation.make({
    revision: patRevocationRevision,
    text: "User revoked this PAT.",
  }),
  "user-revoke-all": AuthenticatedWebPATRevocation.make({
    revision: patRevocationRevision,
    text: "User revoked all active PATs.",
  }),
  "user-revoke-unclaimed": AuthenticatedWebPATRevocation.make({
    revision: patRevocationRevision,
    text: "User revoked all unclaimed PAT approvals.",
  }),
  "approved-unclaimed-expiry": ApprovedUnclaimedExpiryPATRevocation.make({
    revision: patRevocationRevision,
    text: "Unclaimed PAT approval expired under the fixed claim deadline.",
    policyReason: "pat-approved-unclaimed-expiry",
  }),
  "fixed-lifetime-expiry": FixedLifetimeExpiryPATRevocation.make({
    revision: patRevocationRevision,
    text: "PAT expired at the fixed lifetime deadline.",
    policyReason: "pat-fixed-lifetime-expiry",
  }),
};

const decideTextReply = (reply: string): ConsentReplyDecision => {
  if (declinedReplies.has(reply)) return ConsentReplyDecision.Declined();

  if (acceptedReplies.has(reply)) return ConsentReplyDecision.Accepted();

  return ConsentReplyDecision.Clarify();
};

export const decideConsentReply = (
  content: ConsentInboundContent
): Effect.Effect<ConsentReplyDecision> =>
  Effect.succeed(
    Match.value(content).pipe(
      Match.tagsExhaustive({
        Choice: ({ choice }) =>
          choice === "accept" ? ConsentReplyDecision.Accepted() : ConsentReplyDecision.Declined(),
        Text: ({ text }) => decideTextReply(normalizeReply(text)),
      })
    )
  );

export const makePendingConsentDraft = (
  input: PendingConsentInput
): Effect.Effect<PendingConsentDraft> =>
  Effect.succeed(
    PendingConsentDraft.AwaitingDisclosureDelivery({
      ...input,
      disclosure: {
        ...input.disclosure,
        purposes: [...input.disclosure.purposes],
        dataCategories: [...input.disclosure.dataCategories],
      },
      expiresAt: DateTime.add(input.createdAt, { hours: 24 }),
    })
  );

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
  Predicate.isTagged(exchange.phase, "AwaitingDecision") &&
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
  !Predicate.isTagged(exchange.phase, "BeforeDelivery");

export const decidePATRevocation = <Origin extends PATRevocationOrigin>(
  origin: Origin
): PATRevocationDisclosure<Origin> => patRevocationDisclosures[origin];
