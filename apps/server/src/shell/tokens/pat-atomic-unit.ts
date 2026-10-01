import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import {
  completeFixedPATConsentExpiry,
  completePairingConsentExpiry,
} from "~/shell/consent/operations";

/** Final statement for a guarded PAT transition; a skipped prerequisite aborts the whole D1 batch. */
export const patAtomicAssertion = `INSERT INTO pat_atomic_assertion (id, accepted)
VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

/** Reject automatic expiry evidence without its corresponding PAT or pairing transition. */
export const patExpiryCompletion = (current: number): OwnedStatement =>
  completeFixedPATConsentExpiry(current);
export const pairingExpiryCompletion = (current: number): OwnedStatement =>
  completePairingConsentExpiry(current);

/** A revoke-all may succeed with no grants, but cannot leave any active User-owned grant behind. */
export const patRevokeAllCompletion = `INSERT INTO pat_atomic_assertion (id, accepted)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT 1 FROM pats WHERE user_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
) AND NOT EXISTS (
  SELECT 1 FROM pat_pairings WHERE user_id = ? AND state = 'approved_awaiting_claim'
) THEN 1 ELSE 0 END
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;
