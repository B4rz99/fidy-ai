import { pendingExecutionRecoveryMs } from "../contract";
import { UserId } from "@fidy/server/identity-reference";
import { type Cause, Effect, type Schema } from "effect";
import type { WhatsAppUnavailable } from "../../whatsapp/contract";
import { whatsAppRecoveryPriority } from "../../whatsapp/operations";
import { expireHostedPending, hostedTranscriptRetentionMs } from "./turn-store";

const maximumUsersPerSweep = 100;

/** Independent Core cron fallback for lost DO alarms and expired personal Transcript evidence.
 * The query is bounded and prioritizes the oldest due work; failed batches retry next minute.
 */
export const sweepHostedTurns = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: number }>): Effect.Effect<
  void,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const due = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT user_id FROM (
    SELECT t.user_id, ${whatsAppRecoveryPriority()} AS due_ms
      FROM hosted_turns AS t
      WHERE t.status = 'pending' AND t.started_at_ms < ?
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
    UNION ALL
    SELECT user_id, expires_at_ms AS due_ms FROM hosted_confirmations
      WHERE expires_at_ms < ?
    ) GROUP BY user_id ORDER BY MIN(due_ms) LIMIT ?`)
        .bind(
          now - pendingExecutionRecoveryMs,
          now - hostedTranscriptRetentionMs,
          now - hostedTranscriptRetentionMs,
          now - hostedTranscriptRetentionMs,
          now,
          maximumUsersPerSweep
        )
        .all<{ user_id: string }>()
    );
    yield* Effect.forEach(
      due.results,
      (row) => expireHostedPending({ db, userId: UserId.make(row.user_id), now }),
      { concurrency: "unbounded", discard: true }
    );
  });
