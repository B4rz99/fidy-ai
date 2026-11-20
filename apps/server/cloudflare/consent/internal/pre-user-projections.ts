export const acceptedCallerProjection = `WITH accepted_consent_callers AS (
  SELECT id AS exchange_id, portfolio_id, bsuid, phone_number_id, expires_at_ms FROM pending_consent_exchanges
  WHERE state = 'accepted'
)`;

export const operationalProjection = `WITH consent_pending_deliveries AS (
  SELECT created_at_ms FROM pending_consent_exchanges
  WHERE state IN ('awaiting_delivery', 'outbound_started')
), consent_expiry_deadlines AS (
  SELECT expires_at_ms FROM pending_consent_exchanges
)`;
