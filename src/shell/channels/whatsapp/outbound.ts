import { Data, DateTime, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import type { AgentReply } from "~/shell/agent/agent-service";
import type { AgentConversationAdmission } from "~/shell/agent/conversation";
import { CURRENT_DISCLOSURE_TEXT } from "~/shell/consent/current-disclosure";
import { requestConsentDisclosureDelivery } from "./disclosure-delivery";
import { KapsoClient, kapsoDestinationFor } from "./kapso-client";
import type { WhatsAppInboundEvent } from "./model";
import {
  type WhatsAppReceiptInvalid,
  authorizeWhatsAppFreeForm,
  retainOutboundEvidence,
} from "./repo";

/** The WhatsApp launch adapter cannot safely render reply attachments or choices. */
export class AgentReplyNotRenderable extends Data.TaggedError("AgentReplyNotRenderable")<{}> {}

const renderWhatsAppText = (text: TranscriptText): TranscriptText =>
  TranscriptText.make(text.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/gu, "*$1*"));

type DeliverableConsentOutcome = Exclude<
  AgentConversationAdmission,
  { readonly _tag: "AuthorizedTurn" }
>;

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

/**
 * Sends terminal Consent communication immediately and never starts financial processing. Events
 * older than the provider's 24-hour window are acknowledged without a send. The disclosure
 * delivery module owns all durable attempt, retry, reconciliation, and Consent-advancement details.
 */
export const deliverWhatsAppConsentOutcome = Effect.fn("WhatsApp.deliverConsentOutcome")(function* (
  event: WhatsAppInboundEvent,
  outcome: DeliverableConsentOutcome,
  beforeProviderCall: Effect.Effect<void, WhatsAppReceiptInvalid, SqlClient.SqlClient> = Effect.void
) {
  if (isOutsideFreeFormWindow(event)) return;
  const text = yield* Schema.decodeUnknownEffect(TranscriptText)(consentOutcomeText(outcome)).pipe(
    Effect.orDie
  );
  if (outcome._tag === "SendDisclosure" || outcome._tag === "AwaitingDisclosureDelivery") {
    yield* requestConsentDisclosureDelivery({
      event,
      exchangeId: outcome.exchangeId,
      text,
      beforeProviderCall,
    });
    return;
  }
  yield* beforeProviderCall;
  const client = yield* KapsoClient;
  yield* client.sendText({
    businessPhoneNumberId: event.businessPhoneNumberId,
    destination: kapsoDestinationFor(event.caller),
    text,
    opaqueCallbackData: Option.none(),
  });
});

/**
 * Rejects replies with attachments or choices, requires current onboarding consent, the User's
 * current WhatsAppIdentity, and its open free-form window, then sends through Kapso. A successful
 * decoded send retains metadata evidence. Typed renderability, Consent, identity, window, and
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
    destination: kapsoDestinationFor(authorization.caller),
    text: renderWhatsAppText(reply.text),
    opaqueCallbackData: Option.none(),
  });
  yield* retainOutboundEvidence(userId, sent.messageEvidence, sent.sentAt);
  return sent;
});
