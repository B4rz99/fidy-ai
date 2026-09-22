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

/** Pre-User mailbox collection and provider-acceptance states safe to disclose to its WhatsApp caller. */
export type EmailStatus =
  | "awaiting_email"
  | "awaiting_delivery"
  | "sending"
  | "awaiting_proof"
  | "rejected"
  | "ambiguous";

const emailStatusMessages: Readonly<Record<EmailStatus, string>> = {
  awaiting_email:
    "Consentimiento registrado. Responde con tu correo electrónico para recibir el código de verificación.",
  awaiting_delivery: "Registramos tu correo; aún no se ha confirmado el envío del código.",
  sending: "El envío está en curso. Todavía no podemos confirmar si el proveedor lo aceptó.",
  awaiting_proof:
    "El proveedor aceptó la solicitud del código. Revisa tu correo; no podemos confirmar su llegada.",
  rejected: "El proveedor rechazó el envío. No se reenviará automáticamente; contacta a soporte.",
  ambiguous:
    "No podemos confirmar si el proveedor envió el código. No lo reenviamos automáticamente; contacta a soporte.",
};

/** Send only fixed, non-secret onboarding status text to the authenticated WhatsApp caller. */
export const makeEmailStatusSender = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
  }>
) => {
  const client = makeKapsoClientService({
    deliveryMode: "bsuid",
    outboundHttp: makeKapsoOutboundHttp(input),
  });
  return (
    request: Readonly<{
      caller: WhatsAppInboundEvent["caller"];
      phoneNumberId: WhatsAppBusinessPhoneNumberId;
      status: EmailStatus;
    }>
  ): ReturnType<KapsoClientService["sendText"]> =>
    client.sendText({
      businessPhoneNumberId: request.phoneNumberId,
      destination: { recipient: request.caller.businessScopedUserId, sandboxPhone: Option.none() },
      text: TranscriptText.make(emailStatusMessages[request.status]),
      opaqueCallbackData: Option.none(),
    });
};

/** Send a versioned disclosure to the authenticated WhatsApp caller, with a delivery correlation token. */
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
