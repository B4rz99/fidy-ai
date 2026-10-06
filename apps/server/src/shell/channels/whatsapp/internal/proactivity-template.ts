import { Effect, Option, Schema } from "effect";
import { TranscriptText } from "~/core/agent/contract";
import { type OutboundHttpService } from "~/shell/outbound-http/operations";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import {
  InsightTemplateUnavailable,
  PreparedProactivityTemplate,
  ProactivityTemplateConfiguration,
  type ProactivityTemplateSender,
} from "~/shell/channels/whatsapp/contract";
import { sendKapsoMessage } from "./kapso-client";

export const buildProactivityTemplateSender = (
  input: Readonly<{ configuration: unknown; outboundHttp: OutboundHttpService }>
): ProactivityTemplateSender => {
  const configuration = Schema.decodeUnknownOption(ProactivityTemplateConfiguration)(
    input.configuration
  );
  return {
    prepare: (parameter) =>
      Effect.gen(function* () {
        if (Option.isNone(configuration)) return yield* new InsightTemplateUnavailable();
        const content = yield* Schema.decodeUnknownEffect(TranscriptText)(parameter);
        return yield* Schema.decodeEffect(PreparedProactivityTemplate)({
          name: configuration.value.name,
          language: configuration.value.language,
          parameter: content,
          text: `Fidy: ${content}`,
        });
      }).pipe(Effect.mapError(() => new InsightTemplateUnavailable())),
    send: (request) =>
      Effect.gen(function* () {
        const template = yield* Schema.decodeEffect(PreparedProactivityTemplate)(request.template);
        if (Option.isNone(configuration) || template.name !== configuration.value.name) {
          return yield* new InsightTemplateUnavailable();
        }
        const body = yield* Schema.encodeEffect(UnknownJsonString)({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          recipient: request.recipient,
          type: "template",
          biz_opaque_callback_data: request.correlationToken,
          template: {
            name: template.name,
            language: { code: template.language },
            components: [
              { type: "body", parameters: [{ type: "text", text: template.parameter }] },
            ],
          },
        });
        return yield* sendKapsoMessage({
          outboundHttp: input.outboundHttp,
          businessPhoneNumberId: request.businessPhoneNumberId,
          body,
        });
      }).pipe(
        Effect.mapError((failure) =>
          failure._tag === "WhatsAppSendFailed" ? failure : new InsightTemplateUnavailable()
        )
      ),
  };
};
