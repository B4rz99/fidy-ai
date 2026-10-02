import {
  type HostedAgentSessionId,
  TranscriptText,
  TranscriptTurnId,
} from "@fidy/server/agent-contract";
import { UserId } from "@fidy/server/identity-reference";
import { type Sha256Digest } from "@fidy/server/consent-contract";
import {
  HostedDeliveryCorrelationToken,
  WhatsAppBusinessPhoneNumberId,
  type WhatsAppDeliveryKey,
  type WhatsAppInboundEvent,
  WhatsAppProviderMessageId,
} from "@fidy/server/whatsapp-contract";
import { Data, type Option, Schema } from "effect";
import {
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/reference";
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
  readonly onHostedText: (admission: WhatsAppTurnAdmission) => Promise<Response>;
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
