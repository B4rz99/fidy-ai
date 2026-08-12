import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Adds empty durable continuity for existing Users without inferring historical Turns.
 * Requires the User schema and runtime role; creates lifecycle storage with forced User isolation,
 * and fails on SQL or authorization errors.
 */
export const conversationContinuity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE conversation_continuity (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
    )
  `;

  yield* sql`
    CREATE TABLE conversation_turns (
      user_id uuid NOT NULL REFERENCES conversation_continuity(user_id) ON DELETE CASCADE,
      id uuid NOT NULL,
      state text NOT NULL CHECK (state IN ('Pending', 'Completed', 'Failed', 'Interrupted')),
      started_at timestamptz NOT NULL,
      terminal_at timestamptz,
      failure_reason text CHECK (
        failure_reason IN ('HostedInferenceFailed', 'HostedInferenceTimedOut', 'DeliveryFailed')
      ),
      PRIMARY KEY (user_id, id),
      CHECK (terminal_at IS NULL OR terminal_at >= started_at),
      CHECK (
        (state = 'Pending' AND terminal_at IS NULL AND failure_reason IS NULL)
        OR (state IN ('Completed', 'Interrupted') AND terminal_at IS NOT NULL AND failure_reason IS NULL)
        OR (state = 'Failed' AND terminal_at IS NOT NULL AND failure_reason IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX conversation_turns_user_state_started
      ON conversation_turns (user_id, state, started_at, id)
  `;

  yield* sql`
    ALTER TABLE conversation_continuity ENABLE ROW LEVEL SECURITY;
    ALTER TABLE conversation_continuity FORCE ROW LEVEL SECURITY;
    CREATE POLICY conversation_continuity_by_user ON conversation_continuity
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

    ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
    ALTER TABLE conversation_turns FORCE ROW LEVEL SECURITY;
    CREATE POLICY conversation_turns_by_user ON conversation_turns
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

  `;

  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      conversation_continuity, conversation_turns
    TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
