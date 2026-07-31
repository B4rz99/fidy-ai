import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds the internal hard-expiring AgentToken variant used by hosted turns. */
export const hostedAgentTokens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE agent_tokens
      ADD COLUMN kind text NOT NULL DEFAULT 'user'
        CHECK (kind IN ('user', 'hosted')),
      ADD COLUMN expires_at timestamptz,
      ADD CONSTRAINT agent_tokens_kind_lifetime_check CHECK (
        (kind = 'user' AND expires_at IS NULL)
        OR
        (kind = 'hosted' AND expires_at IS NOT NULL AND expires_at > created_at)
      ),
      ADD CONSTRAINT hosted_agent_tokens_all_scopes_check CHECK (
        kind <> 'hosted'
        OR scopes @> ARRAY['read', 'write', 'dashboard']::text[]
      )
  `;

  yield* sql`
    CREATE INDEX agent_tokens_hosted_expiry_idx
    ON agent_tokens (expires_at)
    WHERE kind = 'hosted' AND revoked_at IS NULL
  `;
});
