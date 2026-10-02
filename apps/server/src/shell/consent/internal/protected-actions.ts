import { Option } from "effect";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
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
      `EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = ${subjectExpression(subject)})`
    );
    params.push(...subjectBindings(subject));
  }
  if (requirement !== "granted") {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ${subjectExpression(subject)})`
    );
    params.push(...subjectBindings(subject));
  }
  return { sql: conditions.join(" AND "), params };
};

export const revocationEvidence = (evidence: PATRevocationProtection): OwnedStatement => {
  switch (evidence._tag) {
    case "UserPAT":
      return {
        sql: `EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pat_id = pats.id
          AND r.session_id = ?${Option.isSome(evidence.occurredAtMs) ? " AND r.occurred_at_ms = ?" : ""})`,
        params: [evidence.sessionId, ...Option.toArray(evidence.occurredAtMs)],
      };
    case "UserPairing":
      return {
        sql: `EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pairing_id = pat_pairings.id AND r.session_id = ?)`,
        params: [evidence.sessionId],
      };
    case "ExpiredPAT":
      return {
        sql: `EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pat_id = pats.id
          AND r.policy_reason = 'pat-fixed-lifetime-expiry')`,
        params: [],
      };
    case "ExpiredPairing":
      return {
        sql: `EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pairing_id = pat_pairings.id
          AND r.policy_reason = 'pat-approved-unclaimed-expiry')`,
        params: [],
      };
  }
};

export const fixedExpiryEvidenceSql = `SELECT pat_id AS id FROM pat_revocation_consents
  WHERE policy_reason = 'pat-fixed-lifetime-expiry' AND occurred_at_ms = ?`;

export const pairingExpiryEvidenceSql = `SELECT pairing_id AS id FROM pat_revocation_consents
  WHERE policy_reason = 'pat-approved-unclaimed-expiry' AND occurred_at_ms = ?`;
