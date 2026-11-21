import { webDisclosureFacts } from "~/shell/consent/internal/web-disclosure";
import { Config, Schema } from "effect";
import { PATScopes } from "~/core/tokens/contract";
import { weeklyDisclosure } from "~/shell/consent/internal/weekly-disclosure";
import { proactivityDisclosure } from "~/shell/consent/internal/proactivity-disclosure";
import { DisclosureSnapshot } from "~/core/consent/contract";
import { decidePATRevocation } from "~/core/consent/operations";
import { type OwnedStatement } from "~/shell/owner-write/contract";
import { currentDisclosureFacts } from "~/shell/consent/internal/current-disclosure";
import {
  expirePATConsentsStatement,
  expirePairingConsentsStatement,
  grantManualPATConsentStatement,
  grantPairedPATConsentStatement,
  revokeAllPATConsentsStatement,
  revokeAllPairingConsentsStatement,
  revokeOnePATConsentStatement,
} from "~/shell/consent/internal/pat-evidence";
import {
  consentConditions,
  fixedExpiryEvidenceStatement,
  pairingExpiryEvidenceStatement,
  revocationEvidence,
} from "~/shell/consent/internal/protected-actions";
import {
  type ConsentAuthority,
  type ConsentProtectedStatement,
  type ConsentStandingRequirement,
  type ConsentSubject,
  type ExpirePATConsentsInput,
  type ExpirePairingConsentsInput,
  type ManualPATConsentInput,
  type OAuthGrantConsentInput,
  type OAuthGrantConsentSubject,
  type OAuthReplayConsentInput,
  type OAuthUserRevocationInput,
  type PATRevocationProtection,
  type PairedPATConsentInput,
  type ProactivityOptInKind,
  type RevokeAllPATConsentsInput,
  type RevokeAllPairingConsentsInput,
  type RevokeOnePATConsentInput,
} from "./contract";

export const proactivityDisclosureFor = (kind: ProactivityOptInKind): DisclosureSnapshot =>
  proactivityDisclosure(kind);

export const weeklyDisclosureFor = (): DisclosureSnapshot => weeklyDisclosure();

export {
  canRecordConsentIngressDecision,
  classifyConsentIngressReplay,
  decideConsentReply,
  decidePATRevocation,
  isConsentIngressDecisionPhase,
} from "~/core/consent/operations";

const revocationRevision = "oauth-revoke-2026-10";

const revocationDisclosure =
  "Revocar este acceso detiene llamadas y renovaciones futuras; no deshace acciones ya realizadas.";

export const grantOAuthConsent = (input: OAuthGrantConsentInput): OwnedStatement => ({
  sql: `INSERT INTO consent_history (record_type,id,connection_id,user_id,session_id,disclosure_json,occurred_at_ms) SELECT 'oauth_grant',?,?,?,?,json_object('revision',?,'text',?),? WHERE changes() = 1`,
  params: [
    input.id,
    input.connectionId,
    input.session.user_id,
    input.session.id,
    "oauth-grant-2026-10",
    Schema.encodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          capabilities: PATScopes,
          expiresAt: Schema.Int,
          purpose: Schema.String,
        })
      )
    )({
      capabilities: input.scopes,
      expiresAt: input.expiresAt,
      purpose:
        "Autorizar al cliente externo indicado para usar Fidy durante el intervalo aprobado.",
    }),
    input.current,
  ],
});

