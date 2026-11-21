import { buildProactivityTemplateSender } from "~/shell/channels/whatsapp/internal/proactivity-template";
import type { ProactivityTemplateSender } from "./contract";
import { buildWeeklyQuestionSender } from "~/shell/channels/whatsapp/internal/weekly-question";
import { Context, Effect, Layer, Option, type Redacted } from "effect";
import {
  LookupCorrelation,
  decodeLifecycleStatus,
  lookupLifecycleStatus,
  projectHostedStatus,
} from "~/shell/channels/whatsapp/internal/kapso-webhook";
import { buildInsightTemplateSender } from "~/shell/channels/whatsapp/internal/insight-template";
import { HttpClient } from "effect/http";
import { type E164PhoneNumber, type WhatsAppBusinessScopedUserId } from "~/core/identity/contract";
import { TranscriptText } from "~/core/agent/contract";
import { makeWhatsAppDelivery as buildDelivery } from "~/shell/channels/whatsapp/internal/kapso-client";
import {
  OutboundHttp,
  type OutboundHttpService,
  makeKapsoOutboundHttp,
} from "~/shell/outbound-http/operations";
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

export const lifecycleVerifier = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
    admitLookup: WhatsAppStatusLookupAdmission;
  }>
): ((
  authentication: WhatsAppLifecycleAuthentication
) => Effect.Effect<
  Option.Option<WhatsAppHostedLifecycleEvidence>,
  | InvalidWhatsAppPayload
  | InvalidWhatsAppSignature
  | WhatsAppPayloadTooLarge
  | WhatsAppStatusUnavailable
>) => {
  const lookup = makeKapsoOutboundHttp(input);

  return Effect.fn(function* (authentication: WhatsAppLifecycleAuthentication) {
    return Option.map(
      yield* decodeLifecycleStatus(authentication, Option.some(lookup), input.admitLookup),
      projectHostedStatus
    );
  });
};

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

    return LookupCorrelation.$is("Correlated")(verified) &&
      verified.value.evidence.correlationToken === request.correlationToken
      ? Option.some(verified.value.evidence)
      : Option.none();
  });
};

export const makeInsightTemplateSender = (
  input: Readonly<{
    configuration: unknown;
    outboundHttp: OutboundHttpService;
  }>
): InsightTemplateSender => buildInsightTemplateSender(input);

export const makeProactivityTemplateSender = (
  input: Readonly<{ configuration: unknown; outboundHttp: OutboundHttpService }>
): ProactivityTemplateSender => buildProactivityTemplateSender(input);

export const makeWeeklyQuestionSender = (
  input: Readonly<{ configuration: unknown; outboundHttp: OutboundHttpService }>
): WeeklyQuestionSender => buildWeeklyQuestionSender(input);

export const makeHostedSender = ({
  apiKey,
  httpClient,
  sandboxPhoneNumberId,
}: Readonly<{
  apiKey: Redacted.Redacted<string>;
  httpClient: HttpClient.HttpClient;
  sandboxPhoneNumberId: Option.Option<string>;
}>) => {
  const client = makeWhatsAppDelivery({
    deliveryMode: "bsuid",
    sandboxPhoneNumberId,
    outboundHttp: makeKapsoOutboundHttp({ apiKey, httpClient }),
  });

  return ({
    recipient,
    sandboxPhone,
    businessPhoneNumberId,
    text,
    correlationToken,
    confirmation,
  }: Readonly<{
    recipient: WhatsAppBusinessScopedUserId;
    sandboxPhone: Option.Option<E164PhoneNumber>;
    businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    text: TranscriptText;
    confirmation: Parameters<WhatsAppDelivery["sendText"]>[0]["confirmation"];
    correlationToken: HostedDeliveryCorrelationToken;
  }>): ReturnType<WhatsAppDelivery["sendText"]> =>
    client.sendText({
      businessPhoneNumberId,
      destination: { recipient, sandboxPhone },
      text,
      opaqueCallbackData: Option.some(correlationToken),
      confirmation,
    });
};

export const makeWhatsAppDelivery: (
  input: Parameters<typeof buildDelivery>[0]
) => WhatsAppDelivery = (input) => buildDelivery(input);

export const voiceUnavailableSender = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
    sandboxPhoneNumberId: Option.Option<string>;
  }>
): ((
  request: Readonly<{
    caller: WhatsAppInboundEvent["caller"];
    phoneNumberId: WhatsAppBusinessPhoneNumberId;
  }>
) => ReturnType<WhatsAppDelivery["sendText"]>) => {
  const client = makeWhatsAppDelivery({
    deliveryMode: "bsuid",
    sandboxPhoneNumberId: input.sandboxPhoneNumberId,
    outboundHttp: makeKapsoOutboundHttp(input),
  });

  return (
    request: Readonly<{
      caller: WhatsAppInboundEvent["caller"];
      phoneNumberId: WhatsAppBusinessPhoneNumberId;
    }>
  ): ReturnType<WhatsAppDelivery["sendText"]> =>
    client.sendText({
      confirmation: Option.none(),
      businessPhoneNumberId: request.phoneNumberId,
      destination: {
        recipient: request.caller.businessScopedUserId,
        sandboxPhone: request.caller.phoneNumber,
      },
      text: TranscriptText.make("No pude procesar la nota de voz. Envíala de nuevo o escríbeme."),
      opaqueCallbackData: Option.none(),
    });
};

export class HostedSender extends Context.Service<
  HostedSender,
  ReturnType<typeof makeHostedSender>
>()("@fidy/server/shell/channels/whatsapp/runtime/HostedSender") {
  static readonly make = (
    input: Readonly<{
      apiKey: Redacted.Redacted<string>;
      sandboxPhoneNumberId: Option.Option<string>;
    }>
  ): Effect.Effect<ReturnType<typeof makeHostedSender>, never, HttpClient.HttpClient> =>
    Effect.map(Effect.service(HttpClient.HttpClient), (httpClient) =>
      makeHostedSender({ ...input, httpClient })
    );

  static readonly layer = (
    input: Parameters<typeof HostedSender.make>[0]
  ): Layer.Layer<HostedSender, never, HttpClient.HttpClient> =>
    Layer.effect(HostedSender, HostedSender.make(input));
}

type TemplateSendersService = Readonly<{
  insight: (configuration: unknown) => InsightTemplateSender;
  proactivity: (configuration: unknown) => ProactivityTemplateSender;
  weeklyQuestion: (configuration: unknown) => WeeklyQuestionSender;
}>;

export class TemplateSenders extends Context.Service<TemplateSenders, TemplateSendersService>()(
  "@fidy/server/shell/channels/whatsapp/runtime/TemplateSenders"
) {
  static readonly make: Effect.Effect<TemplateSendersService, never, OutboundHttp> = Effect.map(
    Effect.service(OutboundHttp),
    (outboundHttp) => ({
      insight: (configuration: unknown) =>
        buildInsightTemplateSender({ configuration, outboundHttp }),
      proactivity: (configuration: unknown) =>
        buildProactivityTemplateSender({ configuration, outboundHttp }),
      weeklyQuestion: (configuration: unknown) =>
        buildWeeklyQuestionSender({ configuration, outboundHttp }),
    })
  );

  static readonly layer: Layer.Layer<TemplateSenders, never, OutboundHttp> = Layer.effect(
    this,
    this.make
  );
}
