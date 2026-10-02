import type { ConsentRevocationInput, OnboardingConsentInput } from "../contract";
import { webSessionCredentialAuthority } from "@fidy/server/web-session-operations";

export const onboardingEvidence = (input: OnboardingConsentInput): D1PreparedStatement =>
  input.db
    .prepare(`INSERT INTO onboarding_consent_records
    (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms)
    SELECT d.exchange_id, ?, d.disclosure_json, d.disclosure_message_id,
      d.decision_message_id, d.received_at_ms, d.occurred_at_ms FROM pending_consent_decisions d
    WHERE d.exchange_id = ? AND d.decision = 'accepted'`)
    .bind(input.userId, input.exchangeId);

export const revocationEvidence = (input: ConsentRevocationInput): D1PreparedStatement => {
  const authority = webSessionCredentialAuthority(input);
  return input.db
    .prepare(`INSERT INTO consent_user_revocations
    (id, user_id, grant_record_id, session_id, occurred_at_ms)
    SELECT ?, g.user_id, g.id, ?, ? FROM onboarding_consent_records g
    WHERE g.user_id = ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
      AND NOT EXISTS (SELECT 1 FROM consent_user_revocations r WHERE r.user_id = g.user_id)`)
    .bind(
      input.evidenceId,
      input.subject.id,
      input.current,
      input.subject.userId,
      ...authority.bindings
    );
};
