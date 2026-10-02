import { protectConsentStatement } from "@fidy/server/consent-operations";
import { liveWebSessionAuthority } from "@fidy/server/identity-operations";
import { webSessionCredentialAuthority } from "@fidy/server/web-session-operations";
import { type OwnedStatement } from "../../src/shell/_shared/owned-statement";
import { type TransactionSubject } from "../canonical-work/operations";
import { whatsAppIdentityQuery } from "../identity/operations";
import { type WhatsAppHostedSubject } from "../whatsapp/contract";

export type HostedSubject = TransactionSubject | WhatsAppHostedSubject;
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
