import { Option } from "effect";
import { erasureAdmissionCondition } from "~/shell/erasure/operations";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import type {
  ConsentStandingRequirement,
  ConsentSubject,
  PATRevocationProtection,
} from "~/shell/consent/contract";

const subjectExpression = (subject: ConsentSubject): string =>
  subject._tag === "User" ? "?" : subject.column;

const subjectBindings = (subject: ConsentSubject): ReadonlyArray<string> =>
  subject._tag === "User" ? [subject.userId] : [];

export const consentConditions = ({
  subject,
  requirement,
}: Readonly<{
  subject: ConsentSubject;
  requirement: ConsentStandingRequirement;
}>): OwnedStatement => {
  const conditions: Array<string> = [];
  const params: Array<string> = [];
  if (requirement !== "unrevoked") {
    conditions.push(
      `EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = ${subjectExpression(subject)})`
    );
    params.push(...subjectBindings(subject));
  }
  if (requirement !== "granted") {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = ${subjectExpression(subject)})`
    );
    params.push(...subjectBindings(subject));
  }
  const erasure = erasureAdmissionCondition({ subject, admitted: requirement === "granted" });
  return {
    sql: [...conditions, erasure.sql].join(" AND "),
    params: [...params, ...erasure.params],
  };
};

export const revocationEvidence = (evidence: PATRevocationProtection): OwnedStatement => {
  switch (evidence._tag) {
    case "UserPAT":
      return {
        sql: `EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') r WHERE r.pat_id = pats.id
          AND r.session_id = ?${Option.isSome(evidence.occurredAtMs) ? " AND r.occurred_at_ms = ?" : ""})`,
        params: [evidence.sessionId, ...Option.toArray(evidence.occurredAtMs)],
      };
    case "UserPairing":
      return {
        sql: `EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') r WHERE r.pairing_id = pat_pairings.id AND r.session_id = ?)`,
        params: [evidence.sessionId],
      };
    case "ExpiredPAT":
      return {
        sql: `EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') r WHERE r.pat_id = pats.id
          AND r.reason = 'pat-fixed-lifetime-expiry')`,
        params: [],
      };
    case "ExpiredPairing":
      return {
        sql: `EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') r WHERE r.pairing_id = pat_pairings.id
          AND r.reason = 'pat-approved-unclaimed-expiry')`,
        params: [],
      };
  }
};

export const fixedExpiryEvidenceStatement = (current: number): OwnedStatement => ({
  sql: `SELECT pat_id AS id FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') AS pat_revocation_consents
  WHERE reason = 'pat-fixed-lifetime-expiry' AND occurred_at_ms = ?`,
  params: [current],
});

export const pairingExpiryEvidenceStatement = (current: number): OwnedStatement => ({
  sql: `SELECT pairing_id AS id FROM (SELECT * FROM consent_history WHERE record_type='pat_revocation') AS pat_revocation_consents
  WHERE reason = 'pat-approved-unclaimed-expiry' AND occurred_at_ms = ?`,
  params: [current],
});
