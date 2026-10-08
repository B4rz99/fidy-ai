import { Option, type Redacted } from "effect";
import type { HttpClient } from "effect/http";
import { TranscriptText } from "~/core/agent/contract";
import type { WhatsAppDelivery, WhatsAppInboundEvent } from "~/shell/channels/whatsapp/contract";
import { makeWhatsAppDelivery } from "~/shell/channels/whatsapp/runtime";
import { makeKapsoOutboundHttp } from "~/shell/outbound-http/operations";

/** Deliver one owner-prepared public handoff or immutable association review only to its authenticated BSUID. */
export const makeProviderHandoffSender = (
  input: Readonly<{ apiKey: Redacted.Redacted<string>; httpClient: HttpClient.HttpClient }>
): ((
  input: Readonly<{ event: WhatsAppInboundEvent; text: string }>
) => ReturnType<WhatsAppDelivery["sendText"]>) => {
  const client = makeWhatsAppDelivery({
    deliveryMode: "bsuid",
    outboundHttp: makeKapsoOutboundHttp(input),
  });
  return ({ event, text }) =>
    client.sendText({
      businessPhoneNumberId: event.businessPhoneNumberId,
      destination: { recipient: event.caller.businessScopedUserId, sandboxPhone: Option.none() },
      text: TranscriptText.make(text),
      opaqueCallbackData: Option.none(),
    });
};
