import { Effect, Option, Schema } from "effect";
import { TranscriptText } from "~/core/agent/contract";
import { type OutboundHttpService } from "~/shell/outbound-http/operations";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import {
  InsightTemplateConfiguration,
  type InsightTemplateSender,
  InsightTemplateSummary,
  InsightTemplateUnavailable,
} from "~/shell/channels/whatsapp/contract";
import { sendKapsoMessage } from "./kapso-client";

const maximumTemplateLength = 1024;
const maximumTemplateBytes = 4096;

export const buildInsightTemplateSender = (
  input: Readonly<{
    configuration: unknown;
    outboundHttp: OutboundHttpService;
  }>
): InsightTemplateSender => {
  const configuration = Schema.decodeUnknownOption(InsightTemplateConfiguration)(
    input.configuration
  );
  const prepare: InsightTemplateSender["prepare"] = (summary) =>
    Effect.gen(function* () {
      if (Option.isNone(configuration)) return yield* new InsightTemplateUnavailable();
      const decoded = yield* Schema.decodeUnknownEffect(InsightTemplateSummary)(summary).pipe(
        Effect.mapError(() => new InsightTemplateUnavailable())
      );
      const parameter = [
        decoded.period,
        ...decoded.sections.map((section) => `${section.currency}: ${section.text}`),
      ].join(" · ");
      const text = configuration.value.body.replace("{{1}}", parameter);
      // Conservative UTF-16 and actual UTF-8 bounds; never clip or omit a section.
      if (
        text.length > maximumTemplateLength ||
        new TextEncoder().encode(text).byteLength > maximumTemplateBytes
      ) {
        return yield* new InsightTemplateUnavailable();
      }
      return { parameter, text: TranscriptText.make(text) };
    });
  return {
    prepare,
    send: (request) =>
      Effect.gen(function* () {
        const prepared = yield* prepare(request.summary);
        if (Option.isNone(configuration)) return yield* new InsightTemplateUnavailable();
        const body = yield* Schema.encodeEffect(UnknownJsonString)({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          recipient: request.recipient,
          type: "template",
          biz_opaque_callback_data: request.correlationToken,
          template: {
            name: configuration.value.name,
            language: { code: configuration.value.language },
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
