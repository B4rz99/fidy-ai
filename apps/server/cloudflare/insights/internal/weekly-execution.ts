import { Cause, Exit, Option } from "effect";
import {
  type InsightTemplateUnavailable,
  type WhatsAppProviderMessageId,
  type WhatsAppSendFailed,
  type WhatsAppSentMessage,
} from "../../../src/shell/channels/whatsapp/contract";

type SendEvidence = Readonly<{
  certainty: "accepted" | "ambiguous" | "rejected";
  providerMessageId: Option.Option<WhatsAppProviderMessageId>;
}>;
export const sendEvidence = (
  sent: Exit.Exit<WhatsAppSentMessage, InsightTemplateUnavailable | WhatsAppSendFailed>
): SendEvidence => {
  if (Exit.isSuccess(sent)) {
    return {
      certainty: "accepted" as const,
      providerMessageId: Option.some(sent.value.messageEvidence.providerMessageId),
    };
  }
  const certainty = Option.match(Cause.findErrorOption(sent.cause), {
    onNone: () => "ambiguous" as const,
    onSome: (failure) =>
      failure._tag === "WhatsAppSendFailed" ? failure.deliveryCertainty : ("rejected" as const),
  });
  return { certainty, providerMessageId: Option.none() };
};
