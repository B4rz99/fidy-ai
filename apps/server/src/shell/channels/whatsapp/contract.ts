import { type HostedTurnConfirmation } from "~/shell/agent/contract";
import {
  Data,
  type DateTime,
  type Effect,
  type Array as EffectArray,
  type Option,
  type Redacted,
  Schema,
  Struct,
} from "effect";
import {
  E164PhoneNumber,
  WhatsAppBusinessPhoneNumberId,
  type WhatsAppBusinessScopedUserId,
  WhatsAppCallerReference,
  WhatsAppParentBusinessScopedUserId,
  WhatsAppUsername,
} from "~/core/identity/contract";
import {
  type DisclosureDeliveryCorrelationToken,
  ProviderMessageEvidence,
  WhatsAppProviderMessageId,
} from "~/core/provider-evidence/contract";
import { TranscriptText } from "~/core/agent/contract";
import { ConsentRecordId, DisclosureSnapshot } from "~/core/consent/contract";
import { Currency } from "~/core/_shared/money";
import { type TelemetryHttpStatus } from "~/shell/observability/contract";

const maximumProviderIdentifierLength = 256;

export const InsightTemplateConfiguration = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,511}$/u)),
  language: Schema.Literal("es"),
  approval: Schema.Literal("approved"),
  body: Schema.Literal("Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy."),
});

export type InsightTemplateConfiguration = typeof InsightTemplateConfiguration.Type;

export const proactivityTemplateBody = "Fidy te avisa: {{1}} Más en Fidy.";

export const ProactivityTemplateConfiguration = Schema.Struct({
  name: InsightTemplateConfiguration.fields.name,
  language: Schema.Literal("es"),
  approval: Schema.Literal("approved"),
  body: Schema.Literal(proactivityTemplateBody),
});

const maximumProactivityLength = 1024;

const maximumProactivityParameterLength =
  maximumProactivityLength - proactivityTemplateBody.replace("{{1}}", "").length;

export const ProactivityTemplateParameter = Schema.String.check(
  Schema.isMaxLength(maximumProactivityParameterLength),
  Schema.makeFilter((text) => !/[\r\n\t]| {5}/u.test(text))
);

export const PreparedProactivityTemplate = Schema.Struct({
  name: ProactivityTemplateConfiguration.fields.name,
  language: Schema.Literal("es"),
  parameter: ProactivityTemplateParameter,
  text: TranscriptText,
}).check(
  Schema.makeFilter(
    (value) => value.text === proactivityTemplateBody.replace("{{1}}", () => value.parameter)
  )
);

export type PreparedProactivityTemplate = typeof PreparedProactivityTemplate.Type;

export type ProactivityTemplateSender = Readonly<{
  prepare: (
    text: unknown
  ) => Effect.Effect<PreparedProactivityTemplate, InsightTemplateUnavailable>;
  send: (
    request: Readonly<{
      recipient: WhatsAppBusinessScopedUserId;
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
      correlationToken: HostedDeliveryCorrelationToken;
      template: PreparedProactivityTemplate;
    }>
  ) => Effect.Effect<WhatsAppSentMessage, InsightTemplateUnavailable | WhatsAppSendFailed>;
}>;

export const WeeklyQuestionTemplateConfiguration = Schema.Struct({
  name: InsightTemplateConfiguration.fields.name,
  language: Schema.Literal("es"),
  approval: Schema.Literal("approved"),
  body: Schema.Literal(proactivityTemplateBody),
});

export const WeeklyQuestionOffer = Schema.Struct({
  id: ConsentRecordId,
  disclosure: DisclosureSnapshot,
  acceptChoice: Schema.String,
  declineChoice: Schema.String,
});

export type WeeklyQuestionSender = Readonly<{
  prepare: (
    offer: typeof WeeklyQuestionOffer.Type
  ) => Effect.Effect<
    Readonly<{ parameter: string; text: TranscriptText }>,
    InsightTemplateUnavailable
  >;
  send: (
    input: Readonly<{
      recipient: WhatsAppBusinessScopedUserId;
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
      correlationToken: HostedDeliveryCorrelationToken;
      offer: typeof WeeklyQuestionOffer.Type;
    }>
  ) => Effect.Effect<WhatsAppSentMessage, InsightTemplateUnavailable | WhatsAppSendFailed>;
}>;

const maximumTemplateLength = 1024;

const SummaryPart = TranscriptText.check(
  Schema.isMaxLength(maximumTemplateLength),
  Schema.isPattern(/^[^\r\n\t]+$/u)
);

export const InsightTemplateSummary = Schema.Struct({
  period: SummaryPart,
  currencies: Schema.NonEmptyArray(Currency),
  sections: Schema.NonEmptyArray(Schema.Struct({ currency: Currency, text: SummaryPart })),
}).check(
  Schema.makeFilter((summary) => {
    const keys = summary.currencies;

    return (
      (keys.every(
        (key, index) =>
          (index === 0 || (keys[index - 1] ?? key) < key) &&
          summary.sections[index]?.currency === key
      ) &&
        keys.length === summary.sections.length) ||
      "Expected every Currency exactly once in alphabetic order"
    );
  })
);

