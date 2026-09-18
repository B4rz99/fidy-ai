import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Creates browser-first login challenges and their bounded admission evidence. */
export const browserLoginPairings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE browser_login_pairings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      public_code text NOT NULL CHECK (
        public_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$'
      ),
      verifier_digest bytea NOT NULL CHECK (octet_length(verifier_digest) = 32),
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      lifecycle text NOT NULL DEFAULT 'pending_approval'
        CHECK (lifecycle IN (
          'pending_approval', 'ready', 'expired', 'superseded', 'consumed', 'invalidated'
        )),
      wrong_verifier_attempts smallint NOT NULL DEFAULT 0
        CHECK (wrong_verifier_attempts BETWEEN 0 AND 5),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at = created_at + interval '10 minutes'),
      approved_at timestamptz,
      expired_at timestamptz,
      superseded_at timestamptz,
      replacement_id uuid REFERENCES browser_login_pairings(id) ON DELETE RESTRICT,
      consumed_at timestamptz,
      invalidated_at timestamptz,
      CHECK ((lifecycle IN ('pending_approval', 'expired') AND user_id IS NULL
          AND approved_at IS NULL)
        OR (lifecycle NOT IN ('pending_approval', 'expired') AND user_id IS NOT NULL)),
      CHECK ((lifecycle = 'expired') = (expired_at IS NOT NULL)),
      CHECK ((lifecycle = 'ready') = (approved_at IS NOT NULL AND superseded_at IS NULL
        AND expired_at IS NULL AND consumed_at IS NULL AND invalidated_at IS NULL)),
      CHECK ((lifecycle = 'superseded') = (superseded_at IS NOT NULL AND replacement_id IS NOT NULL)),
      CHECK ((lifecycle = 'consumed') = (consumed_at IS NOT NULL)),
      CHECK ((lifecycle = 'invalidated') = (invalidated_at IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX browser_login_pairings_live_code_idx
      ON browser_login_pairings (public_code)
      WHERE lifecycle IN ('pending_approval', 'ready')
  `;
  yield* sql`
    CREATE UNIQUE INDEX browser_login_pairings_one_ready_per_user_idx
      ON browser_login_pairings (user_id) WHERE lifecycle = 'ready'
  `;
  yield* sql`
    CREATE INDEX browser_login_pairings_live_unbound_idx
      ON browser_login_pairings (expires_at, id) WHERE lifecycle = 'pending_approval'
  `;

  yield* sql`
    CREATE TABLE browser_login_start_attempts (
      source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
      attempted_at timestamptz NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX browser_login_start_attempts_source_time_idx
      ON browser_login_start_attempts (source_digest, attempted_at DESC)
  `;

  yield* sql`
    ALTER TABLE browser_login_pairings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE browser_login_pairings FORCE ROW LEVEL SECURITY;
    CREATE POLICY browser_login_pairings_unbound ON browser_login_pairings
      USING (user_id IS NULL AND NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
      WITH CHECK (user_id IS NULL AND lifecycle IN ('pending_approval', 'expired')
        AND NULLIF(current_setting('fidy.user_id', true), '') IS NULL);
    CREATE POLICY browser_login_pairings_approval ON browser_login_pairings
      USING (
        (user_id IS NULL AND lifecycle = 'pending_approval'
          AND NULLIF(current_setting('fidy.user_id', true), '') IS NOT NULL)
        OR user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      )
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE browser_login_start_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE browser_login_start_attempts FORCE ROW LEVEL SECURITY;
    CREATE POLICY browser_login_start_attempts_anonymous ON browser_login_start_attempts
      USING (NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
      WITH CHECK (NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
  `;
  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON browser_login_pairings TO fidy_runtime;
    GRANT SELECT, INSERT, DELETE ON browser_login_start_attempts TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
