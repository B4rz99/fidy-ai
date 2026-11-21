import { Context, Effect, Layer } from "effect";
import { OutboundHttp, type OutboundHttpService } from "~/shell/outbound-http/operations";
import type { EmailDeliveryPortService } from "./contract";
import { deliverySender } from "~/shell/email-authentication/internal/delivery";

export type { EmailDeliveryPortService, EmailSendFailed } from "./contract";

export const makeEmailDelivery = (
  input: Readonly<{ outboundHttp: OutboundHttpService }>
): EmailDeliveryPortService =>
  deliverySender({ outboundHttp: input.outboundHttp, from: "Fidy <obarboza@fidyapp.com>" });

export class EmailDelivery extends Context.Service<EmailDelivery, EmailDeliveryPortService>()(
  "@fidy/server/shell/email-authentication/runtime/EmailDelivery"
) {
  static readonly make: Effect.Effect<EmailDeliveryPortService, never, OutboundHttp> = Effect.map(
    Effect.service(OutboundHttp),
    (outboundHttp) => makeEmailDelivery({ outboundHttp })
  );

  static readonly layer: Layer.Layer<EmailDelivery, never, OutboundHttp> = Layer.effect(
    this,
    this.make
  );
}
