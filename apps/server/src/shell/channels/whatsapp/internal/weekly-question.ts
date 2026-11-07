import { Effect, Option, Schema } from "effect";
import { TranscriptText } from "~/core/agent/contract";
import {
  InsightTemplateUnavailable,
  ProactivityTemplateParameter,
  type WeeklyQuestionSender,
  WeeklyQuestionTemplateConfiguration,
  proactivityTemplateBody,
} from "~/shell/channels/whatsapp/contract";
import { type OutboundHttpService } from "~/shell/outbound-http/operations";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { sendKapsoMessage } from "./kapso-client";

const maximumQuestionLength = 1024;
const maximumQuestionBytes = 4096;

export const buildWeeklyQuestionSender = (
  input: Readonly<{ configuration: unknown; outboundHttp: OutboundHttpService }>
): WeeklyQuestionSender => {
  const configuration = Schema.decodeUnknownOption(WeeklyQuestionTemplateConfiguration)(
    input.configuration
  );
  const prepare: WeeklyQuestionSender["prepare"] = (offer) =>
    Effect.gen(function* () {
      if (Option.isNone(configuration)) return yield* new InsightTemplateUnavailable();
      const parameter = yield* Schema.decodeEffect(ProactivityTemplateParameter)(
        `¿quieres que te siga enviando esto? ${offer.disclosure.text} Aceptar o continuar: ${offer.acceptChoice} Rechazar: ${offer.declineChoice}`
      );
      const text = proactivityTemplateBody.replace("{{1}}", () => parameter);
      if (
        text.length > maximumQuestionLength ||
        new TextEncoder().encode(text).byteLength > maximumQuestionBytes
      ) {
        return yield* new InsightTemplateUnavailable();
      }
      return { parameter, text: TranscriptText.make(text) };
    }).pipe(Effect.mapError(() => new InsightTemplateUnavailable()));
  return {
    prepare,
    send: (request) =>
      Effect.gen(function* () {
        const prepared = yield* prepare(request.offer);
        if (Option.isNone(configuration)) return yield* new InsightTemplateUnavailable();
        const body = yield* Schema.encodeEffect(UnknownJsonString)({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          recipient: request.recipient,
          type: "template",
          biz_opaque_callback_data: request.correlationToken,
          template: {
            name: configuration.value.name,
            language: "es",
            components: [
              { type: "body", parameters: [{ type: "text", text: prepared.parameter }] },
            ],
          },
        }).pipe(Effect.mapError(() => new InsightTemplateUnavailable()));
        return yield* sendKapsoMessage({
          outboundHttp: input.outboundHttp,
          businessPhoneNumberId: request.businessPhoneNumberId,
          body,
        });
      }),
  };
};
