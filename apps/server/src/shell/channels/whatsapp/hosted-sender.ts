import { Option, type Redacted } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { TranscriptText } from "~/core/transcript/model";
import type { WhatsAppBusinessScopedUserId } from "~/core/identity/contract";
import { type KapsoClientService, makeKapsoClientService } from "./kapso-client";
import type { HostedDeliveryCorrelationToken, WhatsAppBusinessPhoneNumberId } from "./model";
import { makeKapsoOutboundHttp } from "~/shell/outbound-http/operations";

export { decodeKapsoHostedLifecycleWebhook } from "./kapso-webhook";
export type { KapsoHostedLifecycleEvidence } from "./kapso-webhook";

/** One bounded provider attempt; no send acceptance is a delivery receipt. */
export const makeHostedSender = ({
  apiKey,
  httpClient,
}: Readonly<{
  apiKey: Redacted.Redacted<string>;
  httpClient: HttpClient.HttpClient;
}>) => {
  const client = makeKapsoClientService({
    deliveryMode: "bsuid",
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
  }>): ReturnType<KapsoClientService["sendText"]> =>
    client.sendText({
      businessPhoneNumberId,
      destination: { recipient, sandboxPhone: Option.none() },
      text,
      opaqueCallbackData: Option.some(correlationToken),
    });
};
