import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { TranscriptEntry, TranscriptEntryId, TranscriptTurnId } from "~/core/transcript/model";

const PersistedTranscriptEntry = Schema.fromJsonString(Schema.toCodecJson(TranscriptEntry));
const TranscriptEntryRow = Schema.Struct({ entry: PersistedTranscriptEntry });
const RecentTranscriptRequest = Schema.Struct({
  subjectUserId: UserId,
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
  entry: PersistedTranscriptEntry,
});

const appendOne = Effect.fn("appendTranscriptEntry")(function* (
  subjectUserId: UserId,
  entry: TranscriptEntry
) {
  const sql = yield* SqlClient.SqlClient;
  yield* withUserTransaction(
    subjectUserId,
    SqlSchema.findOne({
      Request: OwnedTranscriptEntryRow,
      Result: Schema.Struct({ entryId: TranscriptEntryId }),
      execute: (row) => sql`
      INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
      VALUES (${row.subjectUserId}, ${row.entryId}, ${row.turnId}, ${row.entry}::jsonb)
      RETURNING entry_id AS "entryId"
    `,
    })({ subjectUserId, entryId: entry.id, turnId: entry.turnId, entry }).pipe(Effect.orDie)
  );
});

/**
 * Appends entries in their supplied order for one explicit User. The database
 * sequence is authoritative across turns; callers cannot overwrite or reorder
 * retained conversation history.
 */
export const appendTranscriptEntries = Effect.fn("appendTranscriptEntries")(function* (
  subjectUserId: UserId,
  entries: ReadonlyArray<TranscriptEntry>
) {
  yield* Effect.forEach(entries, (entry) => appendOne(subjectUserId, entry), {
    concurrency: 1,
    discard: true,
  });
});

/** Reads only the newest bounded complete turns for model-context selection. */
export const listRecentTranscriptEntries = Effect.fn("listRecentTranscriptEntries")(function* (
  subjectUserId: UserId,
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
          SELECT turn_id, max(sequence) AS newest_sequence
          FROM transcript_entries
          WHERE user_id = ${request.subjectUserId}
          GROUP BY turn_id
          HAVING (array_agg(entry->>'_tag' ORDER BY sequence DESC))[1] = 'AssistantTranscriptEntry'
          ORDER BY newest_sequence DESC
          LIMIT ${request.maxTurns}
        )
        SELECT transcript.entry::text AS entry
        FROM transcript_entries AS transcript
        INNER JOIN recent_turns USING (turn_id)
        WHERE transcript.user_id = ${request.subjectUserId}
        ORDER BY transcript.sequence
      `,
    })({ subjectUserId, maxTurns }).pipe(Effect.orDie)
  );
  return rows.map(({ entry }) => entry);
});

/** Reads one explicit turn, including an in-progress turn, in append order. */
export const listTranscriptTurnEntries = Effect.fn("listTranscriptTurnEntries")(function* (
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
      SELECT entry::text AS entry
      FROM transcript_entries
      WHERE user_id = ${request.subjectUserId} AND turn_id = ${request.turnId}
      ORDER BY sequence
    `,
    })({ subjectUserId, turnId }).pipe(Effect.orDie)
  );
  return rows.map(({ entry }) => entry);
});

/** Reads one User's complete Transcript in append order, decoding every JSONB row. */
export const listTranscriptEntries = (
  subjectUserId: UserId
): Effect.Effect<ReadonlyArray<TranscriptEntry>, never, SqlClient.SqlClient> =>
  withUserTransaction(
    subjectUserId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findAll({
        Request: UserId,
        Result: TranscriptEntryRow,
        execute: (userId) => sql`
        SELECT entry::text AS entry
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
