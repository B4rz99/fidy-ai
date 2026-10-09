import { Option, type Redacted } from "effect";
import type { HttpClient } from "effect/http";
import { TranscriptText } from "~/core/agent/contract";
import type { WhatsAppDelivery, WhatsAppInboundEvent } from "~/shell/channels/whatsapp/contract";
import { makeWhatsAppDelivery } from "~/shell/channels/whatsapp/runtime";
import { makeKapsoOutboundHttp } from "~/shell/outbound-http/operations";

/** Deliver to the authenticated caller; only the configured sandbox endpoint uses its observed phone. */
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
      businessPhoneNumberId: event.businessPhoneNumberId,
      destination: {
        recipient: event.caller.businessScopedUserId,
        sandboxPhone: event.caller.phoneNumber,
      },
      text: TranscriptText.make(text),
      opaqueCallbackData: Option.none(),
    });
};
