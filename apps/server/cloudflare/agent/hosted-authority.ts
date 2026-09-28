import { Schema } from "effect";
import { UserId } from "@fidy/server/agent-runtime";
import {
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/reference";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/model";
import type { TransactionSubject } from "../transactions/transaction-boundary";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";

/** An authenticated channel observation, always rechecked against the stable User association. */
export const WhatsAppHostedSubject = Schema.TaggedStruct("WhatsAppHosted", {
  userId: UserId,
  portfolioId: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
});
export type WhatsAppHostedSubject = typeof WhatsAppHostedSubject.Type;
export type HostedSubject = TransactionSubject | WhatsAppHostedSubject;
/** Metadata retained with one exact User Transcript entry, never the content itself. */
export const WhatsAppInboundEvidence = Schema.Struct({
  messageId: WhatsAppProviderMessageId,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  occurredAtMs: Schema.Int,
  receivedAtMs: Schema.Int,
});
export type WhatsAppInboundEvidence = typeof WhatsAppInboundEvidence.Type;
export const isWhatsAppHosted = (subject: HostedSubject): subject is WhatsAppHostedSubject =>
  "_tag" in subject;

type HostedSqlAuthority =
  | Readonly<{ table: "whatsapp_identities"; predicate: string; bindings: ReadonlyArray<string> }>
  | Readonly<{
      table: "web_sessions";
      predicate: string;
      bindings: ReadonlyArray<string | number | Uint8Array>;
    }>;

/** Verify an established channel credential even when Consent was revoked, so refusal can be classified. */
export const hostedIdentity = ({
  subject,
  current,
}: Readonly<{ subject: HostedSubject; current: number }>): HostedSqlAuthority =>
  isWhatsAppHosted(subject)
    ? {
        table: "whatsapp_identities" as const,
        predicate: "user_id = ? AND portfolio_id = ? AND bsuid = ?",
        bindings: [subject.userId, subject.portfolioId, subject.bsuid] as const,
      }
    : {
        table: "web_sessions" as const,
        predicate: `user_id = ? AND id = ? AND token_digest = ? AND revoked_at_ms IS NULL
          AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`,
        bindings: [subject.userId, subject.id, subject.digest, current, current] as const,
      };

/** Trusted SQL authority selection. Provider ids are evidence; the matching D1 association is authority. */
export const hostedAuthority = ({
  subject,
  current,
}: Readonly<{ subject: HostedSubject; current: number }>): HostedSqlAuthority =>
  isWhatsAppHosted(subject)
    ? {
        table: "whatsapp_identities" as const,
        predicate: `user_id = ? AND portfolio_id = ? AND bsuid = ?
          AND EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = whatsapp_identities.user_id)
          AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = whatsapp_identities.user_id)`,
        bindings: [subject.userId, subject.portfolioId, subject.bsuid] as const,
      }
    : liveWebSessionAuthority({ subject, current });
