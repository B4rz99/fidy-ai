import type { OwnedStatement } from "~/shell/owner-write/contract";
import type { EmailPairingSubject } from "~/shell/email-authentication/contract";

export const emailPairingAllowsUser = ({ subject }: EmailPairingSubject): OwnedStatement => ({
  sql: `SELECT email_subject.pairingId, email_subject.userId FROM (${subject.sql}) AS email_subject
    WHERE NOT EXISTS (SELECT 1 FROM browser_login_pairings AS email_proof
      WHERE email_proof.email_work_id IS NOT NULL AND email_proof.id = email_subject.pairingId
        AND email_proof.email_user_id <> email_subject.userId)`,
  params: subject.params,
});
