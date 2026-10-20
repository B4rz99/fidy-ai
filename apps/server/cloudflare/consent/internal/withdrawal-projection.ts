/** Only stable User membership is projected; private revocation evidence never leaves Consent. */
export const withdrawalProjection = `WITH consent_withdrawals AS (
  SELECT user_id FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations
)`;
