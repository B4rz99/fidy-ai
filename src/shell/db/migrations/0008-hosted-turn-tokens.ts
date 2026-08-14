import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds the internal hard-expiring HostedTurnToken variant used by hosted Turns. */
export const hostedTurnTokens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE tokens
      ADD COLUMN kind text NOT NULL DEFAULT 'pat'
        CHECK (kind IN ('pat', 'hosted-turn')),
      ADD COLUMN expires_at timestamptz,
      ADD CONSTRAINT tokens_kind_lifetime_check CHECK (
        (kind = 'pat' AND expires_at IS NULL)
        OR
        (kind = 'hosted-turn' AND expires_at IS NOT NULL AND expires_at > created_at)
      ),
      ADD CONSTRAINT hosted_turn_tokens_all_scopes_check CHECK (
        kind <> 'hosted-turn'
        OR scopes @> ARRAY['read', 'write', 'dashboard']::text[]
      )
  `;

  yield* sql`
    CREATE INDEX tokens_hosted_turn_expiry_idx
    ON tokens (expires_at)
    WHERE kind = 'hosted-turn' AND revoked_at IS NULL
  `;
});
