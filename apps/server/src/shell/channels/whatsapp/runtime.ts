import { buildProactivityTemplateSender } from "~/shell/channels/whatsapp/internal/proactivity-template";
import type { ProactivityTemplateSender } from "./contract";
import { buildWeeklyQuestionSender } from "~/shell/channels/whatsapp/internal/weekly-question";
import { Effect, Option, type Redacted } from "effect";
import {
  decodeLifecycleStatus,
  lookupLifecycleStatus,
  projectHostedStatus,
} from "~/shell/channels/whatsapp/internal/kapso-webhook";
import { buildInsightTemplateSender } from "~/shell/channels/whatsapp/internal/insight-template";
import { type HttpClient } from "effect/http";
import { type WhatsAppBusinessScopedUserId } from "~/core/identity/contract";
import { TranscriptText } from "~/core/agent/contract";
import { makeWhatsAppDelivery as buildDelivery } from "~/shell/channels/whatsapp/internal/kapso-client";
import { type OutboundHttpService, makeKapsoOutboundHttp } from "~/shell/outbound-http/operations";
import {
  type HostedDeliveryCorrelationToken,
  type InsightTemplateSender,
  type InvalidWhatsAppPayload,
  type InvalidWhatsAppSignature,
  type WeeklyQuestionSender,
  type WhatsAppBusinessPhoneNumberId,
  type WhatsAppDelivery,
  type WhatsAppDeliveryLookup,
  type WhatsAppDisclosureLifecycleEvidence,
  type WhatsAppHostedLifecycleEvidence,
  type WhatsAppInboundEvent,
  type WhatsAppLifecycleAuthentication,
  type WhatsAppPayloadTooLarge,
  type WhatsAppStatusLookupAdmission,
  type WhatsAppStatusUnavailable,
} from "./contract";

/** Authenticate lifecycle proof before exposing metadata. Signed v2 hints without history require
 * one fixed-origin, 64 KiB provider read within eight seconds; read/sent never prove delivery.
 * Invalid signature, malformed history or mismatching provider coordinates fail before state changes.
 */
export const makeLifecycleVerifier = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
    admitLookup: WhatsAppStatusLookupAdmission;
  }>
): ((
  authentication: WhatsAppLifecycleAuthentication
) => Effect.Effect<
  WhatsAppHostedLifecycleEvidence,
  | InvalidWhatsAppPayload
  | InvalidWhatsAppSignature
  | WhatsAppPayloadTooLarge
  | WhatsAppStatusUnavailable
>) => {
  const lookup = makeKapsoOutboundHttp(input);
  return Effect.fn(function* (authentication: WhatsAppLifecycleAuthentication) {
    return projectHostedStatus(
      yield* decodeLifecycleStatus(authentication, Option.some(lookup), input.admitLookup)
    );
  });
};

/** Read one stored attempt's provider history within eight seconds and 64 KiB. Only a matching
 * delivered receipt is returned; no receipt returns None. The caller must authorize and bound reads
 * before calling. Invalid coordinates/proof or unavailable transport cannot authorize delivery.
 */
export const makeDeliveryVerifier = (
  input: Readonly<{ apiKey: Redacted.Redacted<string>; httpClient: HttpClient.HttpClient }>
): ((
  request: WhatsAppDeliveryLookup
) => Effect.Effect<
  Option.Option<WhatsAppDisclosureLifecycleEvidence>,
  InvalidWhatsAppPayload | WhatsAppStatusUnavailable
>) => {
  const outboundHttp = makeKapsoOutboundHttp(input);
  return Effect.fn(function* (request: WhatsAppDeliveryLookup) {
    const verified = yield* lookupLifecycleStatus({
      ...request,
      outboundHttp,
      status: "delivered",
    });
    return Option.flatMap(verified, (latest) =>
      latest.evidence.correlationToken === request.correlationToken
        ? Option.some(latest.evidence)
        : Option.none()
    );
  });
};

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