export type InsightTemplateSummary = typeof InsightTemplateSummary.Type;

export class InsightTemplateUnavailable extends Data.TaggedError("InsightTemplateUnavailable")<{
  readonly cause: unknown;
}> {}

export type InsightTemplateSender = Readonly<{
  prepare: (
    summary: unknown
  ) => Effect.Effect<
    Readonly<{ parameter: string; text: TranscriptText }>,
    InsightTemplateUnavailable
  >;
  send: (
    input: Readonly<{
      recipient: WhatsAppBusinessScopedUserId;
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
      correlationToken: HostedDeliveryCorrelationToken;
      summary: unknown;
    }>
  ) => Effect.Effect<WhatsAppSentMessage, InsightTemplateUnavailable | WhatsAppSendFailed>;
}>;

export { WhatsAppBusinessPhoneNumberId, WhatsAppProviderMessageId };

export const WhatsAppInboundJobId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("WhatsAppInboundJobId")
);

export type WhatsAppInboundJobId = typeof WhatsAppInboundJobId.Type;

export const WhatsAppDeliveryKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumProviderIdentifierLength)
).pipe(Schema.brand("WhatsAppDeliveryKey"));

export type WhatsAppDeliveryKey = typeof WhatsAppDeliveryKey.Type;

export const WhatsAppMessageEvidence = Schema.Struct({
  ...ProviderMessageEvidence.fields,
  channel: Schema.Literal("whatsapp"),
  providerMessageId: WhatsAppProviderMessageId,
}).annotate({ identifier: "WhatsAppMessageEvidence" });

export type WhatsAppMessageEvidence = typeof WhatsAppMessageEvidence.Type;

export const WhatsAppMediaId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumProviderIdentifierLength)
).pipe(Schema.brand("WhatsAppMediaId"));

export type WhatsAppMediaId = typeof WhatsAppMediaId.Type;

export const WhatsAppCaller = Schema.Struct({
  ...WhatsAppCallerReference.fields,
  parentBusinessScopedUserId: Schema.Option(WhatsAppParentBusinessScopedUserId),
  username: Schema.Option(WhatsAppUsername),
  phoneNumber: Schema.Option(E164PhoneNumber),
}).annotate({ identifier: "WhatsAppCaller" });

export type WhatsAppCaller = typeof WhatsAppCaller.Type;

export const WhatsAppDocumentFileName = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumProviderIdentifierLength)
);

export const WhatsAppDocument = Schema.TaggedStruct("Document", {
  mediaId: WhatsAppMediaId,
  fileName: Schema.Option(WhatsAppDocumentFileName),
  caption: Schema.Option(TranscriptText),
});

export type WhatsAppDocument = typeof WhatsAppDocument.Type;

export const WhatsAppText = Schema.TaggedStruct("Text", { text: TranscriptText });

export const WhatsAppVoiceTranscript = Schema.TaggedStruct("VoiceTranscript", {
  text: TranscriptText,
  mediaId: WhatsAppMediaId,
});

export const WhatsAppUnusableVoiceTranscript = Schema.TaggedStruct("UnusableVoiceTranscript", {});

export const WhatsAppImage = Schema.TaggedStruct("Image", {
  mediaId: WhatsAppMediaId,
  caption: Schema.Option(TranscriptText),
});

export type WhatsAppInboundContent =
  | WhatsAppDocument
  | typeof WhatsAppText.Type
  | typeof WhatsAppVoiceTranscript.Type
  | typeof WhatsAppUnusableVoiceTranscript.Type
  | typeof WhatsAppImage.Type;

export const HostedDeliveryCorrelationToken = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("HostedDeliveryCorrelationToken")
);

export type HostedDeliveryCorrelationToken = typeof HostedDeliveryCorrelationToken.Type;

export type WhatsAppInboundEvent = Readonly<{
  readonly messageEvidence: WhatsAppMessageEvidence;
  readonly caller: WhatsAppCaller;
  readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  readonly occurredAt: DateTime.Utc;
  readonly receivedAt: DateTime.Utc;
  readonly content: WhatsAppInboundContent;
  readonly replyToMessageId: Option.Option<WhatsAppProviderMessageId>;
}>;

const WhatsAppCallerReplacement = WhatsAppCaller.mapFields(
  Struct.omit(["businessPortfolioId"])
).annotate({ identifier: "WhatsAppCallerReplacement" });

export type WhatsAppIdentityChangeEvent = Readonly<{
  readonly messageEvidence: WhatsAppMessageEvidence;
  readonly previousCaller: WhatsAppCallerReference;
  readonly replacement: typeof WhatsAppCallerReplacement.Type;
  readonly occurredAt: DateTime.Utc;
}>;

export type WhatsAppWebhookReceipt = Readonly<{
  readonly deliveryKey: WhatsAppDeliveryKey;
  readonly events: EffectArray.NonEmptyReadonlyArray<WhatsAppInboundEvent>;
}>;

