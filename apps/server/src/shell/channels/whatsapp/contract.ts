import {
  Data,
  type DateTime,
  type Effect,
  type Array as EffectArray,
  type Option,
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

/** Operator-controlled approval snapshot. Only the exact reviewed positional full-summary body is supported. */
export const InsightTemplateConfiguration = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,511}$/u)),
  language: Schema.Literal("es"),
  approval: Schema.Literal("approved"),
  body: Schema.Literal("Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy."),
});
export type InsightTemplateConfiguration = typeof InsightTemplateConfiguration.Type;

/** Complete approved category messages use one positional parameter, never clipped financial facts. */
export const ProactivityTemplateConfiguration = Schema.Struct({
  name: InsightTemplateConfiguration.fields.name,
  language: Schema.Literal("es"),
  approval: Schema.Literal("approved"),
  body: Schema.Literal("Fidy: {{1}}"),
});
const maximumProactivityParameterLength = 1018;
/** Frozen template identity and complete visible body; a later configuration cannot re-render it. */
export const PreparedProactivityTemplate = Schema.Struct({
  name: ProactivityTemplateConfiguration.fields.name,
  language: Schema.Literal("es"),
  parameter: Schema.String.check(Schema.isMaxLength(maximumProactivityParameterLength)),
  text: TranscriptText,
}).check(Schema.makeFilter((value) => value.text === `Fidy: ${value.parameter}`));
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

/** The operator must approve this complete disclosure template separately from the summary template. */
export const WeeklyQuestionTemplateConfiguration = Schema.Struct({
  name: InsightTemplateConfiguration.fields.name,
  language: Schema.Literal("es"),
  approval: Schema.Literal("approved"),
  body: Schema.Literal("Fidy: {{1}}"),
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
/** Rendered owner report facts, with the complete frozen Currency keyspace supplied independently of sections. No calculation belongs to delivery. */
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

/** A complete summary never truncates to fit a provider template. Invalid or absent approval makes no provider call. */
export class InsightTemplateUnavailable extends Data.TaggedError(
  "InsightTemplateUnavailable"
)<{}> {}
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

/** Stable identity of one accepted User-owned inbound message and its durable queue item. */
export const WhatsAppInboundJobId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("WhatsAppInboundJobId")
);
export type WhatsAppInboundJobId = typeof WhatsAppInboundJobId.Type;

/** Opaque retry key for one authenticated WhatsApp delivery. */
export const WhatsAppDeliveryKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumProviderIdentifierLength)
).pipe(Schema.brand("WhatsAppDeliveryKey"));
export type WhatsAppDeliveryKey = typeof WhatsAppDeliveryKey.Type;

/** Provider-qualified evidence projected into the WhatsApp operational slice. */
export const WhatsAppMessageEvidence = Schema.Struct({
  ...ProviderMessageEvidence.fields,
  channel: Schema.Literal("whatsapp"),
  providerMessageId: WhatsAppProviderMessageId,
}).annotate({ identifier: "WhatsAppMessageEvidence" });
export type WhatsAppMessageEvidence = typeof WhatsAppMessageEvidence.Type;

/** Media identifier retained as WhatsApp provider evidence only; it grants no retrieval authority. */
export const WhatsAppMediaId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumProviderIdentifierLength)
).pipe(Schema.brand("WhatsAppMediaId"));
export type WhatsAppMediaId = typeof WhatsAppMediaId.Type;

/**
 * Provider-authenticated inbound caller evidence. Portfolio plus BSUID establish caller identity;
 * optional mutable observations never independently resolve or authorize a User.
 */
export const WhatsAppCaller = Schema.Struct({
  ...WhatsAppCallerReference.fields,
  parentBusinessScopedUserId: Schema.Option(WhatsAppParentBusinessScopedUserId),
  username: Schema.Option(WhatsAppUsername),
  phoneNumber: Schema.Option(E164PhoneNumber),
}).annotate({ identifier: "WhatsAppCaller" });
export type WhatsAppCaller = typeof WhatsAppCaller.Type;

/** A direct document label is display metadata, never a locator or retrieval authority. */
export const WhatsAppDocumentFileName = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumProviderIdentifierLength)
);
/** A verified attachment reference; only the closed media transport may retrieve its bytes. */
export const WhatsAppDocument = Schema.TaggedStruct("Document", {
  mediaId: WhatsAppMediaId,
  fileName: Schema.Option(WhatsAppDocumentFileName),
  caption: Schema.Option(TranscriptText),
});
export type WhatsAppDocument = typeof WhatsAppDocument.Type;

/** Validated text accepted by the WhatsApp slice after provider authentication and projection. */
export type WhatsAppInboundContent =
  | WhatsAppDocument
  | Readonly<{ readonly _tag: "Text"; readonly text: TranscriptText }>
  | Readonly<{
      readonly _tag: "VoiceTranscript";
      readonly text: TranscriptText;
      readonly mediaId: WhatsAppMediaId;
    }>
  | Readonly<{ readonly _tag: "UnusableVoiceTranscript" }>
  | Readonly<{
      readonly _tag: "Image";
      readonly mediaId: WhatsAppMediaId;
      readonly caption: Option.Option<TranscriptText>;
    }>;

