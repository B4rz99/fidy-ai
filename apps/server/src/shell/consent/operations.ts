import { Config, Schema } from "effect";
import { PATScopes } from "~/core/tokens/contract";
import { weeklyDisclosure } from "~/shell/consent/internal/weekly-disclosure";
import { proactivityDisclosure } from "~/shell/consent/internal/proactivity-disclosure";
import { DisclosureSnapshot } from "~/core/consent/contract";
import { decidePATRevocation } from "~/core/consent/operations";
import { type OwnedStatement } from "~/shell/owner-write/contract";
import {
  userRevocationProofStatement,
  userRevocationStatement,
} from "~/shell/consent/internal/oauth-management";
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
  type PATRevocationProtection,
  type PairedPATConsentInput,
  type ProactivityOptInKind,
  type RevokeAllPATConsentsInput,
  type RevokeAllPairingConsentsInput,
  type RevokeOnePATConsentInput,
} from "./contract";

/** Exact category-specific disclosure. Neither returning it nor a model presenting its text establishes delivery or User agreement. */
export const proactivityDisclosureFor = (kind: ProactivityOptInKind): DisclosureSnapshot =>
  proactivityDisclosure(kind);

/** Exact source-controlled contextual opt-in, independent of model-generated presentation. */
export const weeklyDisclosureFor = (): DisclosureSnapshot => weeklyDisclosure();

export {
  canRecordConsentIngressDecision,
  classifyConsentIngressReplay,
  decideConsentReply,
  decidePATRevocation,
  isConsentIngressDecisionPhase,
} from "~/core/consent/operations";

