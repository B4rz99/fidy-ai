import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Completes browser pairing redemption and creates digest-only browser WebSessions. */
export const webSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE browser_login_pairings
      ADD COLUMN minimum_poll_interval_seconds integer NOT NULL DEFAULT 5
        CHECK (minimum_poll_interval_seconds >= 5
          AND minimum_poll_interval_seconds % 5 = 0),
      ADD COLUMN last_accepted_poll_at timestamptz;

    ALTER TABLE browser_login_pairings
      DROP CONSTRAINT IF EXISTS browser_login_pairings_check,
      DROP CONSTRAINT IF EXISTS browser_login_pairings_check1;
    ALTER TABLE browser_login_pairings
      ADD CONSTRAINT browser_login_pairings_subject_lifecycle_check CHECK (
        (lifecycle = 'pending_approval' AND user_id IS NULL AND approved_at IS NULL)
        OR (lifecycle IN ('ready', 'superseded', 'consumed')
          AND user_id IS NOT NULL AND approved_at IS NOT NULL)
        OR (lifecycle IN ('expired', 'invalidated')
          AND ((user_id IS NULL AND approved_at IS NULL)
            OR (user_id IS NOT NULL AND approved_at IS NOT NULL)))
      )
  `;

  yield* sql`
    CREATE TABLE web_sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bearer_digest bytea NOT NULL UNIQUE CHECK (octet_length(bearer_digest) = 32),
      paired_at timestamptz NOT NULL,
      fresh_until timestamptz NOT NULL
        CHECK (fresh_until = paired_at + interval '10 minutes'),
      idle_expires_at timestamptz NOT NULL
        CHECK (idle_expires_at = paired_at + interval '30 days'),
      hard_expires_at timestamptz NOT NULL
        CHECK (hard_expires_at = paired_at + interval '90 days'),
      last_used_at timestamptz,
      revoked_at timestamptz,
      CHECK (idle_expires_at <= hard_expires_at),
      CHECK (last_used_at IS NULL OR last_used_at >= paired_at),
      CHECK (revoked_at IS NULL OR revoked_at >= paired_at)
    );
    CREATE INDEX web_sessions_user_active_idx
      ON web_sessions (user_id, idle_expires_at) WHERE revoked_at IS NULL;

    ALTER TABLE web_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE web_sessions FORCE ROW LEVEL SECURITY;
    CREATE POLICY web_sessions_by_user ON web_sessions
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;

  yield* sql`
    GRANT SELECT, INSERT, UPDATE ON web_sessions TO fidy_gateway;
    GRANT SELECT, INSERT, UPDATE ON browser_login_pairings TO fidy_gateway
  `;

  yield* sql`
    CREATE FUNCTION fidy_lock_browser_login_pairing(requested_pairing_id uuid)
    RETURNS TABLE (
      pairing_id uuid,
      user_id uuid,
      verifier_digest bytea,
      lifecycle text,
      wrong_verifier_attempts integer,
      minimum_poll_interval_seconds integer,
      last_accepted_poll_at timestamptz,
      expires_at timestamptz
    )
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT pairing.id, pairing.user_id, pairing.verifier_digest, pairing.lifecycle,
        pairing.wrong_verifier_attempts::integer, pairing.minimum_poll_interval_seconds,
        pairing.last_accepted_poll_at, pairing.expires_at
      FROM public.browser_login_pairings AS pairing
      WHERE pairing.id = requested_pairing_id
      FOR UPDATE
    $function$;

    CREATE FUNCTION fidy_accept_browser_login_poll(
      requested_pairing_id uuid, accepted_at timestamptz
    ) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH changed AS (
        UPDATE public.browser_login_pairings
        SET last_accepted_poll_at = accepted_at
        WHERE id = requested_pairing_id AND lifecycle = 'pending_approval'
          AND expires_at > accepted_at
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$;

    CREATE FUNCTION fidy_slow_browser_login_poll(
      requested_pairing_id uuid, next_minimum_seconds integer
    ) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH changed AS (
        UPDATE public.browser_login_pairings
        SET minimum_poll_interval_seconds = next_minimum_seconds
        WHERE id = requested_pairing_id AND lifecycle IN ('pending_approval', 'ready')
          AND next_minimum_seconds = minimum_poll_interval_seconds + 5
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$;

    CREATE FUNCTION fidy_reject_browser_login_verifier(
      requested_pairing_id uuid,
      requested_attempts integer,
      requested_lifecycle text,
      rejected_at timestamptz
    ) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH changed AS (
        UPDATE public.browser_login_pairings
        SET wrong_verifier_attempts = requested_attempts,
          lifecycle = requested_lifecycle,
          invalidated_at = CASE WHEN requested_lifecycle = 'invalidated'
            THEN rejected_at ELSE invalidated_at END
        WHERE id = requested_pairing_id
          AND lifecycle IN ('pending_approval', 'ready')
          AND expires_at > rejected_at
          AND requested_attempts = wrong_verifier_attempts + 1
          AND requested_attempts BETWEEN 1 AND 5
          AND requested_lifecycle IN (lifecycle, 'invalidated')
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$;

    CREATE FUNCTION fidy_expire_browser_login_pairing(
      requested_pairing_id uuid, transitioned_at timestamptz
    ) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH changed AS (
        UPDATE public.browser_login_pairings
        SET lifecycle = 'expired', expired_at = transitioned_at
        WHERE id = requested_pairing_id
          AND lifecycle IN ('pending_approval', 'ready')
          AND expires_at <= transitioned_at
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$;

    CREATE FUNCTION fidy_redeem_pairing_to_web_session(
      requested_pairing_id uuid,
      requested_session_id uuid,
      requested_bearer_digest bytea,
      redeemed_at timestamptz,
      requested_fresh_until timestamptz,
      requested_idle_expires_at timestamptz,
      requested_hard_expires_at timestamptz
    ) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH consumed AS (
        UPDATE public.browser_login_pairings
        SET lifecycle = 'consumed', consumed_at = redeemed_at
        WHERE id = requested_pairing_id AND lifecycle = 'ready' AND expires_at > redeemed_at
        RETURNING user_id
      ), inserted AS (
        INSERT INTO public.web_sessions (
          id, user_id, bearer_digest, paired_at, fresh_until,
          idle_expires_at, hard_expires_at
        )
        SELECT requested_session_id, consumed.user_id, requested_bearer_digest, redeemed_at,
          requested_fresh_until, requested_idle_expires_at, requested_hard_expires_at
        FROM consumed
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM inserted)
    $function$;

    CREATE FUNCTION fidy_revoke_web_session(
      requested_bearer_digest bytea, revocation_time timestamptz
    ) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH changed AS (
        UPDATE public.web_sessions SET revoked_at = revocation_time
        WHERE bearer_digest = requested_bearer_digest AND web_sessions.revoked_at IS NULL
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$
  `;

  yield* sql`
    ALTER FUNCTION fidy_lock_browser_login_pairing(uuid) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_accept_browser_login_poll(uuid, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_slow_browser_login_poll(uuid, integer) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_reject_browser_login_verifier(uuid, integer, text, timestamptz)
      OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_expire_browser_login_pairing(uuid, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_redeem_pairing_to_web_session(
      uuid, uuid, bytea, timestamptz, timestamptz, timestamptz, timestamptz
    ) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_revoke_web_session(bytea, timestamptz) OWNER TO fidy_gateway;

    REVOKE ALL ON FUNCTION fidy_lock_browser_login_pairing(uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_accept_browser_login_poll(uuid, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_slow_browser_login_poll(uuid, integer) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_reject_browser_login_verifier(
      uuid, integer, text, timestamptz
    ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_expire_browser_login_pairing(uuid, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_redeem_pairing_to_web_session(
      uuid, uuid, bytea, timestamptz, timestamptz, timestamptz, timestamptz
    ) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_revoke_web_session(bytea, timestamptz) FROM PUBLIC;

    GRANT EXECUTE ON FUNCTION fidy_lock_browser_login_pairing(uuid) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_accept_browser_login_poll(uuid, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_slow_browser_login_poll(uuid, integer) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_reject_browser_login_verifier(
      uuid, integer, text, timestamptz
    ) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_expire_browser_login_pairing(uuid, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_redeem_pairing_to_web_session(
      uuid, uuid, bytea, timestamptz, timestamptz, timestamptz, timestamptz
    ) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_revoke_web_session(bytea, timestamptz) TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
