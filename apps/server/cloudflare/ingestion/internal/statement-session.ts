import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

/** Copy Agent's verified lifecycle projection inside the very same admission or terminal unit.
 * The source exposes only session_id, user_id, expires_at_ms. It grants no publication authority.
 * Crossing a deadline or changing sessions permanently settles clarification before any extension.
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
  db
    .prepare(`UPDATE statement_clarifications SET state = 'abandoned', ended_at_ms = ?
    WHERE user_id = ? AND state = 'awaiting' AND EXISTS
      (SELECT 1 FROM statement_hosted_origins o WHERE o.submission_id = statement_clarifications.submission_id
        AND o.user_id = ? AND o.abandoned_at_ms IS NOT NULL)`)
    .bind(current, userId, userId),
  db
    .prepare(`UPDATE statement_clarifications SET expires_at_ms = min(
      (SELECT expires_at_ms FROM statement_hosted_origins o WHERE o.submission_id = statement_clarifications.submission_id),
      (SELECT min(evidence_expires_at_ms) FROM statement_needs_review r WHERE r.submission_id = statement_clarifications.submission_id))
    WHERE user_id = ? AND state = 'awaiting' AND EXISTS
      (SELECT 1 FROM statement_hosted_origins o WHERE o.submission_id = statement_clarifications.submission_id
        AND o.user_id = ? AND o.abandoned_at_ms IS NULL)`)
    .bind(userId, userId),
];
