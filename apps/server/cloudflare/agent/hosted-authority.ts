import type { OwnedStatement } from "../../src/shell/_shared/owned-statement";
import { whatsAppIdentityQuery } from "../identity/operations";
import { protectConsentStatement } from "@fidy/server/consent-operations";
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
import type { TransactionSubject } from "../canonical-work/operations";
import { liveWebSessionAuthority } from "@fidy/server/identity-operations";
import { webSessionCredentialAuthority } from "@fidy/server/web-session-operations";

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

const browserSubjectQuery = (
  authority: ReturnType<typeof webSessionCredentialAuthority>
): OwnedStatement => ({
  sql: `SELECT user_id AS userId FROM ${authority.table} WHERE ${authority.predicate}`,
  params: authority.bindings,
});

/** Recheck an established channel credential, including after Consent revocation for refusal classification. */
export const hostedIdentity = ({
  subject,
  current,
}: Readonly<{ subject: HostedSubject; current: number }>): OwnedStatement =>
  isWhatsAppHosted(subject)
    ? whatsAppIdentityQuery(subject)
    : browserSubjectQuery(webSessionCredentialAuthority({ subject, current }));

/** Project only the same live User at execution; provider identifiers alone never authorize work. */
export const hostedAuthority = ({
  subject,
  current,
}: Readonly<{ subject: HostedSubject; current: number }>): OwnedStatement =>
  isWhatsAppHosted(subject)
    ? protectConsentStatement({
        statement: whatsAppIdentityQuery(subject),
        subject: { _tag: "User", userId: subject.userId },
        requirement: "active",
      })
    : browserSubjectQuery(liveWebSessionAuthority({ subject, current }));
