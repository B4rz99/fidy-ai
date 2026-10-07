import {
  type HostedAgentSessionId,
  TranscriptText,
  TranscriptTurnId,
} from "../../src/core/agent/contract";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import { type Sha256Digest } from "../../src/shell/consent/contract";
import {
  HostedDeliveryCorrelationToken,
  type InsightTemplateSender,
  WhatsAppBusinessPhoneNumberId,
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
import type { ProactivityTemplateSender } from "../../src/shell/channels/whatsapp/contract";
import { type OwnedStatement } from "../../src/shell/owner-write/contract";

/** Owner-supplied live report guard and captured grant; never Queue or request authority. */
export type ProactivityChannelScope = Readonly<{
  db: D1Database;
  userId: UserId;
  id: string;
  now: DateTime.Utc;
  guard: OwnedStatement;
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
/** Exact provider-qualified route. Current Identity association must still be checked at egress. */
export const InsightRecipient = Schema.Struct({
  portfolioId: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
});
export type InsightRecipient = typeof InsightRecipient.Type;
/** Channel staging is native-only; guard is an owner-built live occurrence/grant/schedule query, never request material. */
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
  sender: InsightTemplateSender;
}>;
/** Claim once under current purpose, recipient, temporal and caller-owned resource authority. */
export type InsightWhatsAppStart = Readonly<{
  db: D1Database;
  userId: UserId;
  insightEventId: InsightEventId;
  grantId: ConsentRecordId;
  now: DateTime.Utc;
  guard: OwnedStatement;
}>;
/** Ready data is transient provider work; it never enters a Queue or Workflow result/history. */
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
/** Actual started send and verified delivery metadata; text is available only under current processing Consent within fixed retention. */
export type InsightVerifiedDeliveryEvidence = Readonly<{
  insightEventId: InsightEventId;
  providerMessageId: WhatsAppProviderMessageId;
  sentAt: DateTime.Utc;
  deliveredAt: DateTime.Utc;
  text: Option.Option<TranscriptText>;
}>;

/** Verified channel evidence is inert; Insights and Agent compose its actual effects in their atomic unit. */
export type InsightWhatsAppReconciliation =
  | Readonly<{ _tag: "Refused" | "Recorded" }>
  | Readonly<{ _tag: "VerifiedDelivery"; userId: UserId; insightEventId: InsightEventId }>;

/** A claimed channel subject, not authority until D1 rechecks the stable User association. */
export const WhatsAppHostedSubject = Schema.TaggedStruct("WhatsAppHosted", {
  userId: UserId,
  portfolioId: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
});
export type WhatsAppHostedSubject = typeof WhatsAppHostedSubject.Type;
/** Metadata retained with one exact User Transcript entry, never the content itself. */
export const WhatsAppInboundEvidence = Schema.Struct({
  messageId: WhatsAppProviderMessageId,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  occurredAtMs: Schema.Int,
  receivedAtMs: Schema.Int,
  replyToMessageId: Model.optionalOption(WhatsAppProviderMessageId),
});
export type WhatsAppInboundEvidence = typeof WhatsAppInboundEvidence.Type;
/** Private Core-to-User-coordinator text work. Never a public bearer or a Queue envelope. */
export const WhatsAppTurnAdmission = Schema.Struct({
  userId: UserId,
  portfolioId: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  ...WhatsAppInboundEvidence.fields,
  text: TranscriptText,
});
export type WhatsAppTurnAdmission = typeof WhatsAppTurnAdmission.Type;
/** A directly attached provider document, never a caller URL or credential command. */
export const WhatsAppDocumentAdmission = Schema.Struct({
  ...WhatsAppTurnAdmission.fields,
  document: WhatsAppDocument,
});
export type WhatsAppDocumentAdmission = typeof WhatsAppDocumentAdmission.Type;
export const WhatsAppInboundAdmission = Schema.Union([
  WhatsAppDocumentAdmission,
  WhatsAppTurnAdmission,
]);

/** Internal, authenticated Core-to-User-coordinator status projection; no text or bearer. */
export const WhatsAppStatusAdmission = Schema.Struct({
  userId: UserId,
  correlationToken: HostedDeliveryCorrelationToken,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  providerMessageId: WhatsAppProviderMessageId,
  outcome: Schema.Literals(["sent", "delivered", "failed"]),
  occurredAtMs: Schema.Int,
  receivedAtMs: Schema.Int,
});
export type WhatsAppStatusAdmission = typeof WhatsAppStatusAdmission.Type;

/** Identity only: exact inbound text stays in the User Transcript, never in Queue. */
export const WhatsAppWork = Schema.TaggedStruct("HostedWhatsAppWork", {
  userId: UserId,
  turnId: TranscriptTurnId,
});
export type WhatsAppWork = typeof WhatsAppWork.Type;

/** Decoded continuation for one still-Pending Turn; this does not independently authorize model work. */
export type WhatsAppPendingWork = Readonly<{
  startedAtMs: number;
  sessionId: HostedAgentSessionId;
  portfolioId: WhatsAppBusinessPortfolioId;
  bsuid: WhatsAppBusinessScopedUserId;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  associationCurrent: boolean;
  replyToMessageId: Option.Option<WhatsAppProviderMessageId>;
  text: TranscriptText;
}>;
/** Safe projection of one exact User-owned send attempt, never its private correlation or routing row. */
export type WhatsAppDeliveryProposal = Readonly<{
  turnId: TranscriptTurnId;
  userId: UserId;
  text: TranscriptText;
  state: "sending" | "accepted" | "ambiguous" | "rejected" | "delivered" | "unconfirmed";
  providerMessageId: Option.Option<WhatsAppProviderMessageId>;
}>;
/** The Turn owner commits this terminal result with its own exact Transcript and live delivery guard. */
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
/** Channel evidence only: the Agent owner alone commits any resulting terminal transition. */
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

/** Binding and callbacks required by the authenticated Consent ingress composition. */
export type WhatsAppIngressEnvironment = Readonly<{
  readonly DB: D1Database;
  readonly KAPSO_API_KEY: string;
  readonly KAPSO_WEBHOOK_SECRET: string;
  readonly WHATSAPP_BUSINESS_PORTFOLIO_ID: string;
  readonly onAccepted: (id: string) => void;
  readonly onHostedText: (
    admission: WhatsAppTurnAdmission | WhatsAppDocumentAdmission
  ) => Promise<Response>;
  readonly onHostedStatus: (admission: WhatsAppStatusAdmission) => Promise<Response>;
}>;

/** Bounded operational sample containing no User identity, exact text, routing or provider evidence. */
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

/** Channel work is unavailable without exposing storage statements, rows, provider payloads or causes. */
export class WhatsAppUnavailable extends Data.TaggedError("WhatsAppUnavailable")<{}> {}
