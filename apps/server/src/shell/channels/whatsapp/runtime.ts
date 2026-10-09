import { buildProactivityTemplateSender } from "~/shell/channels/whatsapp/internal/proactivity-template";
import type { ProactivityTemplateSender } from "./contract";
import { buildWeeklyQuestionSender } from "~/shell/channels/whatsapp/internal/weekly-question";
import { Option, type Redacted } from "effect";
import { buildInsightTemplateSender } from "~/shell/channels/whatsapp/internal/insight-template";
import { type HttpClient } from "effect/http";
import { type WhatsAppBusinessScopedUserId } from "~/core/identity/contract";
import { TranscriptText } from "~/core/agent/contract";
import { makeWhatsAppDelivery as buildDelivery } from "~/shell/channels/whatsapp/internal/kapso-client";
import { type OutboundHttpService, makeKapsoOutboundHttp } from "~/shell/outbound-http/operations";
import {
  type HostedDeliveryCorrelationToken,
  type InsightTemplateSender,
  type WeeklyQuestionSender,
  type WhatsAppBusinessPhoneNumberId,
  type WhatsAppDelivery,
  type WhatsAppInboundEvent,
} from "./contract";

/** Construct with operator-owned approved configuration, never a request's template selection. Missing or invalid configuration disables all delivery. */
export const makeInsightTemplateSender = (
  input: Readonly<{
    configuration: unknown;
    outboundHttp: OutboundHttpService;
  }>
): InsightTemplateSender => buildInsightTemplateSender(input);

/** Freeze and send complete approved category content; stored template identity is checked again before provider egress. */
export const makeProactivityTemplateSender = (
  input: Readonly<{ configuration: unknown; outboundHttp: OutboundHttpService }>
): ProactivityTemplateSender => buildProactivityTemplateSender(input);

/** Build the separately approved full-disclosure sender at the bounded external-provider seam. */
export const makeWeeklyQuestionSender = (
  input: Readonly<{ configuration: unknown; outboundHttp: OutboundHttpService }>
): WeeklyQuestionSender => buildWeeklyQuestionSender(input);

/** One bounded provider attempt; no send acceptance is a delivery receipt. */
export const makeHostedSender = ({
  apiKey,
  httpClient,
}: Readonly<{
  apiKey: Redacted.Redacted<string>;
  httpClient: HttpClient.HttpClient;
}>) => {
  const client = makeWhatsAppDelivery({
    deliveryMode: "bsuid",
    sandboxPhoneNumberId: Option.none(),
    outboundHttp: makeKapsoOutboundHttp({ apiKey, httpClient }),
  });
  return ({
    recipient,
    businessPhoneNumberId,
    text,
    correlationToken,
  }: Readonly<{
    recipient: WhatsAppBusinessScopedUserId;
    businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    text: TranscriptText;
    correlationToken: HostedDeliveryCorrelationToken;
  }>): ReturnType<WhatsAppDelivery["sendText"]> =>
    client.sendText({
      businessPhoneNumberId,
      destination: { recipient, sandboxPhone: Option.none() },
      text,
      opaqueCallbackData: Option.some(correlationToken),
    });
};

/** Build a bounded channel sender at the published Outbound HTTP seam. Production uses BSUID; sandbox routing requires an explicit mode. */
export const makeWhatsAppDelivery: (
  input: Parameters<typeof buildDelivery>[0]
) => WhatsAppDelivery = (input) => buildDelivery(input);

/** Send one fixed, non-secret voice failure reply without using transcript content. */
export const makeVoiceUnavailableSender = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
  }>
): ((
  request: Readonly<{
    caller: WhatsAppInboundEvent["caller"];
    phoneNumberId: WhatsAppBusinessPhoneNumberId;
  }>
) => ReturnType<WhatsAppDelivery["sendText"]>) => {
  const client = makeWhatsAppDelivery({
    deliveryMode: "bsuid",
    sandboxPhoneNumberId: Option.none(),
    outboundHttp: makeKapsoOutboundHttp(input),
  });
  return (
    request: Readonly<{
      caller: WhatsAppInboundEvent["caller"];
      phoneNumberId: WhatsAppBusinessPhoneNumberId;
    }>
  ): ReturnType<WhatsAppDelivery["sendText"]> =>
    client.sendText({
      businessPhoneNumberId: request.phoneNumberId,
      destination: { recipient: request.caller.businessScopedUserId, sandboxPhone: Option.none() },
      text: TranscriptText.make("No pude procesar la nota de voz. Envíala de nuevo o escríbeme."),
      opaqueCallbackData: Option.none(),
    });
};