/** Append the exact reviewed OAuth grant after its guarded connection insertion in the same unit. */
export const grantOAuthConsent = (input: OAuthGrantConsentInput): OwnedStatement => ({
  sql: `INSERT INTO oauth_grant_consents (id,connection_id,user_id,session_id,disclosure_revision,disclosure_text,accepted_at_ms)
    SELECT ?,?,?,?,?,?,? WHERE changes() = 1`,
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
/** Appends the exact first-party decision for each owner-selected same-User grant, in its revocation unit. Already terminal grants gain no duplicate evidence. */
export const revokeOAuthUserConsent: typeof userRevocationStatement = (input) =>
  userRevocationStatement(input);
/** Requires the same fresh browser decision's immutable Consent evidence for each terminal transition. */
export const oauthUserRevocationProof: typeof userRevocationProofStatement = (input) =>
  userRevocationProofStatement(input);
/** Automatic replay cleanup requires same-User grant evidence and atomic replay selection, not renewed Consent to issue credentials. */
export const revokeOAuthReplayConsent = (input: OAuthReplayConsentInput): OwnedStatement => ({
  sql: `INSERT INTO oauth_revocation_consents(id,user_id,connection_id,reason,occurred_at_ms)
    SELECT ?,?,?,'refresh_replay',? WHERE EXISTS (${input.replay.sql})
    AND EXISTS (SELECT 1 FROM oauth_grant_consents WHERE connection_id = ? AND user_id = ?)`,
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
/** Lends same-User OAuth grant evidence without exposing Consent's ledger columns to the credential owner. */
export const protectOAuthGrantConsentAuthority = <Authority extends ConsentAuthority>(
  input: Readonly<{ authority: Authority; subject: OAuthGrantConsentSubject }>
): Authority => ({
  ...input.authority,
  predicate: `${input.authority.predicate} AND EXISTS (SELECT 1 FROM oauth_grant_consents WHERE connection_id = ? AND user_id = ?)`,
  bindings: [...input.authority.bindings, input.subject.connectionId, input.subject.userId],
});
/**
 * Validates the exact current disclosure and policy facts presented before User creation.
 * Material legal-copy changes require a new source-controlled revision and matching digest.
 */
export const currentDisclosureFor = (): DisclosureSnapshot =>
  Schema.decodeSync(DisclosureSnapshot)(currentDisclosureFacts);

/** The same origin-qualified legal snapshot is used by the application and WhatsApp. */
export const currentDisclosure: Config.Config<DisclosureSnapshot> =
  Config.succeed(currentDisclosureFor());

/**
 * Prepare append-only revocation for the selected live grant owned by this fresh WebSession.
 * Commit it in the caller's PAT-revocation unit before its matching terminal transition;
 * neither this preparation nor a stale session records evidence on its own.
 */
export const revokeOnePATConsent = (input: RevokeOnePATConsentInput): OwnedStatement =>
  revokeOnePATConsentStatement({ ...input, disclosure: decidePATRevocation("user-revoke-one") });

/**
 * Prepare one authenticated revocation per active PAT grant for this User. Commit with the
 * corresponding PAT transitions in the same unit; already revoked grants gain no duplicate evidence.
 */
export const revokeAllPATConsents = (input: RevokeAllPATConsentsInput): OwnedStatement =>
  revokeAllPATConsentsStatement({ ...input, disclosure: decidePATRevocation("user-revoke-all") });

/**
 * Prepare authenticated revocation of this User's approved, unclaimed pairing grants.
 * The caller commits these records and the paired terminal transitions in the same unit.
 */
export const revokeAllPairingConsents = (input: RevokeAllPairingConsentsInput): OwnedStatement =>
  revokeAllPairingConsentsStatement({
    ...input,
    disclosure: decidePATRevocation("user-revoke-unclaimed"),
  });

/**
 * Prepare automatic-policy evidence for the oldest bounded set of expired unclaimed approvals.
 * Commit with the expiry transition using the identical decision instant and selection limit.
 */
export const expirePairingConsents = (input: ExpirePairingConsentsInput): OwnedStatement =>
  expirePairingConsentsStatement({
    ...input,
    disclosure: decidePATRevocation("approved-unclaimed-expiry"),
  });

/**
 * Prepare automatic-policy evidence for the oldest bounded set of fixed-lifetime PAT expirations.
 * Commit with the expiry transition using the identical decision instant and selection limit.
 */
export const expirePATConsents = (input: ExpirePATConsentsInput): OwnedStatement =>
  expirePATConsentsStatement({
    ...input,
    disclosure: decidePATRevocation("fixed-lifetime-expiry"),
  });

/**
 * Prepare the exact reviewed manual grant with its immutable disclosure revision.
 * Commit immediately after its guarded single-PAT issuance in the same D1 unit: evidence is appended
 * only when that preceding transition changed exactly one row. No raw bearer enters this operation.
 */
export const grantManualPATConsent = (input: ManualPATConsentInput): OwnedStatement =>
  grantManualPATConsentStatement({ ...input, revision: "pat-grant-2026-09" });

/**
 * Prepare the exact reviewed pairing grant with its immutable disclosure revision.
 * Commit immediately after its guarded approval in the same D1 unit: evidence is appended only when
 * that preceding transition changed exactly one row. No private pairing proof enters this operation.
 */
export const grantPairedPATConsent = (input: PairedPATConsentInput): OwnedStatement =>
  grantPairedPATConsentStatement({ ...input, revision: "pat-pairing-grant-2026-09" });

/**
 * Require this purpose's Consent standing within the same D1 statement the owner commits.
 * The supplied statement must end at its current WHERE condition, before ORDER, LIMIT or RETURNING;
 * a correlated subject must denote that statement's same User. Preparation performs no effects.
 */
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

/**
 * Preserve a credential owner's complete live authority while requiring the same User's Consent.
 * The owner retains its predicate and bindings; the returned authority rechecks the required
 * standing whenever the owner uses it in its protected D1 action.
 */
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

/**
 * Couple a PAT owner's terminal transition to its matching immutable Consent evidence.
 * The owner supplies its complete User-scoped UPDATE ending at the WHERE condition and commits
 * the result after that evidence in the same D1 unit. No terminal transition occurs during preparation.
 */
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

/**
 * Project the PAT identities covered by this instant's fixed-lifetime expiry evidence.
 * The Tokens owner asserts their corresponding terminal state in the same atomic unit.
 */
export const expiredPATConsentIdentities = (current: number): OwnedStatement =>
  fixedExpiryEvidenceStatement(current);

/**
 * Project the pairing identities covered by this instant's unclaimed-approval expiry evidence.
 * The Tokens owner asserts their corresponding terminal state in the same atomic unit.
 */
export const expiredPairingConsentIdentities = (current: number): OwnedStatement =>
  pairingExpiryEvidenceStatement(current);
