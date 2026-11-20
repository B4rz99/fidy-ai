import { type ExternalEventBindings, type UserStoreBindings } from "../directory/contract";
import {
  type HostedAgentSessionId,
  TranscriptText,
  TranscriptTurnId,
} from "../../src/core/agent/contract";
import {
  E164PhoneNumber,
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import { type Sha256Digest } from "../../src/shell/consent/contract";
import {
  HostedDeliveryCorrelationToken,
  type InsightTemplateSender,
  type ProactivityTemplateSender,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppCaller,
  type WhatsAppDeliveryKey,
  WhatsAppDocument,
  type WhatsAppInboundEvent,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { Model } from "effect/schema";
import { Data, type DateTime, type Option, Schema } from "effect";
import { type ConsentRecordId } from "../../src/core/consent/contract";
import { type IanaTimeZone } from "../../src/core/_shared/context";
import { type InsightEventId } from "../../src/core/insights/contract";

import { type OwnedStatement } from "../../src/shell/owner-write/contract";

export type ProactivityChannelScope = Readonly<{
  db: D1Database;
  userId: UserId;
  id: string;
  now: DateTime.Utc;
  guard: OwnedStatement;
  queuedAdmission: Option.Option<OwnedStatement>;
}> &
  (
    | Readonly<{
        role:
          | "budget-threshold"
          | "manual-entry-reminder"
          | "reminder-question"
          | "new-recurring-series";
        grantId: ConsentRecordId;
      }>
    | Readonly<{ role: "budget-offer" | "reminder-offer" | "recurring-offer" }>
  );
export type ProactivityChannelStage = ProactivityChannelScope &
  Readonly<{
    recipient: InsightRecipient;
    text: TranscriptText;
    scheduledAt: DateTime.Utc;
    expiresAt: DateTime.Utc;
    timeZone: IanaTimeZone;
    sender: ProactivityTemplateSender;
  }>;
export type ProactivityChannelClaim =
  | Readonly<{ _tag: "NotClaimed" | "Expired" }>
  | Readonly<{ _tag: "Deferred"; nextEligibleAt: DateTime.Utc }>
  | Readonly<{
      _tag: "Ready";
      correlationToken: HostedDeliveryCorrelationToken;
      request: Parameters<ProactivityTemplateSender["send"]>[0];
    }>;
export type ProactivityChannelReconciliation =
  | Readonly<{ _tag: "Refused" | "Recorded" }>
  | Readonly<{ _tag: "VerifiedDelivery"; userId: UserId; id: string }>;

export const InsightRecipient = Schema.Struct({
  portfolioId: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
});
export type InsightRecipient = typeof InsightRecipient.Type;

export type InsightWhatsAppStage = Readonly<{
  db: D1Database;
  userId: UserId;
  insightEventId: InsightEventId;
  grantId: ConsentRecordId;
  recipient: InsightRecipient;
  summary: unknown;
  scheduledAt: DateTime.Utc;
  expiresAt: DateTime.Utc;
  timeZone: IanaTimeZone;
  now: DateTime.Utc;
  guard: OwnedStatement;
  queuedAdmission: Option.Option<OwnedStatement>;
  sender: InsightTemplateSender;
}>;

export type InsightWhatsAppStart = Readonly<{
  db: D1Database;
  userId: UserId;
  insightEventId: InsightEventId;
  grantId: ConsentRecordId;
  now: DateTime.Utc;
  guard: OwnedStatement;
  queuedAdmission: Option.Option<OwnedStatement>;
}>;

export type InsightWhatsAppClaim =
  | Readonly<{ _tag: "NotClaimed" | "Expired" }>
  | Readonly<{ _tag: "Deferred"; nextEligibleAt: DateTime.Utc }>
  | Readonly<{
      _tag: "Ready";
      correlationToken: HostedDeliveryCorrelationToken;
      request: Parameters<InsightTemplateSender["send"]>[0];
    }>;
export type InsightWhatsAppSendResult = Readonly<{
  db: D1Database;
  userId: UserId;
  insightEventId: InsightEventId;
  correlationToken: HostedDeliveryCorrelationToken;
  outcome:
    | Readonly<{ kind: "accepted"; providerMessageId: WhatsAppProviderMessageId }>
    | Readonly<{ kind: "ambiguous" | "rejected" }>;
}>;

export type InsightVerifiedDeliveryEvidence = Readonly<{
  insightEventId: InsightEventId;
  providerMessageId: WhatsAppProviderMessageId;
  sentAt: DateTime.Utc;
  deliveredAt: DateTime.Utc;
  text: Option.Option<TranscriptText>;
}>;

export type InsightWhatsAppReconciliation =
  | Readonly<{ _tag: "Refused" | "Recorded" }>
  | Readonly<{ _tag: "VerifiedDelivery"; userId: UserId; insightEventId: InsightEventId }>;

export const WhatsAppHostedSubject = Schema.TaggedStruct("WhatsAppHosted", {
  userId: UserId,
  portfolioId: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
});
export type WhatsAppHostedSubject = typeof WhatsAppHostedSubject.Type;

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

export const WhatsAppStatusAdmission = Schema.Struct({
  recipientUserId: Schema.optionalKey(WhatsAppBusinessScopedUserId),
  recipientPhone: Schema.optionalKey(E164PhoneNumber),
  userId: UserId,
  correlationToken: HostedDeliveryCorrelationToken,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  providerMessageId: WhatsAppProviderMessageId,
  outcome: Schema.Literals(["sent", "delivered", "failed"]),
  occurredAtMs: Schema.Int,
  receivedAtMs: Schema.Int,
});
export type WhatsAppStatusAdmission = typeof WhatsAppStatusAdmission.Type;

export const WhatsAppWork = Schema.TaggedStruct("HostedWhatsAppWork", {
  traceContext: Schema.optionalKey(Schema.Unknown),
  userId: UserId,
  turnId: TranscriptTurnId,
});
export type WhatsAppWork = typeof WhatsAppWork.Type;

export type WhatsAppPendingWork = Readonly<{
  startedAtMs: number;
  sessionId: HostedAgentSessionId;
  portfolioId: WhatsAppBusinessPortfolioId;
  bsuid: WhatsAppBusinessScopedUserId;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  sandboxPhone: Option.Option<E164PhoneNumber>;
  associationCurrent: boolean;
  replyToMessageId: Option.Option<WhatsAppProviderMessageId>;
  text: TranscriptText;
}>;

export type WhatsAppHostedRecipient = Pick<
  WhatsAppPendingWork,
  "portfolioId" | "bsuid" | "businessPhoneNumberId" | "sandboxPhone" | "replyToMessageId"
>;

export type WhatsAppDeliveryProposal = Readonly<{
  turnId: TranscriptTurnId;
  userId: UserId;
  text: TranscriptText;
  state: "sending" | "accepted" | "ambiguous" | "rejected" | "delivered" | "unconfirmed";
  providerMessageId: Option.Option<WhatsAppProviderMessageId>;
}>;

export type WhatsAppTurnCompletion = Readonly<{
  userId: UserId;
  turnId: TranscriptTurnId;
  startedAtMs: number;
  subject: WhatsAppHostedSubject;
  now: number;
  result:
    | Readonly<{ _tag: "Completed"; text: TranscriptText }>
    | Readonly<{ _tag: "Failed"; reason: "DeliveryFailed" | "DeliveryUnconfirmed" }>;
}>;

export type WhatsAppStatusReconciliation =
  | Readonly<{ _tag: "Refused" }>
  | Readonly<{ _tag: "Recorded" }>
  | Readonly<{ _tag: "TerminalEvidence"; completion: WhatsAppTurnCompletion }>;

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
        send: (event: typeof WhatsAppLifecycleWork.Type) => Promise<unknown>;
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

export type WhatsAppOperationalSignal =
  | Readonly<{ component: "async-health"; operation: "whatsapp"; state: "unavailable" }>
  | Readonly<{
      component: "async-health";
      operation: "whatsapp";
      state: "healthy" | "attention";
      sampledPending: number;
      sampledFailed: number;
      overdueCleanup: number;
      sampleLimited: boolean;
      oldestPendingAgeMilliseconds: number;
    }>;

export class WhatsAppUnavailable extends Data.TaggedError("WhatsAppUnavailable")<{}> {}

export const whatsAppServiceWindowMilliseconds = 86_400_000;

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

export type NativeDeliveryOwner = Readonly<{ callbackOwner: Partial<ExternalEventBindings> }>;
