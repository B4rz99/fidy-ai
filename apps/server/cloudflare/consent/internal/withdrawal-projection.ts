/** Only stable User membership is projected; private revocation evidence never leaves Consent. */
export const withdrawalProjection = `WITH consent_withdrawals AS (
  SELECT user_id FROM consent_user_revocations
)`;
