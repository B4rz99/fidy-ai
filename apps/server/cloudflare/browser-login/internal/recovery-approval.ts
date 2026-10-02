import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { RecoveryBrowserPairingApproval, RecoveryBrowserPairingQuery } from "../contract";

export const pendingRecoveryPairingQuery = ({
  publicCode,
  current,
}: RecoveryBrowserPairingQuery): OwnedStatement => ({
  sql: `SELECT id AS pairingId, expires_at_ms AS expiresAt FROM browser_login_pairings
    WHERE public_code = ? AND state = 'pending_approval' AND expires_at_ms > ?`,
  params: [publicCode, current],
});

export const approvedRecoveryPairingQuery = ({
  publicCode,
  current,
}: RecoveryBrowserPairingQuery): OwnedStatement => ({
  sql: `SELECT id AS pairingId, user_id AS userId, expires_at_ms AS expiresAt
    FROM browser_login_pairings WHERE public_code = ? AND state = 'ready' AND expires_at_ms > ?`,
  params: [publicCode, current],
});

export const prepareRecoveryApproval = ({
  db,
  subject,
  current,
}: RecoveryBrowserPairingApproval): D1PreparedStatement =>
  db
    .prepare(`UPDATE browser_login_pairings SET state = 'ready',
      user_id = (SELECT userId FROM (${subject.sql}))
      WHERE id = (SELECT pairingId FROM (${subject.sql}))
        AND state = 'pending_approval' AND expires_at_ms > ?`)
    .bind(...subject.params, ...subject.params, current);
