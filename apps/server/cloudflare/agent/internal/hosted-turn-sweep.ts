import { pendingExecutionRecoveryMs } from "../contract";
import { UserId } from "../../../src/core/identity/contract";
import { type Cause, Effect, Schema } from "effect";
import type { WhatsAppUnavailable } from "../../whatsapp/contract";
import { whatsAppRecoveryPriority } from "../../whatsapp/operations";
import { expireHostedPending, hostedTranscriptRetentionMs } from "./turn-store";

const maximumUsersPerSweep = 100;
const retentionConcurrency = 4;

/** Independent Core cron fallback for lost DO alarms and expired personal Transcript evidence.
 * Each indexed branch is bounded before User grouping; failed batches retry next minute.
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
        .prepare(`WITH
    pending AS (SELECT t.user_id, ${whatsAppRecoveryPriority()} AS due_ms
      FROM (SELECT id, user_id, started_at_ms FROM hosted_turns
        WHERE status = 'pending' AND started_at_ms < ?
        ORDER BY started_at_ms, user_id LIMIT ?) AS t
    ),
    transcript AS (
      SELECT user_id, terminal_at_ms AS due_ms FROM hosted_turn_retention
      WHERE terminal_at_ms < ? ORDER BY terminal_at_ms, user_id, turn_id LIMIT ?
    ),
    compacted AS (
      SELECT user_id, updated_at_ms AS due_ms FROM hosted_compacted_conversations
      WHERE updated_at_ms < ? ORDER BY updated_at_ms, user_id LIMIT ?
    ),
    attempts AS (
      SELECT user_id, day_ms AS due_ms FROM hosted_compaction_attempts
      WHERE day_ms < ? ORDER BY day_ms, user_id LIMIT ?
    ),
    confirmations AS (
      SELECT user_id, expires_at_ms AS due_ms FROM hosted_confirmations
      WHERE expires_at_ms < ? ORDER BY expires_at_ms, user_id LIMIT ?
    )
    SELECT user_id FROM (SELECT * FROM pending UNION ALL SELECT * FROM transcript
      UNION ALL SELECT * FROM compacted UNION ALL SELECT * FROM attempts
      UNION ALL SELECT * FROM confirmations
    ) GROUP BY user_id ORDER BY MIN(due_ms), user_id LIMIT ?`)
        .bind(
          now - pendingExecutionRecoveryMs,
          maximumUsersPerSweep,
          now - hostedTranscriptRetentionMs,
          maximumUsersPerSweep,
          now - hostedTranscriptRetentionMs,
          maximumUsersPerSweep,
          now - hostedTranscriptRetentionMs,
          maximumUsersPerSweep,
          now,
          maximumUsersPerSweep,
          maximumUsersPerSweep
        )
        .all()
    );
    const users = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ user_id: UserId }))
    )(due.results);
    yield* Effect.forEach(users, (row) => expireHostedPending({ db, userId: row.user_id, now }), {
      concurrency: retentionConcurrency,
      discard: true,
    });
  });
