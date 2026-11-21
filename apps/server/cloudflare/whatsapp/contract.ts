import { type UserStoreBindings } from "../directory/contract";
import { TranscriptText } from "../../src/core/agent/contract";
import {
  E164PhoneNumber,
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import { type Sha256Digest } from "../../src/shell/consent/contract";
import {
  HostedDeliveryCorrelationToken,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppCaller,
  type WhatsAppDeliveryKey,
  WhatsAppDocument,
  type WhatsAppInboundEvent,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { Model } from "effect/schema";
import { Data, type Option, Schema } from "effect";

export const WhatsAppInboundEvidence = Schema.Struct({
  messageId: WhatsAppProviderMessageId,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  occurredAtMs: Schema.Int,
  receivedAtMs: Schema.Int,
  replyToMessageId: Model.optionalOption(WhatsAppProviderMessageId),
  sandboxPhone: Model.optionalOption(E164PhoneNumber),
});

export type WhatsAppInboundEvidence = typeof WhatsAppInboundEvidence.Type;

export const WhatsAppTurnAdmission = Schema.Struct({
  userId: UserId,
  portfolioId: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  ...WhatsAppInboundEvidence.fields,
  text: TranscriptText,
});

export type WhatsAppTurnAdmission = typeof WhatsAppTurnAdmission.Type;

export const WhatsAppDocumentAdmission = Schema.Struct({
  ...WhatsAppTurnAdmission.fields,
  document: WhatsAppDocument,
});

export type WhatsAppDocumentAdmission = typeof WhatsAppDocumentAdmission.Type;

export const WhatsAppInboundAdmission = Schema.Union([
  WhatsAppDocumentAdmission,
  WhatsAppTurnAdmission,
]);

export type WhatsAppAuthenticatedInbound = Readonly<{
  readonly event: WhatsAppInboundEvent;
  readonly deliveryKey: WhatsAppDeliveryKey;
  readonly digest: Sha256Digest;
  readonly receivedAtMs: number;
}>;

export type WhatsAppIngressEnvironment = Partial<
  Pick<UserStoreBindings, "DIRECTORY" | "USER_STORE"> &
    Readonly<{
      HOSTED_WHATSAPP_QUEUE: Readonly<{
        send: (event: typeof WhatsAppLifecycleWork.Type) => Promise<QueueSendResponse>;
      }>;
    }>
> &
  Readonly<{
    readonly BROWSER_ORIGIN: string;
    readonly KAPSO_API_KEY: string;
    readonly KAPSO_WEBHOOK_SECRET: string;
    readonly WHATSAPP_BUSINESS_PORTFOLIO_ID: string;
    readonly WHATSAPP_SANDBOX_PHONE_NUMBER_ID: string;
    readonly onHostedText: (
      admission: WhatsAppTurnAdmission | WhatsAppDocumentAdmission
    ) => Promise<Response>;
  }>;

export class WhatsAppUnavailable extends Data.TaggedError("WhatsAppUnavailable")<{
  readonly cause: Option.Option<unknown>;
}> {}

export const DeliveryFamily = Schema.Literals([
  "hosted",
  "proactivity",
  "insight",
  "weekly-question",
  "disclosure",
]);

const maximumDeliveryOperationLength = 128;

const deliveryOperation = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumDeliveryOperationLength)
);

export const DeliverySend = Schema.Struct({
  userId: UserId,
  family: DeliveryFamily,
  operationId: deliveryOperation,
  correlation: HostedDeliveryCorrelationToken,
  portfolio: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  endpoint: WhatsAppBusinessPhoneNumberId,
  sandboxPhone: Schema.NullOr(E164PhoneNumber),
  deadline: Schema.NullOr(Schema.Int),
  contentDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

export const WhatsAppLifecycleWork = Schema.TaggedStruct("WhatsAppLifecycleEvent", {
  portfolio: WhatsAppBusinessPortfolioId,
  correlationToken: HostedDeliveryCorrelationToken,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  providerMessageId: WhatsAppProviderMessageId,
  recipientUserId: Schema.optionalKey(WhatsAppBusinessScopedUserId),
  recipientPhone: Schema.optionalKey(E164PhoneNumber),
  outcome: Schema.Literals(["sent", "delivered", "failed"]),
  occurredAtMs: Schema.Int,
  receivedAtMs: Schema.Int,
});

export const DeliveredObservation = Schema.Struct({
  userId: UserId,
  operationId: deliveryOperation,
  family: DeliveryFamily,
  evidence: WhatsAppLifecycleWork,
});

export const SendReply = Schema.Struct({
  userId: UserId,
  operationId: deliveryOperation,
  family: DeliveryFamily,
  endpoint: WhatsAppBusinessPhoneNumberId,
  correlation: HostedDeliveryCorrelationToken,
  state: Schema.Literals(["accepted", "rejected", "ambiguous"]),
  message: Schema.NullOr(WhatsAppProviderMessageId),
});

export const voiceRefusalUrl = "https://user.invalid/work/whatsapp/voice-refusal";

export const VoiceRefusal = Schema.Struct({
  userId: UserId,
  caller: WhatsAppCaller,
  message: WhatsAppProviderMessageId,
  endpoint: WhatsAppBusinessPhoneNumberId,
  occurredAt: Schema.Int,
});

export const reserveDeliveryUrl = "https://user.invalid/work/whatsapp/reserve";

export const claimDeliveryUrl = "https://user.invalid/work/whatsapp/claim";

export const statusDeliveryUrl = "https://user.invalid/work/whatsapp/status";

export const replyDeliveryUrl = "https://user.invalid/work/whatsapp/reply";
