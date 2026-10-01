import { protectConsentAuthority } from "@fidy/server/consent-operations";
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
import {
  liveWebSessionAuthority,
  webSessionCredentialAuthority,
} from "@fidy/server/identity-runtime";

/** A claimed channel subject, not authority until D1 rechecks the stable User association. */
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

/** Build the established channel credential check, including after Consent revocation, so callers can classify refusal. */
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
    : webSessionCredentialAuthority({ subject, current });

/** Trusted SQL authority selection. Provider ids are evidence; the matching D1 association is authority. */
export const hostedAuthority = ({
  subject,
  current,
}: Readonly<{ subject: HostedSubject; current: number }>): HostedSqlAuthority =>
  isWhatsAppHosted(subject)
    ? protectConsentAuthority({
        authority: {
          table: "whatsapp_identities" as const,
          predicate: "user_id = ? AND portfolio_id = ? AND bsuid = ?",
          bindings: [subject.userId, subject.portfolioId, subject.bsuid] as const,
        },
        subject: { _tag: "Owner", column: "whatsapp_identities.user_id" },
        requirement: "active",
      })
    : liveWebSessionAuthority({ subject, current });
