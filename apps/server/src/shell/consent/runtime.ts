import { Option, type Redacted } from "effect";
import { type HttpClient } from "effect/unstable/http";
import { type DisclosureSnapshot } from "~/core/consent/contract";
import { TranscriptText } from "~/core/agent/contract";
import {
  type DisclosureDeliveryCorrelationToken,
  type WhatsAppBusinessPhoneNumberId,
  type WhatsAppDelivery,
  type WhatsAppInboundEvent,
} from "~/shell/channels/whatsapp/contract";
import { makeWhatsAppDelivery } from "~/shell/channels/whatsapp/runtime";
import { emailStatusMessages } from "~/shell/consent/internal/email-status";
import { makeKapsoOutboundHttp } from "~/shell/outbound-http/operations";
import { type EmailStatus } from "./contract";
/** Send only fixed, non-secret onboarding status text to the authenticated WhatsApp caller. */
export const makeEmailStatusSender = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
  }>
): ((
  request: Readonly<{
    caller: WhatsAppInboundEvent["caller"];
    phoneNumberId: WhatsAppBusinessPhoneNumberId;
    status: EmailStatus;
  }>
) => ReturnType<WhatsAppDelivery["sendText"]>) => {
  const client = makeWhatsAppDelivery({
    deliveryMode: "bsuid",
    outboundHttp: makeKapsoOutboundHttp(input),
  });
  return (
    request: Readonly<{
      caller: WhatsAppInboundEvent["caller"];
      phoneNumberId: WhatsAppBusinessPhoneNumberId;
      status: EmailStatus;
    }>
  ): ReturnType<WhatsAppDelivery["sendText"]> =>
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
): ((
  request: Readonly<{
    caller: WhatsAppInboundEvent["caller"];
    phoneNumberId: WhatsAppBusinessPhoneNumberId;
    disclosure: DisclosureSnapshot;
    correlationToken: DisclosureDeliveryCorrelationToken;
  }>
) => ReturnType<WhatsAppDelivery["sendText"]>) => {
  const client = makeWhatsAppDelivery({
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
  ): ReturnType<WhatsAppDelivery["sendText"]> =>
    client.sendText({
      businessPhoneNumberId: request.phoneNumberId,
      destination: { recipient: request.caller.businessScopedUserId, sandboxPhone: Option.none() },
      text: TranscriptText.make(request.disclosure.text),
      opaqueCallbackData: Option.some(request.correlationToken),
    });
};
