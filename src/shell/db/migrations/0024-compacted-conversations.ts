import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds the User-keyed bounded conversation replacement and its exact incorporated-entry cursor. */
export const compactedConversations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE compacted_conversations (
      user_id uuid PRIMARY KEY REFERENCES conversation_continuity(user_id) ON DELETE CASCADE,
      text text NOT NULL CHECK (char_length(text) > 0),
      through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
      revision bigint NOT NULL CHECK (revision > 0),
      updated_at timestamptz NOT NULL
    )
  `;

  yield* sql`
    ALTER TABLE compacted_conversations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE compacted_conversations FORCE ROW LEVEL SECURITY;
    CREATE POLICY compacted_conversations_by_user ON compacted_conversations
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;

  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON compacted_conversations TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
