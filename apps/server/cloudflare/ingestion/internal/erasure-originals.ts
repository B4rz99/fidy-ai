import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

export const originalKeys = (userId: string): OwnedStatement => ({
  sql: `SELECT 'statement' AS bucket,object_key FROM statement_staging_objects WHERE user_id=? AND object_deleted_at_ms IS NULL
    UNION SELECT 'email' AS bucket,object_key FROM forwarded_email_receipts WHERE user_id=? AND state<>'expired'
    UNION SELECT bucket,object_key FROM erasure_writers WHERE user_id=?`,
  params: [userId, userId, userId],
});
