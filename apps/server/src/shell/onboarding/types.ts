import type { DateTime, Redacted } from "effect";
import type { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import type { ConsentInboundContent } from "~/core/consent/model";
import type { PendingConsentExchangeId } from "~/core/consent/reference";
import type { UserId } from "~/core/identity/reference";
import type { BackupRecoveryCode } from "~/core/recovery/model";
import type { WhatsAppCaller } from "~/shell/channels/whatsapp/model";

/** One provider-authenticated inbound turn presented to the Onboarding module. */
export type OnboardingTurn = Readonly<{
  caller: WhatsAppCaller;
  content: ConsentInboundContent;
  message: ProviderMessageEvidence;
  receivedAt: DateTime.Utc;
}>;

/** Exhaustive instruction to the channel adapter; only Proceed may enter model context. */
export type OnboardingTurnOutcome =
  | Readonly<{ _tag: "SendDisclosure"; exchangeId: PendingConsentExchangeId }>
  | Readonly<{ _tag: "AwaitingDisclosureDelivery"; exchangeId: PendingConsentExchangeId }>
  | Readonly<{
      _tag: "ClarifyDecision";
      reason:
        | "invalid-message"
        | "another-identity"
        | "stale-decision"
        | "replayed-initiating-message"
        | "decision-before-disclosure"
        | "unrecognized-decision";
    }>
  | Readonly<{ _tag: "Declined"; reason: "declined" | "expired" }>
  | Readonly<{ _tag: "AwaitingEmail" }>
  | Readonly<{ _tag: "EmailSubmitted"; status: "sent" | "cooldown" | "quota-reached" }>
  | Readonly<{ _tag: "Accepted"; userId: UserId }>
  | Readonly<{ _tag: "Proceed"; userId: UserId }>;

export type CompleteVerifiedOnboardingResult = Readonly<{
  status: "created";
  backupRecoveryCode: Redacted.Redacted<BackupRecoveryCode>;
}>;
