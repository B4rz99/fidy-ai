import type { PATGrantSelection, PairingGrantSelection } from "~/shell/tokens/contract";
import type { PATRevocationDisclosure } from "~/core/consent/contract";
import type { FreshSessionSubject } from "~/shell/web-session/contract";
import { freshSessionExists, freshSessionParams } from "~/shell/web-session/operations";
import type { OwnedStatement } from "~/shell/owner-write/contract";

const randomConsentId = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
  || substr(hex(randomblob(2)),2) || '-a' || substr(hex(randomblob(2)),2) || '-'
  || hex(randomblob(6)))`;

type RevokeOneInput = Readonly<{ id: string; shortId: string; current: number }>;

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
  sql: `INSERT INTO consent_history (record_type,id,grant_consent_id,user_id,pat_id,session_id,disclosure_json,occurred_at_ms) SELECT 'pat_revocation',?,g.id,p.user_id,p.id,?,json_object('revision',?,'text',?),?
    FROM (${candidates.statement.sql}) p JOIN (SELECT * FROM consent_history WHERE record_type='pat_grant') g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.user_id = ? AND ${freshSessionExists}
      AND NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') r WHERE r.grant_consent_id = g.id)`,
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
  sql: `INSERT INTO consent_history (record_type,id,grant_consent_id,user_id,pat_id,session_id,disclosure_json,occurred_at_ms) SELECT 'pat_revocation',${randomConsentId},g.id,p.user_id,p.id,?,json_object('revision',?,'text',?),?
    FROM (${candidates.statement.sql}) p JOIN (SELECT * FROM consent_history WHERE record_type='pat_grant') g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE p.user_id = ? AND ${freshSessionExists}
      AND NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') r WHERE r.grant_consent_id = g.id)`,
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
  sql: `INSERT INTO consent_history (record_type,id,grant_consent_id,user_id,pairing_id,session_id,disclosure_json,occurred_at_ms) SELECT 'pat_revocation',${randomConsentId},g.id,q.user_id,q.id,?,json_object('revision',?,'text',?),?
    FROM (${candidates.statement.sql}) q JOIN (SELECT * FROM consent_history WHERE record_type='pat_grant') g ON g.pairing_id = q.id AND g.user_id = q.user_id
    WHERE q.user_id = ? AND ${freshSessionExists}
      AND NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') r WHERE r.grant_consent_id = g.id)`,
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

export const expirePairingConsentsStatement = ({
  disclosure,
  candidates,
  current,
}: Readonly<{
  candidates: PairingGrantSelection;
  disclosure: PATRevocationDisclosure<"approved-unclaimed-expiry">;
  current: number;
}>): OwnedStatement => ({
  sql: `INSERT INTO consent_history (record_type,id,grant_consent_id,user_id,pairing_id,reason,disclosure_json,occurred_at_ms) SELECT 'pat_revocation',${randomConsentId},g.id,q.user_id,q.id,?,json_object('revision',?,'text',?),?
    FROM (${candidates.statement.sql}) q JOIN (SELECT * FROM consent_history WHERE record_type='pat_grant') g ON g.pairing_id = q.id AND g.user_id = q.user_id
    WHERE NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') r WHERE r.grant_consent_id = g.id)`,
  params: [
    disclosure.policyReason,
    disclosure.revision,
    disclosure.text,
    current,
    ...candidates.statement.params,
  ],
});

export const expirePATConsentsStatement = ({
  disclosure,
  candidates,
  current,
}: Readonly<{
  candidates: PATGrantSelection;
  disclosure: PATRevocationDisclosure<"fixed-lifetime-expiry">;
  current: number;
}>): OwnedStatement => ({
  sql: `INSERT INTO consent_history (record_type,id,grant_consent_id,user_id,pat_id,reason,disclosure_json,occurred_at_ms) SELECT 'pat_revocation',${randomConsentId},g.id,p.user_id,p.id,?,json_object('revision',?,'text',?),?
    FROM (${candidates.statement.sql}) p JOIN (SELECT * FROM consent_history WHERE record_type='pat_grant') g ON g.user_id = p.user_id
      AND (g.request_id = p.request_id OR g.pairing_id = p.pairing_id)
    WHERE NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') r WHERE r.grant_consent_id = g.id)`,
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

export const grantManualPATConsentStatement = ({
  revision,
  session,
  input,
}: Readonly<{
  revision: string;
  session: FreshSessionSubject;
  input: ManualGrantInput;
}>): OwnedStatement => ({
  sql: `INSERT INTO consent_history (record_type,id,user_id,session_id,request_id,disclosure_json,occurred_at_ms) SELECT 'pat_grant',?,?,?,?,json_object('revision',?,'text',?),? WHERE changes() = 1`,
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

export const grantPairedPATConsentStatement = ({
  revision,
  session,
  input,
}: Readonly<{
  revision: string;
  session: FreshSessionSubject;
  input: PairedGrantInput;
}>): OwnedStatement => ({
  sql: `INSERT INTO consent_history (record_type,id,user_id,session_id,pairing_id,disclosure_json,occurred_at_ms) SELECT 'pat_grant',?,?,?,?,json_object('revision',?,'text',?),? WHERE changes() = 1`,
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
