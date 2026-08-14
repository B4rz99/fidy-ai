import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Creates current Memory storage with explicit User ownership, forced RLS, and stable recall order. */
export const createMemories = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE memories (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id uuid NOT NULL,
      text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (user_id, id),
      CHECK (updated_at >= created_at)
    )
  `;
  yield* sql`CREATE INDEX memories_user_recall ON memories (user_id, created_at, id)`;
  yield* sql`
    ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
    ALTER TABLE memories FORCE ROW LEVEL SECURITY;
    CREATE POLICY memories_by_user ON memories
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`GRANT SELECT, INSERT ON memories TO fidy_runtime`;
}).pipe(Effect.asVoid);
