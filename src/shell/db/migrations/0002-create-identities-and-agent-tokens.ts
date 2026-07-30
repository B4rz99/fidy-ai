import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// Stable Users and their concrete WhatsApp and AgentToken associations arrive
// together: neither a phone number nor a bearer hash is itself the User. The
// market, locale, and time zone stay in separate columns so no one can be
// reconstructed from another.
export const createIdentitiesAndAgentTokens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      service_market text NOT NULL CHECK (service_market = 'CO'),
      locale text NOT NULL CHECK (locale = 'es-CO'),
      time_zone text NOT NULL,
      created_at timestamptz NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE whatsapp_identities (
      phone_number text PRIMARY KEY CHECK (phone_number ~ '^\\+[1-9][0-9]{7,14}$'),
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      verified_at timestamptz NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE agent_tokens (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      short_id text NOT NULL UNIQUE CHECK (short_id ~ '^[a-z0-9]{8}$'),
      token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      scopes text[] NOT NULL CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['read', 'write', 'dashboard']::text[]
      ),
      last_used_at timestamptz,
      idle_expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL,
      CHECK (last_used_at IS NULL OR last_used_at >= created_at),
      CHECK (
        idle_expires_at = COALESCE(last_used_at, created_at) + INTERVAL '2160 hours'
      ),
      CHECK (revoked_at IS NULL OR revoked_at >= created_at),
      CHECK (revoked_at IS NULL OR last_used_at IS NULL OR revoked_at >= last_used_at)
    )
  `;

  yield* sql`
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  `;
}).pipe(Effect.asVoid);
