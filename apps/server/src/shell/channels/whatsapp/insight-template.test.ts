import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { makeInsightTemplateSender } from "./runtime";
import { HostedDeliveryCorrelationToken, WhatsAppBusinessPhoneNumberId } from "./contract";
import { WhatsAppBusinessScopedUserId } from "~/core/identity/contract";

const configuration = {
  name: "fidy_weekly_summary",
  language: "es",
  approval: "approved",
  body: "Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy.",
};
const request = {
  recipient: WhatsAppBusinessScopedUserId.make("CO.573001234567"),
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
  correlationToken: HostedDeliveryCorrelationToken.make("11111111-1111-4111-8111-111111111111"),
  summary: {
    period: "1–7 de junio",
    currencies: ["COP", "USD"],
    sections: [
      { currency: "COP", text: "Ingresos 100000; salidas 50000" },
      { currency: "USD", text: "Ingresos 20; salidas 5" },
    ],
  },
};
it.effect(
  "starts unenabled without an approved full-summary template and makes no provider call",
  () =>
    Effect.gen(function* () {
      let called = false;
      const sender = makeInsightTemplateSender({
        configuration: undefined,
        outboundHttp: {
          execute: () => {
            called = true;
            return Effect.die("must not send");
          },
        },
      });
      expect(Exit.isFailure(yield* Effect.exit(sender.send(request)))).toBe(true);
      expect(called).toBe(false);
    })
);

it.effect(
  "sends every Currency in one configured template and exposes the exact visible text",
  () =>
    Effect.gen(function* () {
      let body = "";
      const sender = makeInsightTemplateSender({
        configuration,
        outboundHttp: {
          execute: (input) => {
            if (input._tag !== "KapsoMessages") return Effect.die("wrong provider");
            body = input.body;
            return Effect.succeed({
              status: 200,
              headers: {},
              body: new TextEncoder().encode(
                '{"messaging_product":"whatsapp","messages":[{"id":"wamid.summary"}]}'
              ),
            });
          },
        },
      });
      const prepared = yield* sender.prepare(request.summary);
      expect(prepared.text).toBe(
        "Tu resumen semanal: 1–7 de junio · COP: Ingresos 100000; salidas 50000 · USD: Ingresos 20; salidas 5 Consulta tus movimientos en Fidy."
      );
      yield* sender.send(request);
      expect(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(body)).toEqual({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        recipient: "CO.573001234567",
        type: "template",
        biz_opaque_callback_data: request.correlationToken,
        template: {
          name: "fidy_weekly_summary",
          language: { code: "es" },
          components: [{ type: "body", parameters: [{ type: "text", text: prepared.parameter }] }],
        },
      });
    })
);
