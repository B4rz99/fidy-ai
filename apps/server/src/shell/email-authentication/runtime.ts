import { type OutboundHttpService } from "~/shell/outbound-http/operations";
import type { EmailDeliveryPortService } from "./contract";
import { deliverySender } from "~/shell/email-authentication/internal/delivery";

export type { EmailDeliveryPortService, EmailSendFailed } from "./contract";

/** Construct bounded proof delivery using the caller's policy-bearing Outbound HTTP authority. */
export const makeEmailDelivery = (
  input: Readonly<{ outboundHttp: OutboundHttpService }>
): EmailDeliveryPortService =>
  deliverySender({ outboundHttp: input.outboundHttp, from: "Fidy <obarboza@fidyapp.com>" });
