import { Data, type Option, type Redacted } from "effect";
import type { ResendReceivedEmailId } from "~/core/ingestion/reference";
import type { WhatsAppBusinessPhoneNumberId } from "~/shell/channels/whatsapp/model";

/** Closed coordinate-free reason reported by the Outbound HTTP interface. */
export type OutboundHttpFailureReason =
  | "response-body-failed"
  | "invalid-destination"
  | "response-too-large"
  | "transport-failed";

/** Failure facts safe for provider interpretation, without coordinates, credentials, or causes. */
export class OutboundHttpFailure extends Data.TaggedError("OutboundHttpFailure")<{
  readonly reason: OutboundHttpFailureReason;
  readonly responseStatus: Option.Option<number>;
  readonly responseHeaders: Readonly<Record<string, string>>;
}> {}

/** Coordinate-free failure to acquire short-lived operational provider authority. */
export class OutboundHttpSetupError extends Data.TaggedError("OutboundHttpSetupError")<{
  readonly reason: "unavailable";
}> {}

/** Response whose body has passed its destination policy's streamed-byte bound. */
export type OutboundHttpResponse = Readonly<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}>;

/** Values needed to encode and sign one Wompi transaction without exposing signing authority. */
export type WompiTransactionBody = Readonly<{
  readonly amountInCents: number;
  readonly currency: string;
  readonly billingEmail: string;
  readonly sourceId: number;
  readonly reference: string;
}>;

/** Fixed Sentry management API resource selected without exposing a complete URL. */
export type SentryAccountResource =
  | Readonly<{
      readonly _tag: "Organization";
      readonly organizationSlug: Redacted.Redacted<string>;
    }>
  | Readonly<{
      readonly _tag: "OrganizationProjects";
      readonly organizationSlug: Redacted.Redacted<string>;
    }>
  | Readonly<{
      readonly _tag: "ProjectKeys";
      readonly organizationSlug: Redacted.Redacted<string>;
      readonly projectSlug: Redacted.Redacted<string>;
    }>
  | Readonly<{
      readonly _tag: "ProjectEnvironments";
      readonly organizationSlug: Redacted.Redacted<string>;
      readonly projectSlug: Redacted.Redacted<string>;
    }>;

/**
 * One closed provider operation accepted by Outbound HTTP. Its tag selects fixed origins,
 * credentials, response bounds, retained headers, redirect behavior, and trace policy. Wompi
 * transaction signing stays inside the interface because its integrity secret is transport authority;
 * all other
 * provider request bodies remain encoded by their owning adapter.
 */
export type OutboundHttpRequest =
  | Readonly<{
      readonly _tag: "KapsoMessages";
      readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
      readonly body: string;
    }>
  | Readonly<{
      readonly _tag: "ResendEmailDelivery";
      readonly idempotencyKey: string;
      readonly body: string;
    }>
  | Readonly<{
      readonly _tag: "ResendReceivedEmail";
      readonly receivedEmailId: ResendReceivedEmailId;
    }>
  | Readonly<{
      readonly _tag: "ResendAttachmentDownload";
      readonly receivedEmailId: ResendReceivedEmailId;
      readonly attachmentId: string;
    }>
  | Readonly<{ readonly _tag: "OpenAiResponses"; readonly body: string }>
  | Readonly<{ readonly _tag: "OpenAiInputTokens"; readonly body: string }>
  | Readonly<{ readonly _tag: "MistralChatCompletions"; readonly body: string }>
  | Readonly<{ readonly _tag: "WompiMerchant" }>
  | Readonly<{ readonly _tag: "WompiCreatePaymentSource"; readonly body: string }>
  | Readonly<{ readonly _tag: "WompiVerifyPaymentSource"; readonly sourceId: number }>
  | Readonly<{ readonly _tag: "WompiCreateTransaction"; readonly body: WompiTransactionBody }>
  | Readonly<{ readonly _tag: "WompiFindTransaction"; readonly transactionId: string }>
  | Readonly<{ readonly _tag: "SentryAccount"; readonly resource: SentryAccountResource }>
  | Readonly<{ readonly _tag: "CloudflareAccessSupportRecovery"; readonly body: string }>;
