import { maximumWrongVerifierAttempts } from "../../../src/core/browser-login/rules";
import type { BrowserPairingClaim, BrowserPairingProof } from "../contract";

export const prepareClaim = ({
  pairingId,
  verifierDigest,
  current,
}: BrowserPairingProof): BrowserPairingClaim => ({
  current,
  consume: {
    sql: `UPDATE browser_login_pairings SET state = 'consumed' WHERE id = ? AND state = 'ready'
      AND expires_at_ms > ? AND wrong_attempts < ? AND verifier_digest = ?`,
    params: [pairingId, current, maximumWrongVerifierAttempts, verifierDigest],
  },
  subject: {
    sql: `SELECT id AS pairingId, user_id AS userId FROM browser_login_pairings
      WHERE id = ? AND state = 'consumed' AND user_id IS NOT NULL AND verifier_digest = ?`,
    params: [pairingId, verifierDigest],
  },
});