/** Opaque Turn-delivery correlation; the provider cannot supply User authority with this value. */
export const HostedDeliveryCorrelationToken = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("HostedDeliveryCorrelationToken")
);
export type HostedDeliveryCorrelationToken = typeof HostedDeliveryCorrelationToken.Type;

/** Provider-independent input for one authenticated WhatsApp event. */
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

/** Provider-authenticated reassociation after Meta changes a WhatsAppIdentity BSUID. */
export type WhatsAppIdentityChangeEvent = Readonly<{
  readonly messageEvidence: WhatsAppMessageEvidence;
  readonly previousCaller: WhatsAppCallerReference;
  readonly replacement: typeof WhatsAppCallerReplacement.Type;
  readonly occurredAt: DateTime.Utc;
}>;

/** One authenticated WhatsApp delivery normalized to a non-empty event collection. */
export type WhatsAppWebhookReceipt = Readonly<{
  readonly deliveryKey: WhatsAppDeliveryKey;
  readonly events: EffectArray.NonEmptyReadonlyArray<WhatsAppInboundEvent>;
}>;

export { DisclosureDeliveryCorrelationToken } from "~/core/provider-evidence/contract";

/** Whether a provider response proves rejection or acceptance may already have occurred. */
export type WhatsAppDeliveryCertainty = "rejected" | "ambiguous";

/**
 * Safe provider-send failure. Automatic retry is permitted only when the provider definitively
 * rejected a transient attempt. responseStatus is present exactly when Kapso returned a validated
 * bounded HTTP status, including malformed response bodies, and absent for transport or timeout
 * failures. The value contains no request input, credential, or response body.
 */
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

/** Decoded provider evidence plus Fidy's local clock time after the response was validated. */
export type WhatsAppSentMessage = Readonly<{
  readonly messageEvidence: WhatsAppMessageEvidence;
  readonly sentAt: DateTime.Utc;
  readonly responseStatus: TelemetryHttpStatus;
}>;

/** Provider-addressable destination derived only from authenticated WhatsApp caller evidence. */
export type WhatsAppDestination = Readonly<{
  readonly recipient: WhatsAppBusinessScopedUserId;
  readonly sandboxPhone: Option.Option<E164PhoneNumber>;
}>;

/**
 * Kapso seam for outbound WhatsApp text. Normal delivery uses the authenticated portfolio-scoped
 * BSUID; explicit sandbox mode uses optional provider-observed phone evidence because Kapso rejects
 * BSUID recipients for sandbox numbers. Failures expose no remote or credential details.
 */
export type WhatsAppDelivery = {
  readonly sendText: (input: {
    readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    readonly destination: WhatsAppDestination;
    readonly text: TranscriptText;
    /** Opaque attempt correlation forwarded unchanged to lifecycle webhooks. */
    readonly opaqueCallbackData: Option.Option<
      DisclosureDeliveryCorrelationToken | HostedDeliveryCorrelationToken
    >;
  }) => Effect.Effect<WhatsAppSentMessage, WhatsAppSendFailed>;
};

/** Maximum raw Kapso delivery accepted before payload decoding. */
export const maxWhatsAppWebhookBytes = 1_048_576;
/** Maximum lead of a signed Kapso event clock over receipt; Consent replay windows must reserve it. */
export const maxWhatsAppFutureTimestampMinutes = 5;
/** Kapso's documented maximum number of events in one buffered delivery. */
export const maxWhatsAppDeliveryEvents = 100;

/** Signature is absent, malformed, or does not authenticate the exact raw bytes. */
export class InvalidWhatsAppSignature extends Data.TaggedError("InvalidWhatsAppSignature")<{}> {}
/** Raw webhook bytes exceed Fidy's fixed launch resource bound. */
export class WhatsAppPayloadTooLarge extends Data.TaggedError("WhatsAppPayloadTooLarge")<{}> {}
/** Authentic JSON does not match the supported Kapso v2 message projection. */
export class InvalidWhatsAppPayload extends Data.TaggedError("InvalidWhatsAppPayload")<{}> {
  override get message(): string {
    return "The authentic Kapso payload did not match the supported projection";
  }
}

/** Authentic buffered delivery exceeds Kapso's documented event maximum. */
export class WhatsAppBatchTooLarge extends Data.TaggedError("WhatsAppBatchTooLarge")<{}> {}

/** Safe operational reason retained after a provider send does not complete. */
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

/** Authenticated, metadata-only lifecycle evidence projected from a Kapso webhook. */
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

/** Authenticated Kapso status for a hosted reply, not evidence of browser rendering. */
export type WhatsAppHostedLifecycleEvidence = Readonly<{
  correlationToken: HostedDeliveryCorrelationToken;
  messageEvidence: WhatsAppMessageEvidence;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  occurredAt: DateTime.Utc;
}> &
  (
    | Readonly<{ outcome: "sent" | "delivered" }>
    | Readonly<{ outcome: "failed"; reason: DisclosureDeliveryFailureReason }>
  );
