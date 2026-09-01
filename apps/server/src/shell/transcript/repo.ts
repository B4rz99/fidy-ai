import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { HostedAgentSessionId } from "~/core/transcript/hosted-agent-session";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  TranscriptContentEntry,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptTurnId,
} from "~/core/transcript/model";

const PersistedTranscriptEntry = Schema.toCodecJson(TranscriptEntry);
const PersistedTranscriptContentEntry = Schema.toCodecJson(TranscriptContentEntry);
const TranscriptEntryRow = Schema.Struct({ entry: PersistedTranscriptEntry });
const RecentTranscriptRequest = Schema.Struct({
  subjectUserId: UserId,
  hostedAgentSessionId: HostedAgentSessionId,
  maxTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
const TranscriptTurnRequest = Schema.Struct({
  subjectUserId: UserId,
  turnId: TranscriptTurnId,
});
const OwnedTranscriptEntryRow = Schema.Struct({
  subjectUserId: UserId,
  entryId: TranscriptEntryId,
  turnId: TranscriptTurnId,
  entry: PersistedTranscriptContentEntry,
});

const appendOne = Effect.fn(function* (subjectUserId: UserId, entry: TranscriptContentEntry) {
  const sql = yield* SqlClient.SqlClient;
  yield* SqlSchema.findOne({
    Request: OwnedTranscriptEntryRow,
    Result: Schema.Struct({ entryId: TranscriptEntryId }),
    execute: (row) => sql`
      INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
      VALUES (${row.subjectUserId}, ${row.entryId}, ${row.turnId}, ${row.entry}::jsonb)
      RETURNING entry_id AS "entryId"
    `,
  })({ subjectUserId, entryId: entry.id, turnId: entry.turnId, entry }).pipe(Effect.orDie);
});

/**
 * Appends entries in their supplied order for one explicit User. The database
 * sequence is authoritative across turns; callers cannot overwrite or reorder
 * retained conversation history.
 */
export const appendTranscriptEntries = Effect.fn("appendTranscriptEntries")(function* (
  subjectUserId: UserId,
  entries: ReadonlyArray<TranscriptContentEntry>
) {
  yield* withUserTransaction(
    subjectUserId,
    Effect.forEach(entries, (entry) => appendOne(subjectUserId, entry), {
      concurrency: 1,
      discard: true,
    })
  );
});

/**
 * Reads only the newest bounded complete turns of one Hosted Agent Session for model-context
 * selection. Entries carry no session of their own, so the owning Turn supplies it: a prior
 * session's material must not re-enter a later one.
 */
export const selectRecentTranscriptEntries = Effect.fn("selectRecentTranscriptEntries")(function* (
  subjectUserId: UserId,
  hostedAgentSessionId: HostedAgentSessionId,
  maxTurns: number
): Effect.fn.Return<ReadonlyArray<TranscriptEntry>, never, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* withUserTransaction(
    subjectUserId,
    SqlSchema.findAll({
      Request: RecentTranscriptRequest,
      Result: TranscriptEntryRow,
      execute: (request) => sql`
        WITH recent_turns AS (
          SELECT transcript.turn_id, max(transcript.sequence) AS newest_sequence
          FROM transcript_entries AS transcript
          INNER JOIN conversation_turns AS turn
            ON turn.user_id = transcript.user_id AND turn.id = transcript.turn_id
          WHERE transcript.user_id = ${request.subjectUserId}
            AND turn.session_id = ${request.hostedAgentSessionId}
          GROUP BY transcript.turn_id
          HAVING (array_agg(transcript.entry->>'_tag' ORDER BY transcript.sequence DESC))[1]
            = 'AssistantTranscriptEntry'
          ORDER BY newest_sequence DESC
          LIMIT ${request.maxTurns}
        )
        SELECT transcript.entry
        FROM transcript_entries AS transcript
        INNER JOIN recent_turns USING (turn_id)
        WHERE transcript.user_id = ${request.subjectUserId}
        ORDER BY transcript.sequence
      `,
    })({ subjectUserId, hostedAgentSessionId, maxTurns }).pipe(Effect.orDie)
  );
  return rows.map(({ entry }) => entry);
});

/** Reads one explicit turn, including an in-progress turn, in append order. */
export const selectTranscriptTurnEntries = Effect.fn("selectTranscriptTurnEntries")(function* (
  subjectUserId: UserId,
  turnId: TranscriptTurnId
): Effect.fn.Return<ReadonlyArray<TranscriptEntry>, never, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* withUserTransaction(
    subjectUserId,
    SqlSchema.findAll({
      Request: TranscriptTurnRequest,
      Result: TranscriptEntryRow,
      execute: (request) => sql`
      SELECT entry
      FROM transcript_entries
      WHERE user_id = ${request.subjectUserId} AND turn_id = ${request.turnId}
      ORDER BY sequence
    `,
    })({ subjectUserId, turnId }).pipe(Effect.orDie)
  );
  return rows.map(({ entry }) => entry);
});

/** Reads one User's complete Transcript in append order, decoding every JSONB row. */
export const selectTranscriptEntries = (
  subjectUserId: UserId
): Effect.Effect<ReadonlyArray<TranscriptEntry>, never, SqlClient.SqlClient> =>
  withUserTransaction(
    subjectUserId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findAll({
        Request: UserId,
        Result: TranscriptEntryRow,
        execute: (userId) => sql`
        SELECT entry
        FROM transcript_entries
        WHERE user_id = ${userId}
        ORDER BY sequence
      `,
      })(subjectUserId)
    ).pipe(
      Effect.map((rows) => rows.map(({ entry }) => entry)),
      Effect.orDie
    )
  );
