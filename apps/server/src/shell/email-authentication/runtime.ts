import { type OutboundHttpService } from "~/shell/outbound-http/operations";
import type { EmailDeliveryPortService } from "./contract";
import { deliverySender } from "~/shell/email-authentication/internal/delivery";

export type { EmailDeliveryPortService, EmailSendFailed } from "./contract";

export const makeEmailDelivery = (
  input: Readonly<{ outboundHttp: OutboundHttpService }>
): EmailDeliveryPortService =>
  deliverySender({ outboundHttp: input.outboundHttp, from: "Fidy <obarboza@fidyapp.com>" });
