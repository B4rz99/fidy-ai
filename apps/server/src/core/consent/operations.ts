import { DateTime, Effect, Option } from "effect";
import type {
  ConsentInboundContent,
  ConsentIngressExchange,
  ConsentIngressMessage,
  DisclosureSnapshot,
  PATRevocationOrigin,
  PendingConsentExchange,
  PolicySnapshot,
} from "./contract";

/** Only a later message following proven delivery can become a decision. */
export const canRecordConsentIngressDecision = ({
  exchange,
  message,
}: Readonly<{
  exchange: ConsentIngressExchange;
  message: ConsentIngressMessage;
}>): boolean =>
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

type PATRevocationDisclosure = Readonly<{ revision: string; text: string }> &
  (
    | Readonly<{ _tag: "AuthenticatedWeb" }>
    | Readonly<{
        _tag: "AutomaticPolicy";
        policyReason: "pat-approved-unclaimed-expiry" | "pat-fixed-lifetime-expiry";
      }>
  );
const revision = "pat-revocation-2026-09";
const disclosures = {
  "user-revoke-one": { _tag: "AuthenticatedWeb", revision, text: "User revoked this PAT." },
  "user-revoke-all": { _tag: "AuthenticatedWeb", revision, text: "User revoked all active PATs." },
  "user-revoke-unclaimed": {
    _tag: "AuthenticatedWeb",
    revision,
    text: "User revoked all unclaimed PAT approvals.",
  },
  "approved-unclaimed-expiry": {
    _tag: "AutomaticPolicy",
    revision,
    text: "Unclaimed PAT approval expired under the fixed claim deadline.",
    policyReason: "pat-approved-unclaimed-expiry",
  },
  "fixed-lifetime-expiry": {
    _tag: "AutomaticPolicy",
    revision,
    text: "PAT expired at the fixed lifetime deadline.",
    policyReason: "pat-fixed-lifetime-expiry",
  },
} as const satisfies Record<PATRevocationOrigin, PATRevocationDisclosure>;

/** Derives the fixed disclosure and attributable source for a PAT grant's terminal transition. */
export const decidePATRevocation = <Origin extends PATRevocationOrigin>(
  origin: Origin
): (typeof disclosures)[Origin] => disclosures[origin];

/** The only three outcomes allowed before the consent gate performs any effect. */
export type ConsentReplyDecision =
  | Readonly<{ readonly _tag: "Accepted" }>
  | Readonly<{ readonly _tag: "Declined" }>
  | Readonly<{ readonly _tag: "Clarify" }>;

const acceptedReplies = new Set([
  "acepto",
  "si, acepto",
  "si acepto",
  "acepto el tratamiento de mis datos",
]);
const declinedReplies = new Set(["no", "no acepto", "no autorizo", "rechazo"]);

const normalizeReply = (text: string): string =>
  text
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLocaleLowerCase("es-CO")
    .replaceAll(/[.!]+$/gu, "")
    .replaceAll(/\s+/gu, " ");

/**
 * Classifies one decoded reply using a closed explicit grammar. A bare “sí” is
 * deliberately ambiguous and never authorizes personal-data processing.
 */
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

type AwaitingDisclosureDelivery = Extract<
  PendingConsentExchange,
  { readonly _tag: "AwaitingDisclosureDelivery" }
>;

type ReadonlyPolicySnapshot = Readonly<PolicySnapshot>;

type ReadonlyDisclosureSnapshot = Omit<
  Readonly<DisclosureSnapshot>,
  "policy" | "purposes" | "dataCategories"
> & {
  readonly policy: ReadonlyPolicySnapshot;
  readonly purposes: ReadonlyArray<DisclosureSnapshot["purposes"][number]>;
  readonly dataCategories: ReadonlyArray<DisclosureSnapshot["dataCategories"][number]>;
};

type PendingConsentInput = Omit<
  Readonly<AwaitingDisclosureDelivery>,
  "_tag" | "caller" | "disclosure" | "expiresAt"
> & {
  readonly disclosure: ReadonlyDisclosureSnapshot;
};

type PendingConsentDraft = Omit<AwaitingDisclosureDelivery, "caller">;

/** Starts one caller-independent pending draft with the fixed 24-hour legal lifetime. */
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

/** Treats the exact 24-hour boundary as expired, never as one final valid instant. */
export const hasPendingConsentExpired = (
  input: Readonly<{
    readonly pending: Readonly<{ readonly expiresAt: DateTime.Utc }>;
    readonly now: DateTime.Utc;
  }>
): Effect.Effect<boolean> =>
  Effect.succeed(DateTime.isGreaterThanOrEqualTo(input.now, input.pending.expiresAt));
