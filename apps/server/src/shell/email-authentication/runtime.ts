import type { Redacted } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { type OutboundHttpService, makeResendOutboundHttp } from "~/shell/outbound-http/operations";
import type { EmailDeliveryPortService } from "./contract";
import { deliverySender } from "~/shell/email-authentication/internal/delivery";

export type { EmailDeliveryPortService, EmailSendFailed } from "./contract";

/** Construct bounded proof delivery using the caller's policy-bearing Outbound HTTP authority. */
export const makeEmailDelivery = (
  input: Readonly<{ outboundHttp: OutboundHttpService }>
): EmailDeliveryPortService =>
  deliverySender({ outboundHttp: input.outboundHttp, from: "Fidy <obarboza@fidyapp.com>" });

/** Construct proof delivery with one Resend credential and the published bounded transport policy. */
export const makeOnboardingEmailDelivery = (
  input: Readonly<{ apiKey: Redacted.Redacted<string>; httpClient: HttpClient.HttpClient }>
): EmailDeliveryPortService => makeEmailDelivery({ outboundHttp: makeResendOutboundHttp(input) });
