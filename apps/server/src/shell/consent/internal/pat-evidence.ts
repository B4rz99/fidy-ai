import type { PATGrantSelection, PairingGrantSelection } from "~/shell/tokens/contract";
import type { PATRevocationDisclosure } from "~/core/consent/contract";
import type { FreshSessionSubject } from "~/shell/web-session/contract";
import { freshSessionExists, freshSessionParams } from "~/shell/web-session/operations";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";

// One fresh evidence id per row, including multi-grant revocation; no bearer enters a statement.
const randomConsentId = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
  || substr(hex(randomblob(2)),2) || '-a' || substr(hex(randomblob(2)),2) || '-'
  || hex(randomblob(6)))`;

type RevokeOneInput = Readonly<{ id: string; shortId: string; current: number }>;
/** Append a User-origin revocation only for the live grant owned by this fresh WebSession. */
export const revokeOnePATConsentStatement = ({
  disclosure,
  candidates,
  session,
  input,
}: Readonly<{
  candidates: PATGrantSelection;
  disclosure: PATRevocationDisclosure<"user-revoke-one">;
  session: FreshSessionSubject;
  input: RevokeOneInput;
}>): OwnedStatement => ({
  sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pat_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ?,g.id,p.user_id,p.id,?,?,?,?
    FROM (${candidates.statement.sql}) p JOIN pat_grant_consents g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.user_id = ? AND ${freshSessionExists}
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
  params: [
    input.id,
    session.id,
    disclosure.revision,
    disclosure.text,
    input.current,
    ...candidates.statement.params,
    session.user_id,
    ...freshSessionParams({ session, time: input.current }),
  ],
});

/** Append one origin-qualified revocation per active PAT grant under the same User. */
export const revokeAllPATConsentsStatement = ({
  disclosure,
  candidates,
  session,
  current,
}: Readonly<{
  candidates: PATGrantSelection;
  disclosure: PATRevocationDisclosure<"user-revoke-all">;
  session: FreshSessionSubject;
  current: number;
}>): OwnedStatement => ({
  sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pat_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,p.user_id,p.id,?,?,?,?
    FROM (${candidates.statement.sql}) p JOIN pat_grant_consents g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.user_id = ? AND ${freshSessionExists}
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
  params: [
    session.id,
    disclosure.revision,
    disclosure.text,
    current,
    ...candidates.statement.params,
    session.user_id,
    ...freshSessionParams({ session, time: current }),
  ],
});

/** Include approved but unclaimed PATPairing grants in a User's revoke-all decision. */
export const revokeAllPairingConsentsStatement = ({
  disclosure,
  candidates,
  session,
  current,
}: Readonly<{
  candidates: PairingGrantSelection;
  disclosure: PATRevocationDisclosure<"user-revoke-unclaimed">;
  session: FreshSessionSubject;
  current: number;
}>): OwnedStatement => ({
  sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pairing_id,session_id,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,q.user_id,q.id,?,?,?,?
    FROM (${candidates.statement.sql}) q JOIN pat_grant_consents g ON g.pairing_id = q.id AND g.user_id = q.user_id
    WHERE q.user_id = ? AND ${freshSessionExists}
      AND NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
  params: [
    session.id,
    disclosure.revision,
    disclosure.text,
    current,
    ...candidates.statement.params,
    session.user_id,
    ...freshSessionParams({ session, time: current }),
  ],
});

/** Scheduled expiry appends policy-origin evidence for approved unclaimed pairings. */
export const expirePairingConsentsStatement = ({
  disclosure,
  candidates,
  current,
}: Readonly<{
  candidates: PairingGrantSelection;
  disclosure: PATRevocationDisclosure<"approved-unclaimed-expiry">;
  current: number;
}>): OwnedStatement => ({
  sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pairing_id,policy_reason,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,q.user_id,q.id,?,?,?,?
    FROM (${candidates.statement.sql}) q JOIN pat_grant_consents g ON g.pairing_id = q.id AND g.user_id = q.user_id
    WHERE NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
  params: [
    disclosure.policyReason,
    disclosure.revision,
    disclosure.text,
    current,
    ...candidates.statement.params,
  ],
});

/** Scheduled expiry appends policy-origin evidence for every selected fixed-lifetime PAT. */
export const expirePATConsentsStatement = ({
  disclosure,
  candidates,
  current,
}: Readonly<{
  candidates: PATGrantSelection;
  disclosure: PATRevocationDisclosure<"fixed-lifetime-expiry">;
  current: number;
}>): OwnedStatement => ({
  sql: `INSERT INTO pat_revocation_consents
    (id,grant_consent_id,user_id,pat_id,policy_reason,disclosure_revision,disclosure_text,occurred_at_ms)
    SELECT ${randomConsentId},g.id,p.user_id,p.id,?,?,?,?
    FROM (${candidates.statement.sql}) p JOIN pat_grant_consents g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE NOT EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.grant_consent_id = g.id)`,
  params: [
    disclosure.policyReason,
    disclosure.revision,
    disclosure.text,
    current,
    ...candidates.statement.params,
  ],
});

type ManualGrantInput = Readonly<{
  id: string;
  requestId: string;
  disclosure: string;
  current: number;
}>;
/** The User's reviewed manual grant, chained to its guarded PAT issuance in the same D1 unit. */
export const grantManualPATConsentStatement = ({
  revision,
  session,
  input,
}: Readonly<{
  revision: string;
  session: FreshSessionSubject;
  input: ManualGrantInput;
}>): OwnedStatement => ({
  sql: `INSERT INTO pat_grant_consents (id,user_id,session_id,request_id,disclosure_revision,disclosure_text,accepted_at_ms)
    SELECT ?,?,?,?,?,?,? WHERE changes() = 1`,
  params: [
    input.id,
    session.user_id,
    session.id,
    input.requestId,
    revision,
    input.disclosure,
    input.current,
  ],
});

type PairedGrantInput = Readonly<{
  id: string;
  pairingId: string;
  disclosure: string;
  current: number;
}>;
/** The User's reviewed pairing approval, chained to the guarded pairing transition. */
export const grantPairedPATConsentStatement = ({
  revision,
  session,
  input,
}: Readonly<{
  revision: string;
  session: FreshSessionSubject;
  input: PairedGrantInput;
}>): OwnedStatement => ({
  sql: `INSERT INTO pat_grant_consents (id,user_id,session_id,pairing_id,disclosure_revision,disclosure_text,accepted_at_ms)
    SELECT ?,?,?,?,?,?,? WHERE changes() = 1`,
  params: [
    input.id,
    session.user_id,
    session.id,
    input.pairingId,
    revision,
    input.disclosure,
    input.current,
  ],
});