export const revokeOAuthUserConsent = (input: OAuthUserRevocationInput): OwnedStatement => ({
  sql: `INSERT INTO consent_history (record_type,connection_id,user_id,session_id,reason,disclosure_json,occurred_at_ms) SELECT 'oauth_user_revocation',selected.connection_id,selected.user_id,?,?,json_object('revision',?,'text',?),? FROM (${input.selection.sql}) selected
    WHERE selected.user_id = ? AND EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='oauth_grant') c WHERE c.connection_id = selected.connection_id AND c.user_id = selected.user_id)`,
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

export const oauthUserRevocationProof = (
  input: Pick<OAuthUserRevocationInput, "session" | "current" | "reason">
): OwnedStatement => ({
  sql: `SELECT connection_id FROM (SELECT * FROM consent_history WHERE record_type='oauth_user_revocation') AS oauth_user_revocation_consents WHERE user_id = ? AND session_id = ? AND reason = ? AND occurred_at_ms = ?`,
  params: [input.session.user_id, input.session.id, input.reason, input.current],
});

export const revokeOAuthReplayConsent = (input: OAuthReplayConsentInput): OwnedStatement => ({
  sql: `INSERT INTO consent_history (record_type,id,user_id,connection_id,reason,occurred_at_ms) SELECT 'oauth_replay_revocation',?,?,?,'refresh_replay',? WHERE EXISTS (${input.replay.sql})
    AND EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='oauth_grant') AS oauth_grant_consents WHERE connection_id = ? AND user_id = ?)`,
  params: [
    input.id,
    input.userId,
    input.connectionId,
    input.current,
    ...input.replay.params,
    input.connectionId,
    input.userId,
  ],
});

export const protectOAuthGrantConsentAuthority = <Authority extends ConsentAuthority>(
  input: Readonly<{ authority: Authority; subject: OAuthGrantConsentSubject }>
): Authority => ({
  ...input.authority,
  predicate: `${input.authority.predicate} AND EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='oauth_grant') AS oauth_grant_consents WHERE connection_id = ? AND user_id = ?)`,
  bindings: [...input.authority.bindings, input.subject.connectionId, input.subject.userId],
});

export const currentDisclosureFor = (): DisclosureSnapshot =>
  Schema.decodeSync(DisclosureSnapshot)(currentDisclosureFacts);

export const currentDisclosure: Config.Config<DisclosureSnapshot> =
  Config.succeed(currentDisclosureFor());

export const revokeOnePATConsent = (input: RevokeOnePATConsentInput): OwnedStatement =>
  revokeOnePATConsentStatement({ ...input, disclosure: decidePATRevocation("user-revoke-one") });

export const revokeAllPATConsents = (input: RevokeAllPATConsentsInput): OwnedStatement =>
  revokeAllPATConsentsStatement({ ...input, disclosure: decidePATRevocation("user-revoke-all") });

export const revokeAllPairingConsents = (input: RevokeAllPairingConsentsInput): OwnedStatement =>
  revokeAllPairingConsentsStatement({
    ...input,
    disclosure: decidePATRevocation("user-revoke-unclaimed"),
  });

export const expirePairingConsents = (input: ExpirePairingConsentsInput): OwnedStatement =>
  expirePairingConsentsStatement({
    ...input,
    disclosure: decidePATRevocation("approved-unclaimed-expiry"),
  });

export const expirePATConsents = (input: ExpirePATConsentsInput): OwnedStatement =>
  expirePATConsentsStatement({
    ...input,
    disclosure: decidePATRevocation("fixed-lifetime-expiry"),
  });

export const grantManualPATConsent = (input: ManualPATConsentInput): OwnedStatement =>
  grantManualPATConsentStatement({ ...input, revision: "pat-grant-2026-09" });

export const grantPairedPATConsent = (input: PairedPATConsentInput): OwnedStatement =>
  grantPairedPATConsentStatement({ ...input, revision: "pat-pairing-grant-2026-09" });

export const protectConsentStatement = ({
  statement,
  subject,
  requirement,
}: ConsentProtectedStatement): OwnedStatement => {
  const guard = consentConditions({ subject, requirement });

  return {
    sql: `${statement.sql} AND ${guard.sql}`,
    params: [...statement.params, ...guard.params],
  };
};

export const protectConsentAuthority = <Authority extends ConsentAuthority>({
  authority,
  subject,
  requirement,
}: Readonly<{
  authority: Authority;
  subject: ConsentSubject;
  requirement: ConsentStandingRequirement;
}>): Authority => {
  const guard = consentConditions({ subject, requirement });

  return {
    ...authority,
    predicate: `${authority.predicate} AND ${guard.sql}`,
    bindings: [...authority.bindings, ...guard.params],
  };
};

export const protectPATRevocationStatement = ({
  statement,
  evidence,
}: Readonly<{
  statement: OwnedStatement;
  evidence: PATRevocationProtection;
}>): OwnedStatement => {
  const guard = revocationEvidence(evidence);

  return {
    sql: `${statement.sql} AND ${guard.sql}`,
    params: [...statement.params, ...guard.params],
  };
};

export const expiredPATConsentIdentities = (current: number): OwnedStatement =>
  fixedExpiryEvidenceStatement(current);

export const expiredPairingConsentIdentities = (current: number): OwnedStatement =>
  pairingExpiryEvidenceStatement(current);

export const webSignupDisclosure = (): DisclosureSnapshot =>
  Schema.decodeSync(DisclosureSnapshot)(webDisclosureFacts);
