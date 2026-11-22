import { Context, Effect, Layer, Option, type Redacted } from "effect";
import { HttpClient } from "effect/http";
import { TranscriptText } from "~/core/agent/contract";
import type { WhatsAppDelivery, WhatsAppInboundEvent } from "~/shell/channels/whatsapp/contract";
import { makeWhatsAppDelivery } from "~/shell/channels/whatsapp/runtime";
import { makeKapsoOutboundHttp } from "~/shell/outbound-http/operations";

export const makeProviderHandoffSender = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
    sandboxPhoneNumberId: Option.Option<string>;
  }>
): ((
  input: Readonly<{ event: WhatsAppInboundEvent; text: string }>
) => ReturnType<WhatsAppDelivery["sendText"]>) => {
  const client = makeWhatsAppDelivery({
    deliveryMode: "bsuid",
    sandboxPhoneNumberId: input.sandboxPhoneNumberId,
    outboundHttp: makeKapsoOutboundHttp(input),
  });

  return ({ event, text }) =>
    client.sendText({
      confirmation: Option.none(),
      businessPhoneNumberId: event.businessPhoneNumberId,
      destination: {
        recipient: event.caller.businessScopedUserId,
        sandboxPhone: event.caller.phoneNumber,
      },
      text: TranscriptText.make(text),
      opaqueCallbackData: Option.none(),
    });
};

export class ProviderHandoffSender extends Context.Service<
  ProviderHandoffSender,
  ReturnType<typeof makeProviderHandoffSender>
>()("@fidy/server/shell/provider-authentication/runtime/ProviderHandoffSender") {
  static readonly make = (
    input: Readonly<{
      apiKey: Redacted.Redacted<string>;
      sandboxPhoneNumberId: Option.Option<string>;
    }>
  ): Effect.Effect<ReturnType<typeof makeProviderHandoffSender>, never, HttpClient.HttpClient> =>
    Effect.map(Effect.service(HttpClient.HttpClient), (httpClient) =>
      makeProviderHandoffSender({ ...input, httpClient })
    );

  static readonly layer = (
    input: Parameters<typeof ProviderHandoffSender.make>[0]
  ): Layer.Layer<ProviderHandoffSender, never, HttpClient.HttpClient> =>
    Layer.effect(ProviderHandoffSender, ProviderHandoffSender.make(input));
}
