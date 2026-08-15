import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Persists the atomic single-use boundary for hosted-agent confirmation challenges. */
export const agentConfirmationConsumptions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE agent_confirmation_consumptions (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      digest text NOT NULL,
      consumed_at timestamptz NOT NULL,
      PRIMARY KEY (user_id, digest),
      CONSTRAINT agent_confirmation_digest CHECK (digest ~ '^[0-9a-f]{64}$')
    )
  `;
  yield* sql`
    ALTER TABLE agent_confirmation_consumptions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agent_confirmation_consumptions FORCE ROW LEVEL SECURITY;
    CREATE POLICY agent_confirmation_consumptions_by_user ON agent_confirmation_consumptions
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_confirmation_consumptions TO fidy_runtime
  `;
});
