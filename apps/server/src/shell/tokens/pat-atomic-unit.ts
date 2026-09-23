/** Final statement for a guarded PAT transition; a skipped prerequisite aborts the whole D1 batch. */
export const patAtomicAssertion = `INSERT INTO pat_atomic_assertion (id, accepted)
VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

/** Reject automatic expiry evidence without its corresponding PAT or pairing transition. */
export const patExpiryCompletion = `INSERT INTO pat_atomic_assertion (id, accepted)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1 FROM pat_revocation_consents r JOIN pats p ON p.id = r.pat_id
  WHERE r.policy_reason = 'pat-fixed-lifetime-expiry' AND r.occurred_at_ms = ? AND p.revoked_at_ms IS NULL
) THEN 1 ELSE 0 END
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;
export const pairingExpiryCompletion = `INSERT INTO pat_atomic_assertion (id, accepted)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1 FROM pat_revocation_consents r JOIN pat_pairings p ON p.id = r.pairing_id
  WHERE r.policy_reason = 'pat-approved-unclaimed-expiry' AND r.occurred_at_ms = ?
  AND p.state = 'approved_awaiting_claim'
) THEN 1 ELSE 0 END
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

/** A revoke-all may succeed with no grants, but cannot leave any active User-owned grant behind. */
export const patRevokeAllCompletion = `INSERT INTO pat_atomic_assertion (id, accepted)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1 FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
) AND NOT EXISTS (
  SELECT 1 FROM pat_pairings WHERE user_id = ? AND state = 'approved_awaiting_claim'
) THEN 1 ELSE 0 END
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;
