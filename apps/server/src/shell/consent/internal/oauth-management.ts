import type { OwnedStatement } from "~/shell/owner-write/contract";
import type { OAuthUserRevocationInput } from "~/shell/consent/contract";

const revocationRevision = "oauth-revoke-2026-10";
const revocationDisclosure =
  "Revocar este acceso detiene llamadas y renovaciones futuras; no deshace acciones ya realizadas.";
export const userRevocationStatement = (input: OAuthUserRevocationInput): OwnedStatement => ({
  sql: `INSERT INTO oauth_user_revocation_consents(connection_id,user_id,session_id,reason,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT selected.connection_id,selected.user_id,?,?,?,?,? FROM (${input.selection.sql}) selected
    WHERE selected.user_id = ? AND EXISTS (SELECT 1 FROM oauth_grant_consents c WHERE c.connection_id = selected.connection_id AND c.user_id = selected.user_id)`,
  params: [
    input.session.id,
    input.reason,
    revocationRevision,
    revocationDisclosure,
    input.current,
    ...input.selection.params,
    input.session.user_id,
  ],
});
export const userRevocationProofStatement = (
  input: Pick<OAuthUserRevocationInput, "session" | "current" | "reason">
): OwnedStatement => ({
  sql: `SELECT connection_id FROM oauth_user_revocation_consents WHERE user_id = ? AND session_id = ? AND reason = ? AND occurred_at_ms = ?`,
  params: [input.session.user_id, input.session.id, input.reason, input.current],
});
