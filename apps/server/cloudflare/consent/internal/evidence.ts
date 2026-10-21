import type { ConsentRevocationInput, OnboardingConsentInput } from "../contract";
import { webSessionCredentialAuthority } from "../../../src/shell/web-session/operations";

export const onboardingEvidence = (input: OnboardingConsentInput): D1PreparedStatement =>
  input.db
    .prepare(`INSERT INTO consent_history (record_type,id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, occurred_at_ms) SELECT 'processing_grant',id, ?, disclosure_json, disclosure_message_id,
      decision_message_id, decision_received_at_ms, decision_occurred_at_ms
    FROM pending_consent_exchanges WHERE id = ? AND decision_value = 'accepted'`)
    .bind(input.userId, input.exchangeId);

export const revocationEvidence = (input: ConsentRevocationInput): D1PreparedStatement => {
  const authority = webSessionCredentialAuthority(input);
  return input.db
    .prepare(`INSERT INTO consent_history(record_type,id, user_id, grant_record_id, session_id, occurred_at_ms) SELECT 'processing_withdrawal', ?, g.user_id, g.id, ?, ? FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') g
    WHERE g.user_id = ? AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
      AND NOT EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) r WHERE r.user_id = g.user_id)`)
    .bind(
      input.evidenceId,
      input.subject.id,
      input.current,
      input.subject.userId,
      ...authority.bindings
    );
};
