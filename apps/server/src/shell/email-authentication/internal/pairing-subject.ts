import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import type { EmailPairingSubject } from "~/shell/email-authentication/contract";

export const emailPairingAllowsUser = ({ subject }: EmailPairingSubject): OwnedStatement => ({
  sql: `SELECT email_subject.pairingId, email_subject.userId FROM (${subject.sql}) AS email_subject
    WHERE NOT EXISTS (SELECT 1 FROM browser_pairing_email_proofs AS email_proof
      WHERE email_proof.pairing_id = email_subject.pairingId
        AND email_proof.user_id <> email_subject.userId)`,
  params: subject.params,
});
