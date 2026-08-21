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
    CREATE TABLE hosted_agent_sessions (
      user_id uuid NOT NULL REFERENCES conversation_continuity(user_id) ON DELETE CASCADE,
      id uuid NOT NULL,
      consent_grant_id uuid NOT NULL REFERENCES consent_records(id),
      disclosure_revision text NOT NULL,
      disclosure_sha256 text NOT NULL,
      policy_revision text NOT NULL,
      policy_sha256 text NOT NULL,
      status text NOT NULL CHECK (status IN ('active', 'idle-ended', 'revoked')),
      started_at timestamptz NOT NULL,
      last_terminal_turn_at timestamptz,
      PRIMARY KEY (user_id, id),
      UNIQUE (id),
      CHECK (last_terminal_turn_at IS NULL OR last_terminal_turn_at >= started_at)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX hosted_agent_sessions_one_active_per_user
      ON hosted_agent_sessions (user_id) WHERE status = 'active'
  `;

  yield* sql`
    CREATE TABLE conversation_turns (
      user_id uuid NOT NULL REFERENCES conversation_continuity(user_id) ON DELETE CASCADE,
      session_id uuid NOT NULL,
      id uuid NOT NULL,
      state text NOT NULL CHECK (state IN ('Pending', 'Completed', 'Failed', 'Interrupted')),
      started_at timestamptz NOT NULL,
      terminal_at timestamptz,
      failure_reason text CHECK (
        failure_reason IN ('HostedInferenceFailed', 'HostedInferenceTimedOut', 'DeliveryFailed')
      ),
      PRIMARY KEY (user_id, id),
      FOREIGN KEY (user_id, session_id)
        REFERENCES hosted_agent_sessions(user_id, id) ON DELETE CASCADE,
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

    ALTER TABLE hosted_agent_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE hosted_agent_sessions FORCE ROW LEVEL SECURITY;
    CREATE POLICY hosted_agent_sessions_by_user ON hosted_agent_sessions
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
      conversation_continuity, hosted_agent_sessions, conversation_turns
    TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
