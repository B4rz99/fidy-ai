import { Option, type Redacted, Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { DisclosureSnapshot } from "~/core/consent/model";
import { TranscriptText } from "~/core/transcript/model";
import {
  type KapsoClientService,
  makeKapsoClientService,
} from "~/shell/channels/whatsapp/kapso-client";
import { DisclosureDeliveryCorrelationToken } from "~/shell/channels/whatsapp/disclosure-model";
import type {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppInboundEvent,
} from "~/shell/channels/whatsapp/model";
import {
  decodeKapsoDisclosureLifecycleWebhook,
  decodeKapsoWebhook,
  maxKapsoFutureTimestampMinutes,
  maxKapsoWebhookBytes,
} from "~/shell/channels/whatsapp/kapso-webhook";
import { makeKapsoOutboundHttp } from "~/shell/outbound-http/operations";
import { currentDisclosureFor } from "./current-disclosure";

export { decideConsentReply } from "~/core/consent/rules";
export {
  ConsentIngressExchange,
  canRecordConsentIngressDecision,
  classifyConsentIngressReplay,
  isConsentIngressDecisionPhase,
  type ConsentIngressMessage,
} from "~/core/consent/ingress-lifecycle";
export {
  decodeKapsoDisclosureLifecycleWebhook,
  decodeKapsoWebhook,
  maxKapsoFutureTimestampMinutes,
  maxKapsoWebhookBytes,
};
export { currentDisclosureFor, DisclosureDeliveryCorrelationToken };
export { PendingConsentExchangeId, Sha256Digest } from "~/core/consent/reference";
export { WhatsAppProviderMessageId } from "~/core/provider-evidence/contract";
export { WhatsAppDeliveryKey } from "~/shell/channels/whatsapp/model";
export {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
export type { KapsoSendFailed, KapsoSentMessage } from "~/shell/channels/whatsapp/kapso-client";
export type { WhatsAppInboundEvent, WhatsAppWebhookReceipt } from "~/shell/channels/whatsapp/model";

/** Persist and decode only a validated version of the exact disclosure shown to the caller. */
export const PendingDisclosureJson = Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot));

/** A narrow provider-send boundary; no browser, SQL, or model authority crosses it. */
export const makeDisclosureSender = (
  input: Readonly<{
    readonly apiKey: Redacted.Redacted<string>;
    readonly httpClient: HttpClient.HttpClient;
  }>
) => {
  const client = makeKapsoClientService({
    deliveryMode: "bsuid",
    outboundHttp: makeKapsoOutboundHttp(input),
  });
  return (
    request: Readonly<{
      readonly caller: WhatsAppInboundEvent["caller"];
      readonly phoneNumberId: WhatsAppBusinessPhoneNumberId;
      readonly disclosure: DisclosureSnapshot;
      readonly correlationToken: DisclosureDeliveryCorrelationToken;
    }>
  ): ReturnType<KapsoClientService["sendText"]> =>
    client.sendText({
      businessPhoneNumberId: request.phoneNumberId,
      destination: { recipient: request.caller.businessScopedUserId, sandboxPhone: Option.none() },
      text: TranscriptText.make(request.disclosure.text),
      opaqueCallbackData: Option.some(request.correlationToken),
    });
};
