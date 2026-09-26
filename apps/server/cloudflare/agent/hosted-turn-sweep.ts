import { UserId } from "@fidy/server/agent-runtime";
import {
  expireHostedPending,
  hostedTranscriptRetentionMs,
  pendingExecutionRecoveryMs,
} from "./turn-store";

const maximumUsersPerSweep = 100;

/** Independent Core cron fallback for lost DO alarms and expired personal Transcript evidence.
 * The query is bounded and prioritizes the oldest due work; failed batches retry next minute.
 */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const sweepHostedTurns = async (db: D1Database, now: number): Promise<void> => {
  const due = await db
    .prepare(`SELECT user_id FROM (
    SELECT user_id, started_at_ms AS due_ms FROM hosted_turns
      WHERE status = 'pending' AND started_at_ms < ?
    UNION ALL
    SELECT t.user_id, t.terminal_at_ms AS due_ms FROM hosted_turns AS t
      WHERE t.status <> 'pending' AND t.terminal_at_ms < ?
        AND EXISTS (SELECT 1 FROM transcript_entries AS e
          WHERE e.turn_id = t.id AND e.user_id = t.user_id)
    UNION ALL
    SELECT user_id, updated_at_ms AS due_ms FROM hosted_compacted_conversations
      WHERE updated_at_ms < ?
    UNION ALL
    SELECT user_id, day_ms AS due_ms FROM hosted_compaction_attempts
      WHERE day_ms < ?
    ) GROUP BY user_id ORDER BY MIN(due_ms) LIMIT ?`)
    .bind(
      now - pendingExecutionRecoveryMs,
      now - hostedTranscriptRetentionMs,
      now - hostedTranscriptRetentionMs,
      now - hostedTranscriptRetentionMs,
      maximumUsersPerSweep
    )
    .all<{ user_id: string }>();
  await Promise.all(
    due.results.map((row) => expireHostedPending({ db, userId: UserId.make(row.user_id), now }))
  );
};
