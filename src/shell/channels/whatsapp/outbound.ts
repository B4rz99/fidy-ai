import { Data, DateTime, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type {
  E164PhoneNumber,
  UserId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import type { AgentReply } from "~/shell/agent/agent-service";
import type { AgentConversationAdmission } from "~/shell/agent/conversation";
import { CURRENT_DISCLOSURE_TEXT } from "~/shell/consent/current-disclosure";
import {
  claimConsentDisclosureDelivery,
  markConsentDisclosureDeliveryStarted,
  recordConsentDisclosureDelivery,
} from "~/shell/consent/repo";
import { KapsoClient } from "./kapso-client";
import type { WhatsAppInboundEvent } from "./model";
import {
  type WhatsAppReceiptInvalid,
  authorizeWhatsAppFreeForm,
  retainOutboundEvidence,
} from "./repo";

/** Another worker owns disclosure delivery or its evidence could not be recorded. */
export class ConsentDisclosureDeliveryUnavailable extends Data.TaggedError(
  "ConsentDisclosureDeliveryUnavailable"
)<{}> {}

/** The WhatsApp launch adapter cannot safely render reply attachments or choices. */
export class AgentReplyNotRenderable extends Data.TaggedError("AgentReplyNotRenderable")<{}> {}

const renderWhatsAppText = (text: TranscriptText): TranscriptText =>
  TranscriptText.make(text.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/gu, "*$1*"));

const destinationFor = (
  caller: WhatsAppInboundEvent["caller"]
): {
  recipient: WhatsAppBusinessScopedUserId;
  sandboxPhone: Option.Option<E164PhoneNumber>;
} => ({
  recipient: caller.businessScopedUserId,
  sandboxPhone: caller.phoneNumber,
});

type DeliverableConsentOutcome = Exclude<
  AgentConversationAdmission,
  { readonly _tag: "AuthorizedTurn" }
>;

type DisclosureExchangeId = Extract<
  DeliverableConsentOutcome,
  { readonly _tag: "SendDisclosure" }
>["exchangeId"];

const isOutsideFreeFormWindow = (event: WhatsAppInboundEvent): boolean =>
  DateTime.Order(event.occurredAt, DateTime.subtract(event.receivedAt, { hours: 24 })) < 0;

const consentOutcomeText = (outcome: DeliverableConsentOutcome): string => {
  switch (outcome._tag) {
    case "AwaitingDisclosureDelivery":
      return CURRENT_DISCLOSURE_TEXT;
    case "SendDisclosure":
    case "ClarifyDecision":
    case "Declined":
    case "Accepted":
      return outcome.text;
  }
};

const disclosureExchangeId = (
  outcome: DeliverableConsentOutcome
): Option.Option<DisclosureExchangeId> => {
  switch (outcome._tag) {
    case "SendDisclosure":
    case "AwaitingDisclosureDelivery":
      return Option.some(outcome.exchangeId);
    case "ClarifyDecision":
    case "Declined":
    case "Accepted":
      return Option.none();
  }
};

const sendConsentText = Effect.fn("WhatsApp.sendConsentText")(function* (
  request: Readonly<{ event: WhatsAppInboundEvent; text: TranscriptText }>
) {
  const client = yield* KapsoClient;
  return yield* client.sendText({
    businessPhoneNumberId: request.event.businessPhoneNumberId,
    destination: destinationFor(request.event.caller),
    text: request.text,
  });
});

const deliverConsentDisclosure = Effect.fn("WhatsApp.deliverConsentDisclosure")(function* (
  request: Readonly<{
    event: WhatsAppInboundEvent;
    exchangeId: DisclosureExchangeId;
    text: TranscriptText;
    beforeProviderCall: Effect.Effect<void, WhatsAppReceiptInvalid, SqlClient.SqlClient>;
  }>
) {
  const claim = yield* claimConsentDisclosureDelivery(request.exchangeId, request.event.receivedAt);
  if (Option.isNone(claim)) return yield* new ConsentDisclosureDeliveryUnavailable();
  yield* request.beforeProviderCall;
  const started = yield* markConsentDisclosureDeliveryStarted(
    { exchangeId: request.exchangeId, claimId: claim.value.claimId },
    request.event.receivedAt
  );
  if (!started) return yield* new ConsentDisclosureDeliveryUnavailable();
  const sent = yield* sendConsentText({ event: request.event, text: request.text });
  const recorded = yield* recordConsentDisclosureDelivery({
    exchangeId: request.exchangeId,
    claimId: claim.value.claimId,
    message: sent.messageEvidence,
    deliveredAt: sent.sentAt,
  });
  if (Option.isNone(recorded)) return yield* new ConsentDisclosureDeliveryUnavailable();
});

/**
 * Sends terminal consent communication immediately and never starts financial processing. Events
 * older than the provider's 24-hour window are acknowledged without a send. Disclosure outcomes
 * use the current disclosure text and record provider delivery evidence after Kapso succeeds;
 * Kapso and consent-repository failures are preserved.
 */
export const deliverWhatsAppConsentOutcome = Effect.fn("WhatsApp.deliverConsentOutcome")(function* (
  event: WhatsAppInboundEvent,
  outcome: DeliverableConsentOutcome,
  beforeProviderCall: Effect.Effect<void, WhatsAppReceiptInvalid, SqlClient.SqlClient> = Effect.void
) {
  if (isOutsideFreeFormWindow(event)) return;
  const text = yield* Schema.decodeUnknownEffect(TranscriptText)(consentOutcomeText(outcome));
  const exchangeId = disclosureExchangeId(outcome);
  if (Option.isNone(exchangeId)) {
    yield* beforeProviderCall;
    yield* sendConsentText({ event, text });
    return;
  }
  yield* deliverConsentDisclosure({
    event,
    exchangeId: exchangeId.value,
    text,
    beforeProviderCall,
  });
});

/**
 * Rejects replies with attachments or choices, requires current onboarding consent, the User's
 * current WhatsAppIdentity, and its open free-form window, then sends through Kapso. A successful
 * decoded send retains metadata evidence. Typed renderability, consent, identity, window, and
 * Kapso failures are preserved.
 */
export const sendKapsoFreeForm = Effect.fn("WhatsApp.sendFreeForm")(function* (
  userId: UserId,
  reply: AgentReply,
  now: DateTime.Utc
) {
  if (Option.isSome(reply.attachments) || Option.isSome(reply.choices)) {
    return yield* new AgentReplyNotRenderable();
  }
  const authorization = yield* authorizeWhatsAppFreeForm(userId, now);
  const client = yield* KapsoClient;
  const sent = yield* client.sendText({
    businessPhoneNumberId: authorization.businessPhoneNumberId,
    destination: destinationFor(authorization.caller),
    text: renderWhatsAppText(reply.text),
  });
  yield* retainOutboundEvidence(userId, sent.messageEvidence, sent.sentAt);
  return sent;
});
