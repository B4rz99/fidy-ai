import type { UserId } from "@fidy/server/agent-runtime";
import type { OwnedStatement } from "../../../src/shell/_shared/owned-statement";

const turnMetadata = `SELECT id, user_id, hosted_session_id, status, started_at_ms, terminal_at_ms, failure_reason FROM hosted_turns`;

export const channelTurnQuery = (userId: UserId): OwnedStatement => ({
  sql: `${turnMetadata} WHERE user_id = ?`,
  params: [userId],
});
export const channelContinuationQuery = (userId: UserId): OwnedStatement => ({
  sql: `SELECT t.id, t.user_id, t.hosted_session_id, t.status, t.started_at_ms, e.text AS user_text
    FROM hosted_turns AS t JOIN transcript_entries AS e ON e.turn_id = t.id AND e.user_id = t.user_id AND e.kind = 'user'
    WHERE t.user_id = ?`,
  params: [userId],
});
export const channelUserEntryQuery = (userId: UserId): OwnedStatement => ({
  sql: "SELECT turn_id, user_id, text FROM transcript_entries WHERE user_id = ? AND kind = 'user'",
  params: [userId],
});
export const channelTurnObservation = (): string =>
  "SELECT id, user_id, status, terminal_at_ms, failure_reason FROM hosted_turns";
export const prepareChannelTurn = ({
  db,
  userId,
  statement,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  statement: OwnedStatement;
}>): D1PreparedStatement => {
  const turns = channelTurnQuery(userId);
  return db
    .prepare(`WITH channel_turns AS (${turns.sql}) ${statement.sql}`)
    .bind(...turns.params, ...statement.params);
};
