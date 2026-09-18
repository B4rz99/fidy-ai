import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Creates the User-owned append-only store for exact channel-neutral Transcripts. */
export const createTranscripts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE transcript_entries (
      sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id uuid NOT NULL UNIQUE,
      turn_id uuid NOT NULL,
      entry jsonb NOT NULL,
      CONSTRAINT transcript_entry_object CHECK (jsonb_typeof(entry) = 'object'),
      CONSTRAINT transcript_entry_id_matches CHECK (entry ->> 'id' = entry_id::text),
      CONSTRAINT transcript_turn_id_matches CHECK (entry ->> 'turnId' = turn_id::text)
    )
  `;

  yield* sql`
    CREATE INDEX transcript_entries_user_sequence_idx
    ON transcript_entries (user_id, sequence)
  `;
});
