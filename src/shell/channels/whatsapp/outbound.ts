import { Data, DateTime, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
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
  authorizeWhatsAppFreeForm,
  retainOutboundEvidence,
  type WhatsAppReceiptInvalid,
} from "./repo";

/** Another worker owns disclosure delivery or its evidence could not be recorded. */
export class ConsentDisclosureDeliveryUnavailable extends Data.TaggedError(
  "ConsentDisclosureDeliveryUnavailable"
)<{}> {}

/** The WhatsApp launch adapter cannot safely render reply attachments or choices. */
export class AgentReplyNotRenderable extends Data.TaggedError("AgentReplyNotRenderable")<{}> {}

const renderWhatsAppText = (text: TranscriptText): TranscriptText =>
  TranscriptText.make(text.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/gu, "*$1*"));

const destinationFor = (caller: WhatsAppInboundEvent["caller"]) => ({
  recipient: caller.businessScopedUserId,
});

/**
 * Sends terminal consent communication immediately and never starts financial processing. Events
 * older than the provider's 24-hour window are acknowledged without a send. Disclosure outcomes
 * use the current disclosure text and record provider delivery evidence after Kapso succeeds;
 * Kapso and consent-repository failures are preserved.
 */
export const deliverWhatsAppConsentOutcome = Effect.fn("WhatsApp.deliverConsentOutcome")(function* (
  event: WhatsAppInboundEvent,
  outcome: Exclude<AgentConversationAdmission, { readonly _tag: "AuthorizedTurn" }>,
  beforeProviderCall: Effect.Effect<void, WhatsAppReceiptInvalid, SqlClient.SqlClient> = Effect.void
) {
  if (DateTime.Order(event.occurredAt, DateTime.subtract(event.receivedAt, { hours: 24 })) < 0) {
    return;
  }
  const text = yield* Schema.decodeUnknownEffect(TranscriptText)(
    outcome._tag === "AwaitingDisclosureDelivery" ? CURRENT_DISCLOSURE_TEXT : outcome.text
  );
  const client = yield* KapsoClient;
  if (outcome._tag !== "SendDisclosure" && outcome._tag !== "AwaitingDisclosureDelivery") {
    yield* beforeProviderCall;
    yield* client.sendText({
      businessPhoneNumberId: event.businessPhoneNumberId,
      destination: destinationFor(event.caller),
      text,
    });
    return;
  }
  const claim = yield* claimConsentDisclosureDelivery(outcome.exchangeId, event.receivedAt);
  if (Option.isNone(claim)) return yield* new ConsentDisclosureDeliveryUnavailable();
  yield* beforeProviderCall;
  const started = yield* markConsentDisclosureDeliveryStarted(
    { exchangeId: outcome.exchangeId, claimId: claim.value.claimId },
    event.receivedAt
  );
  if (!started) return yield* new ConsentDisclosureDeliveryUnavailable();
  const sent = yield* client.sendText({
    businessPhoneNumberId: event.businessPhoneNumberId,
    destination: destinationFor(event.caller),
    text,
  });
  const recorded = yield* recordConsentDisclosureDelivery({
    exchangeId: outcome.exchangeId,
    claimId: claim.value.claimId,
    message: sent.messageEvidence,
    deliveredAt: sent.sentAt,
  });
  if (Option.isNone(recorded)) return yield* new ConsentDisclosureDeliveryUnavailable();
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
