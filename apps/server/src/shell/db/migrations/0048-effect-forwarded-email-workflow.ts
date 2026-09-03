import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Replaces forwarded-email claims and polling state with identifier-only durable workflows. */
export const effectForwardedEmailWorkflow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM forwarded_email_receipts
        WHERE status IN ('queued', 'deferred', 'processing')
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'settle active forwarded-email receipts before durable workflow migration';
      END IF;
    END
    $migration$
  `;

  yield* sql`DROP FUNCTION fidy_forwarded_email_claim_candidates(timestamptz, timestamptz)`;
  yield* sql`DROP FUNCTION fidy_claim_forwarded_email(text, boolean, timestamptz, boolean)`;
  yield* sql`DROP FUNCTION fidy_exhaust_stale_forwarded_email(text, timestamptz, timestamptz)`;
  yield* sql`DROP INDEX forwarded_email_receipts_claim_idx`;
  yield* sql`ALTER TABLE forwarded_email_receipts DROP CONSTRAINT forwarded_email_receipts_check`;
  yield* sql`ALTER TABLE forwarded_email_receipts DROP CONSTRAINT forwarded_email_receipts_status_check`;
  yield* sql`
    ALTER TABLE forwarded_email_receipts
      DROP COLUMN claim_id,
      DROP COLUMN attempt_count,
      DROP COLUMN started_at,
      ADD COLUMN durable_cleanup_checked_at timestamptz,
      ADD COLUMN durable_cleanup_started_at timestamptz,
      ADD COLUMN durable_cleanup_cleared_at timestamptz,
      ADD CONSTRAINT forwarded_email_receipts_status_check
        CHECK (status IN ('accepted', 'deferred', 'completed', 'revoked', 'expired')),
      ADD CONSTRAINT forwarded_email_receipts_state_check CHECK (
        (status = 'accepted' AND resume_at IS NULL AND completed_at IS NULL)
        OR (status = 'deferred' AND resume_at IS NOT NULL AND completed_at IS NULL)
        OR (status = 'completed' AND resume_at IS NULL AND completed_at IS NOT NULL
          AND ((transaction_id IS NOT NULL)::int + (review_item_id IS NOT NULL)::int) = 1)
        OR (status IN ('revoked', 'expired') AND resume_at IS NULL
          AND completed_at IS NOT NULL AND transaction_id IS NULL AND review_item_id IS NULL)
      ),
      ADD CONSTRAINT forwarded_email_receipts_cleanup_state_check CHECK (
        (status IN ('accepted', 'deferred')
          AND durable_cleanup_checked_at IS NULL
          AND durable_cleanup_started_at IS NULL
          AND durable_cleanup_cleared_at IS NULL)
        OR (status IN ('completed', 'revoked', 'expired')
          AND (durable_cleanup_started_at IS NULL OR durable_cleanup_checked_at IS NOT NULL)
          AND (durable_cleanup_cleared_at IS NULL OR durable_cleanup_started_at IS NOT NULL))
      )
  `;
  yield* sql`
    CREATE INDEX forwarded_email_receipts_pending_idx
    ON forwarded_email_receipts (received_email_id)
    WHERE status IN ('accepted', 'deferred')
  `;

  yield* sql`
    CREATE TABLE forwarded_email_interpretations (
      received_email_id text PRIMARY KEY
        REFERENCES forwarded_email_receipts(received_email_id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      outcome text NOT NULL CHECK (outcome IN ('extracted', 'invalid-extraction', 'model-unavailable')),
      extraction jsonb,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      CHECK ((outcome = 'extracted') = (extraction IS NOT NULL))
    )
  `;
  yield* sql`CREATE INDEX forwarded_email_interpretations_expiry_idx
    ON forwarded_email_interpretations (expires_at)`;
  yield* sql`ALTER TABLE forwarded_email_interpretations ENABLE ROW LEVEL SECURITY`;
  yield* sql`ALTER TABLE forwarded_email_interpretations FORCE ROW LEVEL SECURITY`;
  yield* sql`CREATE POLICY forwarded_email_interpretations_by_user
    ON forwarded_email_interpretations
    USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)`;
  yield* sql`GRANT SELECT, INSERT, DELETE ON forwarded_email_interpretations TO fidy_runtime`;
  yield* sql`GRANT SELECT, DELETE ON forwarded_email_interpretations TO fidy_gateway`;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_expire_email_ingest_samples(cutoff timestamptz)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE removed integer;
    BEGIN
      DELETE FROM public.forwarded_email_interpretations AS interpretation
      WHERE interpretation.expires_at <= cutoff;
      UPDATE public.email_needs_review_items AS review
      SET status = 'expired', ingest_sample_id = NULL
      WHERE review.status = 'pending' AND review.ingest_sample_id IN (
        SELECT sample.id FROM public.raw_email_ingest_samples AS sample
        WHERE sample.expires_at <= cutoff
      );
      DELETE FROM public.raw_email_ingest_samples AS sample WHERE sample.expires_at <= cutoff;
      GET DIAGNOSTICS removed = ROW_COUNT;
      RETURN removed;
    END
    $function$
  `;

  yield* sql`
    CREATE FUNCTION fidy_resolve_forwarded_email_user(target_id text)
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT user_id FROM public.forwarded_email_receipts WHERE received_email_id = target_id
    $function$
  `;
  yield* sql`ALTER FUNCTION fidy_resolve_forwarded_email_user(text) OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_resolve_forwarded_email_user(text) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_resolve_forwarded_email_user(text) TO fidy_runtime`;

  yield* sql`
    CREATE FUNCTION fidy_list_pending_forwarded_email_executions(
      after_received_email_id text,
      page_size integer
    )
    RETURNS TABLE (received_email_id text, user_id uuid)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT receipt.received_email_id, receipt.user_id
      FROM public.forwarded_email_receipts AS receipt
      WHERE receipt.status IN ('accepted', 'deferred')
        AND (
          after_received_email_id IS NULL
          OR receipt.received_email_id > after_received_email_id
        )
      ORDER BY receipt.received_email_id
      LIMIT LEAST(GREATEST(page_size, 1), 100)
    $function$
  `;
  yield* sql`ALTER FUNCTION fidy_list_pending_forwarded_email_executions(text, integer)
    OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION
    fidy_list_pending_forwarded_email_executions(text, integer) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION
    fidy_list_pending_forwarded_email_executions(text, integer) TO fidy_runtime`;

  yield* sql`
    CREATE INDEX forwarded_email_receipts_cleanup_idx
    ON forwarded_email_receipts (
      durable_cleanup_started_at DESC NULLS LAST,
      durable_cleanup_checked_at NULLS FIRST,
      completed_at,
      received_email_id
    )
    WHERE status IN ('completed', 'revoked', 'expired')
      AND durable_cleanup_cleared_at IS NULL
  `;
  yield* sql`
    CREATE FUNCTION fidy_resolve_expired_forwarded_email_executions(
      completed_before timestamptz
    )
    RETURNS TABLE (
      received_email_id text,
      user_id uuid,
      cleanup_started_at timestamptz
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT receipt.received_email_id, receipt.user_id, receipt.durable_cleanup_started_at
      FROM public.forwarded_email_receipts AS receipt
      WHERE receipt.status IN ('completed', 'revoked', 'expired')
        AND receipt.completed_at <= completed_before
        AND receipt.durable_cleanup_cleared_at IS NULL
      ORDER BY receipt.durable_cleanup_started_at DESC NULLS LAST,
        receipt.durable_cleanup_checked_at NULLS FIRST,
        receipt.durable_cleanup_checked_at,
        receipt.completed_at,
        receipt.received_email_id
      LIMIT 100
    $function$
  `;
  yield* sql`
    CREATE FUNCTION fidy_mark_forwarded_email_cleanup_checked(
      target_id text,
      subject_user_id uuid,
      observed_at timestamptz
    )
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      UPDATE public.forwarded_email_receipts
      SET durable_cleanup_checked_at = observed_at
      WHERE received_email_id = target_id
        AND user_id = subject_user_id
        AND status IN ('completed', 'revoked', 'expired')
        AND durable_cleanup_started_at IS NULL
        AND durable_cleanup_cleared_at IS NULL
    $function$
  `;
  yield* sql`
    CREATE FUNCTION fidy_start_forwarded_email_cleanup(
      target_id text,
      subject_user_id uuid,
      observed_at timestamptz
    )
    RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH started AS (
        UPDATE public.forwarded_email_receipts
        SET durable_cleanup_checked_at = COALESCE(durable_cleanup_checked_at, observed_at),
          durable_cleanup_started_at = COALESCE(durable_cleanup_started_at, observed_at)
        WHERE received_email_id = target_id
          AND user_id = subject_user_id
          AND status IN ('completed', 'revoked', 'expired')
          AND durable_cleanup_cleared_at IS NULL
        RETURNING 1
      )
      SELECT EXISTS (SELECT 1 FROM started)
    $function$
  `;
  yield* sql`
    CREATE FUNCTION fidy_complete_forwarded_email_cleanup(
      target_id text,
      subject_user_id uuid,
      observed_at timestamptz
    )
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      UPDATE public.forwarded_email_receipts
      SET durable_cleanup_cleared_at = observed_at
      WHERE received_email_id = target_id
        AND user_id = subject_user_id
        AND durable_cleanup_started_at IS NOT NULL
        AND durable_cleanup_cleared_at IS NULL
    $function$
  `;
  for (const signature of [
    "fidy_resolve_expired_forwarded_email_executions(timestamptz)",
    "fidy_mark_forwarded_email_cleanup_checked(text, uuid, timestamptz)",
    "fidy_start_forwarded_email_cleanup(text, uuid, timestamptz)",
    "fidy_complete_forwarded_email_cleanup(text, uuid, timestamptz)",
  ]) {
    yield* sql.unsafe(`ALTER FUNCTION ${signature} OWNER TO fidy_gateway`);
    yield* sql.unsafe(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    yield* sql.unsafe(`GRANT EXECUTE ON FUNCTION ${signature} TO fidy_runtime`);
  }

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_enforce_email_outstanding_capacity()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(650220040);
      IF (SELECT count(*) FROM public.forwarded_email_receipts
          WHERE status IN ('accepted', 'deferred')) >= 200 THEN
        RAISE EXCEPTION 'global forwarded email outstanding capacity exceeded'
          USING ERRCODE = '23514';
      END IF;
      PERFORM 1 FROM public.email_forwarding_addresses
      WHERE user_id = NEW.user_id FOR UPDATE;
      IF (SELECT count(*) FROM public.forwarded_email_receipts
          WHERE user_id = NEW.user_id AND status IN ('accepted', 'deferred')) >= 100 THEN
        RAISE EXCEPTION 'user forwarded email outstanding capacity exceeded'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_has_global_forwarded_email_capacity()
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(650220040);
      RETURN (SELECT count(*) FROM public.forwarded_email_receipts
        WHERE status IN ('accepted', 'deferred')) < 200;
    END
    $function$
  `;
  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_revoke_pending_forwarded_emails(
      subject_user_id uuid,
      revoked_at timestamptz
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      DELETE FROM public.forwarded_email_interpretations
      WHERE user_id = subject_user_id;
      DELETE FROM public.raw_email_ingest_samples AS sample
      USING public.forwarded_email_receipts AS receipt
      WHERE sample.received_email_id = receipt.received_email_id
        AND receipt.user_id = subject_user_id
        AND receipt.status IN ('accepted', 'deferred');
      UPDATE public.forwarded_email_receipts
      SET status = 'revoked', resume_at = NULL, completed_at = revoked_at
      WHERE user_id = subject_user_id AND status IN ('accepted', 'deferred');
    END
    $function$
  `;
}).pipe(Effect.asVoid);
