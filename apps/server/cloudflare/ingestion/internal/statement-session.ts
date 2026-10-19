import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

/** Copy Agent's verified lifecycle projection inside the very same admission or terminal unit.
 * The source exposes only session_id, user_id, expires_at_ms. It grants no publication authority.
 * Crossing a deadline or changing sessions closes hosted routing; the inbox retains its independent evidence deadline.
 */
export const prepareStatementSessionActivity = ({
  db,
  userId,
  current,
  source,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  source: OwnedStatement;
}>): ReadonlyArray<D1PreparedStatement> => [
  db
    .prepare(`WITH activity AS (${source.sql}) UPDATE statement_hosted_origins
    SET abandoned_at_ms = CASE WHEN expires_at_ms <= ? OR session_id !=
      (SELECT session_id FROM activity WHERE user_id = ?) OR
      (SELECT expires_at_ms FROM activity WHERE user_id = ?) <= ? THEN ? ELSE NULL END,
      expires_at_ms = CASE WHEN expires_at_ms > ? AND session_id =
        (SELECT session_id FROM activity WHERE user_id = ?) THEN
        (SELECT expires_at_ms FROM activity WHERE user_id = ?) ELSE expires_at_ms END
    WHERE user_id = ? AND abandoned_at_ms IS NULL AND EXISTS
      (SELECT 1 FROM activity WHERE user_id = ?)`)
    .bind(
      ...source.params,
      current,
      userId,
      userId,
      current,
      current,
      current,
      userId,
      userId,
      userId,
      userId
    ),
];
