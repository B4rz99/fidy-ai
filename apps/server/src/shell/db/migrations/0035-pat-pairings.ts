import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds digest-only PATPairing state, constrained awaiting-claim PATs, and narrow gateways. */
export const patPairings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE pat_pairings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      public_code text NOT NULL CHECK (
        public_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$'
      ),
      device_code_digest bytea NOT NULL CHECK (octet_length(device_code_digest) = 32),
      recipient_label text NOT NULL CHECK (
        recipient_label = btrim(recipient_label)
        AND char_length(recipient_label) BETWEEN 1 AND 80
      ),
      scopes text[] NOT NULL CHECK (
        cardinality(scopes) BETWEEN 1 AND 3
        AND scopes <@ ARRAY['read', 'write', 'dashboard']::text[]
        AND cardinality(scopes) =
          (CASE WHEN 'read' = ANY(scopes) THEN 1 ELSE 0 END
          + CASE WHEN 'write' = ANY(scopes) THEN 1 ELSE 0 END
          + CASE WHEN 'dashboard' = ANY(scopes) THEN 1 ELSE 0 END)
      ),
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      lifecycle text NOT NULL DEFAULT 'pending_approval' CHECK (lifecycle IN (
        'pending_approval', 'approved_awaiting_claim', 'claimed',
        'expired_unapproved', 'revoked_unclaimed'
      )),
      wrong_proof_attempts smallint NOT NULL DEFAULT 0
        CHECK (wrong_proof_attempts BETWEEN 0 AND 32767),
      minimum_poll_interval_seconds integer NOT NULL DEFAULT 5
        CHECK (minimum_poll_interval_seconds >= 5),
      last_accepted_poll_at timestamptz,
      inspected_at timestamptz,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at = created_at + interval '10 minutes'),
      approved_at timestamptz,
      claimed_at timestamptz,
      expired_at timestamptz,
      revoked_at timestamptz,
      CHECK ((user_id IS NULL) = (inspected_at IS NULL)),
      CHECK (
        lifecycle IN ('pending_approval', 'expired_unapproved')
        OR (lifecycle IN ('approved_awaiting_claim', 'claimed', 'revoked_unclaimed')
          AND user_id IS NOT NULL)
      ),
      CHECK ((lifecycle = 'pending_approval') =
        (approved_at IS NULL AND claimed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL)),
      CHECK ((lifecycle = 'approved_awaiting_claim') =
        (approved_at IS NOT NULL AND claimed_at IS NULL AND expired_at IS NULL AND revoked_at IS NULL)),
      CHECK ((lifecycle = 'claimed') = (approved_at IS NOT NULL AND claimed_at IS NOT NULL)),
      CHECK ((lifecycle = 'expired_unapproved') = (expired_at IS NOT NULL)),
      CHECK ((lifecycle = 'revoked_unclaimed') =
        (approved_at IS NOT NULL AND revoked_at IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX pat_pairings_live_code_idx ON pat_pairings (public_code)
      WHERE lifecycle IN ('pending_approval', 'approved_awaiting_claim')
  `;
  yield* sql`
    CREATE INDEX pat_pairings_due_idx ON pat_pairings (expires_at, id)
      WHERE lifecycle IN ('pending_approval', 'approved_awaiting_claim')
  `;
  yield* sql`
    CREATE TABLE pat_pairing_start_attempts (
      source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
      attempted_at timestamptz NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX pat_pairing_start_attempts_source_time_idx
      ON pat_pairing_start_attempts (source_digest, attempted_at DESC);
    CREATE TABLE pat_pairing_claim_attempts (
      source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
      attempted_at timestamptz NOT NULL
    );
    CREATE INDEX pat_pairing_claim_attempts_source_time_idx
      ON pat_pairing_claim_attempts (source_digest, attempted_at DESC);
    CREATE TABLE pat_pairing_inspection_attempts (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attempted_at timestamptz NOT NULL
    );
    CREATE INDEX pat_pairing_inspection_attempts_user_time_idx
      ON pat_pairing_inspection_attempts (user_id, attempted_at DESC)
  `;

  yield* sql`
    ALTER TABLE tokens ALTER COLUMN token_hash DROP NOT NULL;
    ALTER TABLE tokens ADD COLUMN pat_pairing_id uuid UNIQUE
      REFERENCES pat_pairings(id) ON DELETE SET NULL;
    ALTER TABLE tokens ADD CONSTRAINT tokens_bearer_presence_check CHECK (
      token_hash IS NOT NULL
      OR (pat_pairing_id IS NOT NULL AND last_used_at IS NULL)
      OR (revoked_at IS NOT NULL AND last_used_at IS NULL)
    )
  `;

  yield* sql`
    ALTER TABLE pat_pairings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pat_pairings FORCE ROW LEVEL SECURITY;
    CREATE POLICY pat_pairings_select ON pat_pairings FOR SELECT USING (
      (user_id IS NULL AND lifecycle IN ('pending_approval', 'expired_unapproved'))
      OR user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
    );
    CREATE POLICY pat_pairings_insert ON pat_pairings FOR INSERT WITH CHECK (
      user_id IS NULL AND inspected_at IS NULL AND lifecycle = 'pending_approval'
      AND NULLIF(current_setting('fidy.user_id', true), '') IS NULL
    );
    CREATE POLICY pat_pairings_update ON pat_pairings FOR UPDATE
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
    ALTER TABLE pat_pairing_start_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pat_pairing_start_attempts FORCE ROW LEVEL SECURITY;
    CREATE POLICY pat_pairing_start_attempts_anonymous ON pat_pairing_start_attempts
      USING (NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
      WITH CHECK (NULLIF(current_setting('fidy.user_id', true), '') IS NULL);
    ALTER TABLE pat_pairing_claim_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pat_pairing_claim_attempts FORCE ROW LEVEL SECURITY;
    CREATE POLICY pat_pairing_claim_attempts_anonymous ON pat_pairing_claim_attempts
      USING (NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
      WITH CHECK (NULLIF(current_setting('fidy.user_id', true), '') IS NULL);
    ALTER TABLE pat_pairing_inspection_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pat_pairing_inspection_attempts FORCE ROW LEVEL SECURITY;
    CREATE POLICY pat_pairing_inspection_attempts_user ON pat_pairing_inspection_attempts
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    GRANT SELECT, INSERT, DELETE ON pat_pairing_inspection_attempts TO fidy_gateway;
    GRANT SELECT, INSERT, UPDATE, DELETE ON pat_pairings TO fidy_gateway;
    GRANT SELECT, INSERT, DELETE ON pat_pairing_start_attempts TO fidy_gateway;
    GRANT SELECT, INSERT, DELETE ON pat_pairing_claim_attempts TO fidy_gateway;
    GRANT SELECT, UPDATE ON tokens TO fidy_gateway
  `;

  yield* sql`
    CREATE FUNCTION fidy_live_pat_pairing_count()
    RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      SELECT count(*)::integer FROM public.pat_pairings
      WHERE lifecycle IN ('pending_approval', 'approved_awaiting_claim')
    $function$;

    CREATE FUNCTION fidy_insert_pending_pat_pairing(
      requested_public_code text, requested_device_digest bytea, requested_recipient_label text,
      requested_scopes text[], requested_source_digest bytea, creation_time timestamptz
    ) RETURNS TABLE (
      pairing_id uuid, lock_acquired boolean, burst_count integer, window_count integer,
      burst_retry_after_seconds integer, window_retry_after_seconds integer, live_count integer
    ) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
    BEGIN
      lock_acquired := pg_try_advisory_xact_lock(hashtextextended('pat-pairing-start', 0));
      IF NOT lock_acquired THEN
        burst_count := 0; window_count := 0; burst_retry_after_seconds := 1;
        window_retry_after_seconds := 1; live_count := 10000; pairing_id := NULL;
        RETURN NEXT; RETURN;
      END IF;
      DELETE FROM public.pat_pairing_start_attempts
        WHERE attempted_at <= creation_time - interval '10 minutes';
      UPDATE public.pat_pairings SET lifecycle = 'expired_unapproved', expired_at = creation_time
        WHERE lifecycle = 'pending_approval' AND expires_at <= creation_time;
      SELECT count(*)::integer,
        COALESCE(CEIL(EXTRACT(EPOCH FROM (min(attempted_at) + interval '1 minute' - creation_time)))::integer, 1)
        INTO burst_count, burst_retry_after_seconds
        FROM public.pat_pairing_start_attempts
        WHERE source_digest = requested_source_digest
          AND attempted_at > creation_time - interval '1 minute';
      SELECT count(*)::integer,
        COALESCE(CEIL(EXTRACT(EPOCH FROM (min(attempted_at) + interval '10 minutes' - creation_time)))::integer, 1)
        INTO window_count, window_retry_after_seconds
        FROM public.pat_pairing_start_attempts
        WHERE source_digest = requested_source_digest
          AND attempted_at > creation_time - interval '10 minutes';
      SELECT count(*)::integer INTO live_count FROM public.pat_pairings
        WHERE lifecycle IN ('pending_approval', 'approved_awaiting_claim');
      pairing_id := NULL;
      IF burst_count < 5 AND window_count < 10 AND live_count < 10000 THEN
        INSERT INTO public.pat_pairings (
          public_code, device_code_digest, recipient_label, scopes,
          created_at, expires_at, last_accepted_poll_at
        ) VALUES (
          requested_public_code, requested_device_digest, requested_recipient_label,
          requested_scopes, creation_time, creation_time + interval '10 minutes', creation_time
        ) ON CONFLICT (public_code)
          WHERE lifecycle IN ('pending_approval', 'approved_awaiting_claim') DO NOTHING
        RETURNING id INTO pairing_id;
        IF pairing_id IS NOT NULL THEN
          INSERT INTO public.pat_pairing_start_attempts (source_digest, attempted_at)
          VALUES (requested_source_digest, creation_time);
        END IF;
      END IF;
      RETURN NEXT;
    END
    $function$;

    CREATE FUNCTION fidy_admit_pat_pairing_claim(
      requested_source_digest bytea, attempt_time timestamptz
    ) RETURNS TABLE (burst_count integer, window_count integer, retry_after_seconds integer)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH locked AS (
        SELECT pg_advisory_xact_lock(hashtextextended(encode(requested_source_digest, 'hex'), 249))
      ), recorded AS (
        INSERT INTO public.pat_pairing_claim_attempts (source_digest, attempted_at)
        SELECT requested_source_digest, attempt_time FROM locked RETURNING 1
      ) SELECT
        (SELECT count(*)::int FROM public.pat_pairing_claim_attempts
          WHERE source_digest = requested_source_digest
            AND attempted_at > attempt_time - interval '1 minute') + 1,
        (SELECT count(*)::int FROM public.pat_pairing_claim_attempts
          WHERE source_digest = requested_source_digest
            AND attempted_at > attempt_time - interval '10 minutes') + 1,
        COALESCE((SELECT CEIL(EXTRACT(EPOCH FROM (
          min(attempted_at) + interval '10 minutes' - attempt_time
        )))::int FROM public.pat_pairing_claim_attempts
          WHERE source_digest = requested_source_digest
            AND attempted_at > attempt_time - interval '10 minutes'), 1)
      FROM recorded
    $function$;

    CREATE FUNCTION fidy_purge_pat_pairing_attempt_evidence(purge_time timestamptz)
    RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      DELETE FROM public.pat_pairing_start_attempts
        WHERE attempted_at <= purge_time - interval '10 minutes';
      DELETE FROM public.pat_pairing_claim_attempts
        WHERE attempted_at <= purge_time - interval '10 minutes';
      DELETE FROM public.pat_pairing_inspection_attempts
        WHERE attempted_at <= purge_time - interval '10 minutes'
    $function$;

    CREATE FUNCTION fidy_reserve_pat_pairing_inspection(
      subject_user_id uuid, inspection_time timestamptz
    ) RETURNS TABLE (admitted boolean, retry_after_seconds integer)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
    DECLARE attempt_count integer;
    BEGIN
      IF subject_user_id IS DISTINCT FROM
        NULLIF(current_setting('fidy.user_id', true), '')::uuid THEN
        RAISE EXCEPTION 'PATPairing inspection subject mismatch' USING ERRCODE = '42501';
      END IF;
      PERFORM pg_advisory_xact_lock(
        hashtextextended('pat-pairing-inspection:' || subject_user_id::text, 249)
      );
      DELETE FROM public.pat_pairing_inspection_attempts
      WHERE user_id = subject_user_id
        AND attempted_at <= inspection_time - interval '10 minutes';
      SELECT count(*)::integer,
        COALESCE(CEIL(EXTRACT(EPOCH FROM (
          min(attempted_at) + interval '10 minutes' - inspection_time
        )))::integer, 1)
      INTO attempt_count, retry_after_seconds
      FROM public.pat_pairing_inspection_attempts
      WHERE user_id = subject_user_id
        AND attempted_at > inspection_time - interval '10 minutes';
      admitted := attempt_count < 5;
      IF admitted THEN
        INSERT INTO public.pat_pairing_inspection_attempts (user_id, attempted_at)
        VALUES (subject_user_id, inspection_time);
      END IF;
      RETURN NEXT;
    END
    $function$;

    CREATE FUNCTION fidy_mark_pat_pairing_approved(
      subject_user_id uuid, requested_pairing_id uuid, approval_time timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH changed AS (
        UPDATE public.pat_pairings
        SET lifecycle = 'approved_awaiting_claim', approved_at = approval_time
        WHERE id = requested_pairing_id AND user_id = subject_user_id
          AND subject_user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
          AND lifecycle = 'pending_approval' AND inspected_at IS NOT NULL
        RETURNING 1
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$;

    CREATE FUNCTION fidy_lock_pat_pairing_approval(
      subject_user_id uuid, requested_pairing_id uuid, attempt_time timestamptz
    ) RETURNS TABLE (
      pairing_id uuid, recipient_label text, scopes text[], claim_by timestamptz,
      inspected_at timestamptz
    ) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      SELECT id, recipient_label, scopes, expires_at, inspected_at
      FROM public.pat_pairings
      WHERE id = requested_pairing_id AND user_id = subject_user_id
        AND subject_user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
        AND lifecycle = 'pending_approval' AND expires_at > attempt_time
      FOR UPDATE
    $function$;

    CREATE FUNCTION fidy_bind_pat_pairing_review(
      subject_user_id uuid, requested_public_code text, inspection_time timestamptz
    ) RETURNS TABLE (
      pairing_id uuid, recipient_label text, scopes text[], claim_by timestamptz,
      inspected_at timestamptz
    ) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH candidate AS MATERIALIZED (
        SELECT id FROM public.pat_pairings
        WHERE public_code = requested_public_code AND lifecycle = 'pending_approval'
          AND expires_at > inspection_time AND (user_id IS NULL OR user_id = subject_user_id)
          AND subject_user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
        FOR UPDATE
      ), bound AS (
        UPDATE public.pat_pairings AS pairing
        SET user_id = subject_user_id,
          inspected_at = COALESCE(pairing.inspected_at, inspection_time)
        FROM candidate WHERE pairing.id = candidate.id
        RETURNING pairing.id, pairing.recipient_label, pairing.scopes, pairing.expires_at,
          pairing.inspected_at
      ) SELECT id, recipient_label, scopes, expires_at, inspected_at FROM bound
    $function$;

    CREATE FUNCTION fidy_lock_pat_pairing(requested_pairing_id uuid)
    RETURNS TABLE (
      pairing_id uuid,
      user_id uuid,
      inspected_at timestamptz,
      device_code_digest bytea,
      lifecycle text,
      wrong_proof_attempts integer,
      minimum_poll_interval_seconds integer,
      last_accepted_poll_at timestamptz,
      pairing_expires_at timestamptz,
      token_id uuid,
      short_id text,
      recipient_label text,
      scopes text[],
      lifetime_days integer,
      pat_expires_at timestamptz,
      token_created_at timestamptz
    )
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      SELECT pairing.id, pairing.user_id, pairing.inspected_at,
        pairing.device_code_digest, pairing.lifecycle,
        pairing.wrong_proof_attempts::integer, pairing.minimum_poll_interval_seconds,
        pairing.last_accepted_poll_at, pairing.expires_at,
        token.id, token.short_id, pairing.recipient_label, pairing.scopes,
        token.lifetime_days, token.expires_at, token.created_at
      FROM public.pat_pairings AS pairing
      LEFT JOIN public.tokens AS token ON token.pat_pairing_id = pairing.id
      WHERE pairing.id = requested_pairing_id
      FOR UPDATE OF pairing
    $function$;

    CREATE FUNCTION fidy_accept_pat_pairing_poll(requested_pairing_id uuid, accepted_at timestamptz)
    RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH changed AS (
        UPDATE public.pat_pairings SET last_accepted_poll_at = accepted_at
        WHERE id = requested_pairing_id AND lifecycle = 'pending_approval'
        RETURNING 1
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$;

    CREATE FUNCTION fidy_slow_pat_pairing_poll(requested_pairing_id uuid, interval_seconds integer)
    RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH changed AS (
        UPDATE public.pat_pairings
        SET minimum_poll_interval_seconds = interval_seconds
        WHERE id = requested_pairing_id
          AND lifecycle IN ('pending_approval', 'approved_awaiting_claim')
        RETURNING 1
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$;

    CREATE FUNCTION fidy_reject_pat_pairing_proof(requested_pairing_id uuid, attempts integer)
    RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH changed AS (
        UPDATE public.pat_pairings SET wrong_proof_attempts = attempts
        WHERE id = requested_pairing_id
          AND lifecycle IN ('pending_approval', 'approved_awaiting_claim')
        RETURNING 1
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$;

    CREATE FUNCTION fidy_expire_unapproved_pat_pairing(
      requested_pairing_id uuid, expiry_time timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH changed AS (
        UPDATE public.pat_pairings
        SET lifecycle = 'expired_unapproved', expired_at = expiry_time
        WHERE id = requested_pairing_id AND lifecycle = 'pending_approval'
        RETURNING 1
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$;

    CREATE FUNCTION fidy_claim_pat_pairing(
      requested_pairing_id uuid, claimed_token_hash text, claim_time timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH pairing AS MATERIALIZED (
        SELECT id FROM public.pat_pairings
        WHERE id = requested_pairing_id
          AND lifecycle = 'approved_awaiting_claim' AND expires_at > claim_time
        FOR UPDATE
      ), issued AS (
        UPDATE public.tokens AS token SET token_hash = claimed_token_hash
        FROM pairing
        WHERE token.pat_pairing_id = pairing.id AND token.token_hash IS NULL
          AND token.revoked_at IS NULL
        RETURNING token.pat_pairing_id
      ), consumed AS (
        UPDATE public.pat_pairings AS target
        SET lifecycle = 'claimed', claimed_at = claim_time
        FROM issued WHERE target.id = issued.pat_pairing_id
        RETURNING 1
      ) SELECT EXISTS (SELECT 1 FROM consumed)
    $function$;

    CREATE FUNCTION fidy_expire_unapproved_pat_pairings(expiry_time timestamptz)
    RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH changed AS (
        UPDATE public.pat_pairings
        SET lifecycle = 'expired_unapproved', expired_at = expiry_time
        WHERE lifecycle = 'pending_approval' AND expires_at <= expiry_time
        RETURNING 1
      ) SELECT count(*)::integer FROM changed
    $function$;

    CREATE FUNCTION fidy_purge_terminal_pat_pairings(retention_before timestamptz)
    RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH removed AS (
        DELETE FROM public.pat_pairings
        WHERE (lifecycle = 'expired_unapproved' AND expired_at < retention_before)
          OR (lifecycle = 'claimed' AND claimed_at < retention_before)
          OR (lifecycle = 'revoked_unclaimed' AND revoked_at < retention_before)
        RETURNING 1
      ) SELECT count(*)::integer FROM removed
    $function$;

    CREATE FUNCTION fidy_due_approved_pat_pairings(expiry_time timestamptz, batch_size integer)
    RETURNS TABLE (pairing_id uuid, subject_user_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      SELECT id, user_id FROM public.pat_pairings
      WHERE lifecycle = 'approved_awaiting_claim' AND expires_at <= expiry_time
      ORDER BY expires_at, id LIMIT batch_size
    $function$;

    CREATE FUNCTION fidy_lock_due_approved_pat_pairing(
      subject_user_id uuid, requested_pairing_id uuid, attempt_time timestamptz
    ) RETURNS TABLE (pairing_id uuid, token_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      SELECT pairing.id, token.id
      FROM public.pat_pairings AS pairing
      JOIN public.tokens AS token ON token.pat_pairing_id = pairing.id
      WHERE pairing.id = requested_pairing_id AND pairing.user_id = subject_user_id
        AND subject_user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
        AND pairing.lifecycle = 'approved_awaiting_claim'
        AND pairing.expires_at <= attempt_time
        AND token.token_hash IS NULL AND token.revoked_at IS NULL
      FOR UPDATE OF pairing SKIP LOCKED
    $function$;

    CREATE FUNCTION fidy_revoke_unclaimed_pat_pairing(
      subject_user_id uuid, requested_pairing_id uuid, revocation_time timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
      WITH changed AS (
        UPDATE public.pat_pairings SET lifecycle = 'revoked_unclaimed', revoked_at = revocation_time
        WHERE id = requested_pairing_id AND user_id = subject_user_id
          AND subject_user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
          AND lifecycle = 'approved_awaiting_claim' AND expires_at <= revocation_time
        RETURNING 1
      ) SELECT EXISTS (SELECT 1 FROM changed)
    $function$
  `;

  yield* sql`
    ALTER FUNCTION fidy_live_pat_pairing_count() OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_insert_pending_pat_pairing(text, bytea, text, text[], bytea, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_admit_pat_pairing_claim(bytea, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_purge_pat_pairing_attempt_evidence(timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_reserve_pat_pairing_inspection(uuid, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_mark_pat_pairing_approved(uuid, uuid, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_lock_pat_pairing_approval(uuid, uuid, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_bind_pat_pairing_review(uuid, text, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_lock_pat_pairing(uuid) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_accept_pat_pairing_poll(uuid, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_slow_pat_pairing_poll(uuid, integer) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_reject_pat_pairing_proof(uuid, integer) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_expire_unapproved_pat_pairing(uuid, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_claim_pat_pairing(uuid, text, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_expire_unapproved_pat_pairings(timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_purge_terminal_pat_pairings(timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_due_approved_pat_pairings(timestamptz, integer) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_lock_due_approved_pat_pairing(uuid, uuid, timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_revoke_unclaimed_pat_pairing(uuid, uuid, timestamptz) OWNER TO fidy_gateway;

    REVOKE ALL ON FUNCTION fidy_live_pat_pairing_count() FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_insert_pending_pat_pairing(text, bytea, text, text[], bytea, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_admit_pat_pairing_claim(bytea, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_purge_pat_pairing_attempt_evidence(timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_reserve_pat_pairing_inspection(uuid, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_mark_pat_pairing_approved(uuid, uuid, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_lock_pat_pairing_approval(uuid, uuid, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_bind_pat_pairing_review(uuid, text, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_lock_pat_pairing(uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_accept_pat_pairing_poll(uuid, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_slow_pat_pairing_poll(uuid, integer) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_reject_pat_pairing_proof(uuid, integer) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_expire_unapproved_pat_pairing(uuid, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_claim_pat_pairing(uuid, text, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_expire_unapproved_pat_pairings(timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_purge_terminal_pat_pairings(timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_due_approved_pat_pairings(timestamptz, integer) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_lock_due_approved_pat_pairing(uuid, uuid, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_revoke_unclaimed_pat_pairing(uuid, uuid, timestamptz) FROM PUBLIC;

    GRANT EXECUTE ON FUNCTION fidy_live_pat_pairing_count() TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_insert_pending_pat_pairing(text, bytea, text, text[], bytea, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_admit_pat_pairing_claim(bytea, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_purge_pat_pairing_attempt_evidence(timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_reserve_pat_pairing_inspection(uuid, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_mark_pat_pairing_approved(uuid, uuid, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_lock_pat_pairing_approval(uuid, uuid, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_bind_pat_pairing_review(uuid, text, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_lock_pat_pairing(uuid) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_accept_pat_pairing_poll(uuid, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_slow_pat_pairing_poll(uuid, integer) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_reject_pat_pairing_proof(uuid, integer) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_expire_unapproved_pat_pairing(uuid, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_claim_pat_pairing(uuid, text, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_expire_unapproved_pat_pairings(timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_purge_terminal_pat_pairings(timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_due_approved_pat_pairings(timestamptz, integer) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_lock_due_approved_pat_pairing(uuid, uuid, timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_revoke_unclaimed_pat_pairing(uuid, uuid, timestamptz) TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
