import { Data, DateTime, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import { TranscriptText } from "~/core/transcript/model";
import type { AgentReply } from "~/shell/agent/agent-service";
import type { AgentConversationAdmission } from "~/shell/agent/conversation";
import { CURRENT_DISCLOSURE_TEXT } from "~/shell/consent/current-disclosure";
import type { DeclaredOutcome, TelemetryAttempt } from "~/shell/observability/protocol";
import { Telemetry } from "~/shell/observability/telemetry";
import { requestConsentDisclosureDelivery } from "./disclosure-delivery";
import {
  KapsoClient,
  type KapsoClientService,
  type KapsoSendFailed,
  kapsoDestinationFor,
} from "./kapso-client";
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

/** Classifies one safe provider failure without inspecting its response or outbound text. */
const kapsoDeliveryOutcome = (failure: KapsoSendFailed): DeclaredOutcome =>
  failure.deliveryCertainty === "rejected" && !failure.automaticRetry
    ? {
        outcome: "rejected",
        error: Option.some(failure.safeReason),
        retryable: false,
      }
    : {
        outcome: "failed",
        error: Option.some(failure.safeReason),
        retryable: failure.automaticRetry,
      };

const sendKapsoText = Effect.fn("WhatsApp.sendText")(function* (request: {
  readonly businessPhoneNumberId: WhatsAppInboundEvent["businessPhoneNumberId"];
  readonly destination: Parameters<KapsoClientService["sendText"]>[0]["destination"];
  readonly text: TranscriptText;
  readonly attempt: TelemetryAttempt;
}) {
  const work = Effect.gen(function* () {
    const client = yield* KapsoClient;
    return yield* client.sendText({ ...request, opaqueCallbackData: Option.none() });
  });
  const telemetry = yield* Effect.serviceOption(Telemetry);
  return yield* Option.match(telemetry, {
    onNone: () => work,
    onSome: (service) =>
      service.span(
        {
          component: "kapso",
          operation: "whatsapp.sendText",
          trigger: "queue",
          spanOperation: "http.client",
          workKind: "provider_call",
          metadata: {
            _tag: "Provider",
            provider: "kapso",
            attempt: request.attempt,
            status: Option.none(),
          },
        },
        work.pipe(
          Effect.tap((sent) => service.recordResponseStatus(sent.responseStatus)),
          Effect.tapError((failure) =>
            Effect.all(
              [
                Option.match(failure.responseStatus, {
                  onNone: () => Effect.void,
                  onSome: service.recordResponseStatus,
                }),
                service.recordOutcome(kapsoDeliveryOutcome(failure)),
              ],
              { discard: true }
            )
          )
        )
      ),
  });
});

type KapsoFreeFormInput = Readonly<{
  userId: UserId;
  reply: AgentReply;
  now: DateTime.Utc;
  attempt: TelemetryAttempt;
}>;

/**
 * Rejects replies with attachments or choices, requires current onboarding consent, the User's
 * current WhatsAppIdentity, and its open free-form window, then makes the supplied provider
 * attempt through Kapso. A successful decoded send retains metadata evidence. Typed renderability,
 * Consent, identity, window, Kapso, and evidence-persistence failures are preserved.
 */
export const sendKapsoFreeForm = Effect.fn("WhatsApp.sendFreeForm")(function* (
  input: KapsoFreeFormInput
) {
  const { userId, reply, now, attempt } = input;
  if (Option.isSome(reply.attachments) || Option.isSome(reply.choices)) {
    return yield* new AgentReplyNotRenderable();
  }
  const authorization = yield* authorizeWhatsAppFreeForm(userId, now);
  const sent = yield* sendKapsoText({
    businessPhoneNumberId: authorization.businessPhoneNumberId,
    destination: kapsoDestinationFor(authorization.caller),
    text: renderWhatsAppText(reply.text),
    attempt,
  });
  yield* retainOutboundEvidence(userId, sent.messageEvidence, sent.sentAt);
  return sent;
});