export { DisclosureDeliveryCorrelationToken } from "~/core/provider-evidence/contract";

export type WhatsAppDeliveryCertainty = "rejected" | "ambiguous";

export class WhatsAppSendFailed extends Data.TaggedError("WhatsAppSendFailed")<{
  readonly safeReason: DisclosureDeliveryFailureReason;
  readonly deliveryCertainty: WhatsAppDeliveryCertainty;
  readonly automaticRetry: boolean;
  readonly responseStatus: Option.Option<TelemetryHttpStatus>;
}> {
  override get message(): string {
    return `Kapso send failed: ${this.safeReason} (${this.deliveryCertainty})`;
  }
}

export type WhatsAppSentMessage = Readonly<{
  readonly messageEvidence: WhatsAppMessageEvidence;
  readonly sentAt: DateTime.Utc;
  readonly responseStatus: TelemetryHttpStatus;
}>;

export type WhatsAppDestination = Readonly<{
  readonly recipient: WhatsAppBusinessScopedUserId;
  readonly sandboxPhone: Option.Option<E164PhoneNumber>;
}>;

export type WhatsAppDelivery = {
  readonly sendText: (input: {
    readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    readonly destination: WhatsAppDestination;
    readonly text: TranscriptText;
    readonly confirmation: Option.Option<typeof HostedTurnConfirmation.Type>;
    readonly opaqueCallbackData: Option.Option<
      DisclosureDeliveryCorrelationToken | HostedDeliveryCorrelationToken
    >;
  }) => Effect.Effect<WhatsAppSentMessage, WhatsAppSendFailed>;
};

export const maxWhatsAppWebhookBytes = 1_048_576;

export const maxWhatsAppFutureTimestampMinutes = 5;

export const maxWhatsAppDeliveryEvents = 100;

export class InvalidWhatsAppSignature extends Data.TaggedError("InvalidWhatsAppSignature")<{}> {}

export class WhatsAppPayloadTooLarge extends Data.TaggedError("WhatsAppPayloadTooLarge")<{}> {}

export class InvalidWhatsAppPayload extends Data.TaggedError("InvalidWhatsAppPayload")<{}> {
  override get message(): string {
    return "The authentic Kapso payload did not match the supported projection";
  }
}

export class WhatsAppBatchTooLarge extends Data.TaggedError("WhatsAppBatchTooLarge")<{}> {}

export class WhatsAppStatusUnavailable extends Data.TaggedError("WhatsAppStatusUnavailable")<{
  readonly cause: unknown;
}> {}

export type WhatsAppDeliveryLookup = Readonly<{
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  messageId: WhatsAppProviderMessageId;
  correlationToken: DisclosureDeliveryCorrelationToken;
  receivedAt: DateTime.Utc;
}>;

export const DisclosureDeliveryFailureReason = Schema.Literals([
  "sandbox_bsuid_unsupported",
  "invalid_recipient",
  "conversation_window_closed",
  "rate_limited",
  "authentication_failed",
  "provider_unavailable",
  "timeout",
  "invalid_response",
]);

export type DisclosureDeliveryFailureReason = typeof DisclosureDeliveryFailureReason.Type;

type WhatsAppDisclosureLifecycleEvidenceBase = Readonly<{
  correlationToken: DisclosureDeliveryCorrelationToken;
  messageEvidence: WhatsAppMessageEvidence;
  occurredAt: DateTime.Utc;
}>;

export type WhatsAppDisclosureLifecycleEvidence = WhatsAppDisclosureLifecycleEvidenceBase &
  (
    | Readonly<{ readonly outcome: "sent" }>
    | Readonly<{ readonly outcome: "accepted" }>
    | Readonly<{
        readonly outcome: "failed";
        readonly reason: DisclosureDeliveryFailureReason;
        readonly automaticRetry: boolean;
      }>
  );

export type WhatsAppHostedLifecycleEvidence = Readonly<{
  recipientUserId: Option.Option<WhatsAppBusinessScopedUserId>;
  recipientPhone: Option.Option<E164PhoneNumber>;
  correlationToken: HostedDeliveryCorrelationToken;
  messageEvidence: WhatsAppMessageEvidence;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  occurredAt: DateTime.Utc;
}> &
  (
    | Readonly<{ outcome: "sent" | "delivered" }>
    | Readonly<{ outcome: "failed"; reason: DisclosureDeliveryFailureReason }>
  );

export type WhatsAppLifecycleAuthentication = Readonly<{
  rawBody: Uint8Array;
  secret: Redacted.Redacted<string>;
  signature: string;
  eventName: string;
  receivedAt: DateTime.Utc;
}>;

export type WhatsAppStatusLookupAdmission = (
  request: Pick<WhatsAppDeliveryLookup, "businessPhoneNumberId" | "messageId" | "receivedAt"> &
    Readonly<{ status: "sent" | "delivered" | "failed" }>
) => Effect.Effect<void, WhatsAppStatusUnavailable>;
