import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds permanent forwarding addresses, durable Resend work, email evidence, and provenance. */
export const emailIngestion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE email_forwarding_addresses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      local_part text NOT NULL UNIQUE CHECK (local_part ~ '^[a-z0-9_-]{24,64}$'),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    CREATE TABLE forwarded_email_receipts (
      received_email_id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      webhook_delivery_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued', 'deferred', 'processing', 'completed', 'revoked')),
      service_market text NOT NULL,
      locale text NOT NULL,
      time_zone text NOT NULL,
      period_start timestamptz NOT NULL,
      consumes_free_allowance boolean NOT NULL,
      resume_at timestamptz,
      claim_id uuid,
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
      transaction_id uuid,
      review_item_id uuid,
      admitted_at timestamptz NOT NULL,
      started_at timestamptz,
      completed_at timestamptz,
      CHECK (
        (status = 'queued' AND resume_at IS NULL AND claim_id IS NULL AND completed_at IS NULL)
        OR (status = 'deferred' AND resume_at IS NOT NULL AND claim_id IS NULL AND completed_at IS NULL)
        OR (status = 'processing' AND claim_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NULL)
        OR (status = 'completed' AND claim_id IS NULL AND completed_at IS NOT NULL
          AND ((transaction_id IS NOT NULL)::int + (review_item_id IS NOT NULL)::int) = 1)
        OR (status = 'revoked' AND claim_id IS NULL AND completed_at IS NOT NULL
          AND transaction_id IS NULL AND review_item_id IS NULL)
      )
    )
  `;
  yield* sql`
    CREATE INDEX forwarded_email_receipts_user_period_idx
    ON forwarded_email_receipts (user_id, period_start, admitted_at)
  `;
  yield* sql`
    CREATE INDEX forwarded_email_receipts_claim_idx
    ON forwarded_email_receipts (status, resume_at, admitted_at)
  `;
  yield* sql`
    CREATE FUNCTION fidy_enforce_email_outstanding_capacity()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(650220040);
      IF (SELECT count(*) FROM public.forwarded_email_receipts
          WHERE status IN ('queued', 'deferred', 'processing')) >= 200 THEN
        RAISE EXCEPTION 'global forwarded email outstanding capacity exceeded'
          USING ERRCODE = '23514';
      END IF;
      PERFORM 1 FROM public.email_forwarding_addresses
      WHERE user_id = NEW.user_id FOR UPDATE;
      IF (SELECT count(*) FROM public.forwarded_email_receipts
          WHERE user_id = NEW.user_id AND status IN ('queued', 'deferred', 'processing')) >= 100 THEN
        RAISE EXCEPTION 'user forwarded email outstanding capacity exceeded'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_enforce_email_outstanding_capacity() OWNER TO fidy_gateway
  `;
  yield* sql`
    CREATE TRIGGER enforce_email_outstanding_capacity
    BEFORE INSERT ON forwarded_email_receipts
    FOR EACH ROW EXECUTE FUNCTION fidy_enforce_email_outstanding_capacity()
  `;
  yield* sql`
    CREATE TABLE resend_webhook_admission_window (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      window_start timestamptz NOT NULL,
      admitted_count integer NOT NULL CHECK (admitted_count BETWEEN 0 AND 1000)
    )
  `;
  yield* sql`
    CREATE TABLE resend_webhook_deliveries (
      delivery_id text PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 128),
      first_seen_at timestamptz NOT NULL,
      completed boolean NOT NULL DEFAULT false
    )
  `;
  yield* sql`
    CREATE INDEX resend_webhook_deliveries_first_seen_idx
    ON resend_webhook_deliveries (first_seen_at)
  `;
  for (const table of ["resend_webhook_admission_window", "resend_webhook_deliveries"]) {
    yield* sql.unsafe(`ALTER TABLE ${table} OWNER TO fidy_gateway`);
  }
  yield* sql`
    CREATE FUNCTION fidy_admit_authenticated_resend_webhook(target_delivery_id text)
    RETURNS text
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE
      database_now timestamptz := clock_timestamp();
      current_window timestamptz := date_trunc('minute', database_now);
      stored_window timestamptz;
      stored_count integer;
    BEGIN
      IF length(target_delivery_id) NOT BETWEEN 1 AND 128 THEN
        RETURN 'rate-exceeded';
      END IF;
      PERFORM pg_advisory_xact_lock(650220041);
      DELETE FROM public.resend_webhook_deliveries
      WHERE first_seen_at < database_now - interval '10 minutes';
      IF EXISTS (SELECT 1 FROM public.resend_webhook_deliveries
          WHERE delivery_id = target_delivery_id AND completed) THEN
        RETURN 'replay';
      END IF;
      IF EXISTS (SELECT 1 FROM public.resend_webhook_deliveries
          WHERE delivery_id = target_delivery_id) THEN
        RETURN 'retry';
      END IF;
      IF (SELECT count(*) FROM public.resend_webhook_deliveries) >= 11000 THEN
        RETURN 'rate-exceeded';
      END IF;
      INSERT INTO public.resend_webhook_admission_window (
        singleton, window_start, admitted_count
      ) VALUES (true, current_window, 0)
      ON CONFLICT (singleton) DO NOTHING;
      SELECT window_start, admitted_count INTO stored_window, stored_count
      FROM public.resend_webhook_admission_window WHERE singleton = true FOR UPDATE;
      IF stored_window < current_window THEN
        UPDATE public.resend_webhook_admission_window
        SET window_start = current_window, admitted_count = 0 WHERE singleton = true;
        stored_count := 0;
      END IF;
      IF stored_count >= 1000 THEN
        RETURN 'rate-exceeded';
      END IF;
      INSERT INTO public.resend_webhook_deliveries (delivery_id, first_seen_at)
      VALUES (target_delivery_id, database_now);
      UPDATE public.resend_webhook_admission_window
      SET admitted_count = admitted_count + 1 WHERE singleton = true;
      RETURN 'admitted';
    END
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_admit_authenticated_resend_webhook(text) OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_admit_authenticated_resend_webhook(text) FROM PUBLIC
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_admit_authenticated_resend_webhook(text) TO fidy_runtime
  `;
  yield* sql`
    CREATE FUNCTION fidy_complete_authenticated_resend_webhook(target_delivery_id text)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      UPDATE public.resend_webhook_deliveries SET completed = true
      WHERE delivery_id = target_delivery_id
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_complete_authenticated_resend_webhook(text) OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_complete_authenticated_resend_webhook(text) FROM PUBLIC
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_complete_authenticated_resend_webhook(text) TO fidy_runtime
  `;
  yield* sql`
    CREATE TABLE forwarded_email_known_admission_window (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      window_start timestamptz NOT NULL,
      admitted_count integer NOT NULL CHECK (admitted_count BETWEEN 0 AND 120)
    )
  `;
  yield* sql`
    CREATE TABLE forwarded_email_user_admission_windows (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      window_start timestamptz NOT NULL,
      admitted_count integer NOT NULL CHECK (admitted_count BETWEEN 0 AND 100)
    )
  `;
  for (const table of [
    "forwarded_email_known_admission_window",
    "forwarded_email_user_admission_windows",
  ]) {
    yield* sql.unsafe(`ALTER TABLE ${table} OWNER TO fidy_gateway`);
  }
  yield* sql`
    CREATE FUNCTION fidy_admit_known_forwarded_email(target_user_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE
      database_now timestamptz := clock_timestamp();
      current_minute timestamptz := date_trunc('minute', database_now);
      current_hour timestamptz := date_trunc('hour', database_now);
      known_window timestamptz;
      known_count integer;
      user_window timestamptz;
      user_count integer;
    BEGIN
      PERFORM pg_advisory_xact_lock(650220042);
      INSERT INTO public.forwarded_email_known_admission_window (
        singleton, window_start, admitted_count
      ) VALUES (true, current_minute, 0) ON CONFLICT (singleton) DO NOTHING;
      INSERT INTO public.forwarded_email_user_admission_windows (
        user_id, window_start, admitted_count
      ) VALUES (target_user_id, current_hour, 0) ON CONFLICT (user_id) DO NOTHING;
      SELECT window_start, admitted_count INTO known_window, known_count
      FROM public.forwarded_email_known_admission_window WHERE singleton = true FOR UPDATE;
      SELECT window_start, admitted_count INTO user_window, user_count
      FROM public.forwarded_email_user_admission_windows
      WHERE user_id = target_user_id FOR UPDATE;
      IF known_window < current_minute THEN
        UPDATE public.forwarded_email_known_admission_window
        SET window_start = current_minute, admitted_count = 0 WHERE singleton = true;
        known_count := 0;
      END IF;
      IF user_window < current_hour THEN
        UPDATE public.forwarded_email_user_admission_windows
        SET window_start = current_hour, admitted_count = 0 WHERE user_id = target_user_id;
        user_count := 0;
      END IF;
      IF known_count >= 120 OR user_count >= 100 THEN
        RETURN false;
      END IF;
      UPDATE public.forwarded_email_known_admission_window
      SET admitted_count = admitted_count + 1 WHERE singleton = true;
      UPDATE public.forwarded_email_user_admission_windows
      SET admitted_count = admitted_count + 1 WHERE user_id = target_user_id;
      RETURN true;
    END
    $function$
  `;
  yield* sql`ALTER FUNCTION fidy_admit_known_forwarded_email(uuid) OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_admit_known_forwarded_email(uuid) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_admit_known_forwarded_email(uuid) TO fidy_runtime`;
  yield* sql`
    CREATE FUNCTION fidy_has_global_forwarded_email_capacity()
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(650220040);
      RETURN (SELECT count(*) FROM public.forwarded_email_receipts
        WHERE status IN ('queued', 'deferred', 'processing')) < 200;
    END
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_has_global_forwarded_email_capacity() OWNER TO fidy_gateway
  `;
  yield* sql`REVOKE ALL ON FUNCTION fidy_has_global_forwarded_email_capacity() FROM PUBLIC`;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_has_global_forwarded_email_capacity() TO fidy_runtime
  `;
  yield* sql`
    CREATE FUNCTION fidy_enforce_deferred_email_capacity()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      IF NEW.status = 'deferred' AND (TG_OP = 'INSERT' OR OLD.status <> 'deferred') THEN
        PERFORM 1 FROM public.email_forwarding_addresses
        WHERE user_id = NEW.user_id FOR UPDATE;
        IF (SELECT count(*) FROM public.forwarded_email_receipts
            WHERE user_id = NEW.user_id AND status = 'deferred') >= 50 THEN
          RAISE EXCEPTION 'forwarded email deferred capacity exceeded' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `;
  yield* sql`
    CREATE TRIGGER enforce_deferred_email_capacity
    BEFORE INSERT OR UPDATE OF status ON forwarded_email_receipts
    FOR EACH ROW EXECUTE FUNCTION fidy_enforce_deferred_email_capacity()
  `;

  yield* sql`
    CREATE TABLE raw_email_ingest_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      received_email_id text NOT NULL UNIQUE REFERENCES forwarded_email_receipts(received_email_id) ON DELETE RESTRICT,
      service_market text NOT NULL,
      locale text NOT NULL,
      time_zone text NOT NULL,
      source_format text NOT NULL CHECK (source_format = 'notification-email'),
      source_provider text NOT NULL CHECK (source_provider = 'resend'),
      parser_revision text NOT NULL,
      content jsonb NOT NULL,
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      anonymization_candidate text NOT NULL,
      anonymization_revision text NOT NULL,
      retained_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at > retained_at)
    )
  `;
  yield* sql`
    CREATE INDEX raw_email_ingest_samples_expiry_idx ON raw_email_ingest_samples (expires_at)
  `;

  yield* sql`
    CREATE TABLE email_needs_review_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      received_email_id text NOT NULL UNIQUE REFERENCES forwarded_email_receipts(received_email_id) ON DELETE RESTRICT,
      ingest_sample_id uuid REFERENCES raw_email_ingest_samples(id) ON DELETE SET NULL,
      reason text NOT NULL,
      known_amount numeric,
      known_currency text,
      service_market text NOT NULL,
      locale text NOT NULL,
      time_zone text NOT NULL,
      source_format text NOT NULL CHECK (source_format = 'notification-email'),
      source_channel text NOT NULL CHECK (source_channel = 'forwarded-email'),
      source_provider text NOT NULL CHECK (source_provider = 'resend'),
      provider_message_id text NOT NULL,
      parser_revision text NOT NULL,
      extractor_revision text NOT NULL,
      issues jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'expired')),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((known_amount IS NULL) = (known_currency IS NULL)),
      CHECK (
        (status = 'pending'
          AND reason IN ('provider-retrieval-failed', 'processing-interrupted')
          AND ingest_sample_id IS NULL)
        OR (status = 'pending' AND reason IN ('model-unavailable', 'canonical-validation-failed')
          AND ingest_sample_id IS NOT NULL)
        OR (status = 'expired' AND ingest_sample_id IS NULL)
      )
    )
  `;
  yield* sql`
    CREATE INDEX email_needs_review_items_user_status_created_idx
    ON email_needs_review_items (user_id, status, created_at, id)
  `;

  yield* sql`
    CREATE TABLE anonymized_email_ingest_samples (
      id uuid PRIMARY KEY,
      service_market text NOT NULL,
      source_format text NOT NULL CHECK (source_format = 'notification-email'),
      source_provider text NOT NULL CHECK (source_provider = 'resend'),
      parser_revision text NOT NULL,
      anonymization_revision text NOT NULL,
      structure text NOT NULL CHECK (length(structure) > 0),
      approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 120),
      approved_at timestamptz NOT NULL,
      retained_at timestamptz NOT NULL
    )
  `;

  yield* sql`ALTER TABLE source_attestations DROP CONSTRAINT source_attestations_kind_check`;
  yield* sql`ALTER TABLE source_attestations DROP CONSTRAINT source_attestations_statement_shape_check`;
  yield* sql`
    ALTER TABLE source_attestations
      ADD COLUMN received_email_id text REFERENCES forwarded_email_receipts(received_email_id) ON DELETE RESTRICT,
      ADD COLUMN message_channel text,
      ADD COLUMN message_provider text,
      ADD COLUMN provider_message_id text,
      ADD COLUMN message_content_sha256 text,
      ADD CONSTRAINT source_attestations_kind_check
        CHECK (kind IN ('manual', 'statement-line', 'notification-email')),
      ADD CONSTRAINT source_attestations_source_shape_check CHECK (
        (kind = 'manual'
          AND statement_submission_id IS NULL AND statement_record_number IS NULL
          AND statement_content_hash IS NULL AND source_format IS NULL AND extractor_revision IS NULL
          AND received_email_id IS NULL AND message_channel IS NULL AND message_provider IS NULL
          AND provider_message_id IS NULL AND message_content_sha256 IS NULL)
        OR (kind = 'statement-line'
          AND statement_submission_id IS NOT NULL AND statement_record_number > 0
          AND statement_content_hash IS NOT NULL AND source_format IN ('csv', 'xlsx')
          AND extractor_revision IS NOT NULL AND received_email_id IS NULL
          AND message_channel IS NULL AND message_provider IS NULL
          AND provider_message_id IS NULL AND message_content_sha256 IS NULL)
        OR (kind = 'notification-email'
          AND statement_submission_id IS NULL AND statement_record_number IS NULL
          AND statement_content_hash IS NULL AND source_format = 'notification-email'
          AND extractor_revision IS NOT NULL AND received_email_id IS NOT NULL
          AND message_channel = 'email' AND message_provider = 'resend'
          AND provider_message_id IS NOT NULL
          AND message_content_sha256 ~ '^[0-9a-f]{64}$')
      )
  `;

  for (const table of [
    "email_forwarding_addresses",
    "forwarded_email_receipts",
    "raw_email_ingest_samples",
    "email_needs_review_items",
  ]) {
    yield* sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    yield* sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    yield* sql.unsafe(`CREATE POLICY ${table}_by_user ON ${table}
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)`);
  }

  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_forwarding_addresses,
      forwarded_email_receipts, raw_email_ingest_samples, email_needs_review_items TO fidy_runtime
  `;
  yield* sql`GRANT SELECT ON anonymized_email_ingest_samples TO fidy_runtime`;
  yield* sql`
    GRANT SELECT (id, paid_tier, trial_started_at, trial_ends_at) ON users TO fidy_gateway
  `;
  yield* sql`GRANT SELECT, UPDATE ON email_forwarding_addresses TO fidy_gateway`;
  yield* sql`GRANT SELECT, UPDATE, DELETE ON forwarded_email_receipts TO fidy_gateway`;
  yield* sql`GRANT SELECT, UPDATE, DELETE ON raw_email_ingest_samples TO fidy_gateway`;
  yield* sql`GRANT SELECT, INSERT, UPDATE ON email_needs_review_items TO fidy_gateway`;
  yield* sql`GRANT INSERT ON anonymized_email_ingest_samples TO fidy_gateway`;

  yield* sql`
    CREATE FUNCTION fidy_resolve_email_forwarding_address(candidate_local_part text)
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT address.user_id
      FROM public.email_forwarding_addresses AS address
      WHERE address.local_part = candidate_local_part
    $function$
  `;
  yield* sql`ALTER FUNCTION fidy_resolve_email_forwarding_address(text) OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_resolve_email_forwarding_address(text) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_resolve_email_forwarding_address(text) TO fidy_runtime`;

  yield* sql`
    CREATE FUNCTION fidy_expire_email_ingest_samples(cutoff timestamptz)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE removed integer;
    BEGIN
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
  yield* sql`ALTER FUNCTION fidy_expire_email_ingest_samples(timestamptz) OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_expire_email_ingest_samples(timestamptz) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_expire_email_ingest_samples(timestamptz) TO fidy_runtime`;

  yield* sql`
    CREATE FUNCTION fidy_forwarded_email_claim_candidates(
      allowance_from timestamptz,
      allowance_to timestamptz
    )
    RETURNS TABLE (
      received_email_id text, user_id uuid, status text, resume_at timestamptz,
      started_at timestamptz, attempt_count integer, consumed integer, paid_tier text,
      trial_started_at timestamptz, trial_ends_at timestamptz, service_market text,
      locale text, time_zone text, forwarding_local_part text, consumes_free_allowance boolean,
      period_start timestamptz
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT receipt.received_email_id, receipt.user_id, receipt.status, receipt.resume_at,
        receipt.started_at, receipt.attempt_count,
        (SELECT count(*)::integer FROM public.forwarded_email_receipts AS admitted
          WHERE admitted.user_id = receipt.user_id AND admitted.consumes_free_allowance
            AND admitted.status <> 'deferred' AND admitted.period_start >= allowance_from
            AND admitted.period_start < allowance_to),
        subject.paid_tier, subject.trial_started_at, subject.trial_ends_at,
        receipt.service_market, receipt.locale, receipt.time_zone, address.local_part,
        receipt.consumes_free_allowance, receipt.period_start
      FROM public.forwarded_email_receipts AS receipt
      JOIN public.email_forwarding_addresses AS address ON address.user_id = receipt.user_id
      JOIN public.users AS subject ON subject.id = receipt.user_id
      WHERE receipt.status IN ('queued', 'deferred', 'processing')
      ORDER BY CASE receipt.status WHEN 'queued' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
        receipt.admitted_at, receipt.received_email_id
      LIMIT 100
      FOR UPDATE OF receipt, address SKIP LOCKED
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_forwarded_email_claim_candidates(timestamptz, timestamptz)
    OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_forwarded_email_claim_candidates(timestamptz, timestamptz)
    FROM PUBLIC
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_forwarded_email_claim_candidates(timestamptz, timestamptz)
    TO fidy_runtime
  `;
  yield* sql`
    CREATE FUNCTION fidy_claim_forwarded_email(
      target_received_email_id text,
      promoted boolean,
      promoted_period_start timestamptz,
      promoted_consumes_free_allowance boolean
    )
    RETURNS TABLE (
      received_email_id text, user_id uuid, claim_id uuid, service_market text,
      locale text, time_zone text, forwarding_local_part text, parser_revision text,
      attempt_count integer
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH claimed AS (
        UPDATE public.forwarded_email_receipts AS receipt
        SET status = 'processing', started_at = now(), resume_at = NULL,
          period_start = CASE WHEN promoted THEN promoted_period_start ELSE receipt.period_start END,
          consumes_free_allowance = CASE WHEN promoted THEN promoted_consumes_free_allowance
            ELSE receipt.consumes_free_allowance END,
          attempt_count = receipt.attempt_count + 1, claim_id = gen_random_uuid()
        WHERE receipt.received_email_id = target_received_email_id
          AND receipt.status IN ('queued', 'deferred', 'processing')
        RETURNING receipt.*
      )
      SELECT claimed.received_email_id, claimed.user_id, claimed.claim_id,
        claimed.service_market, claimed.locale, claimed.time_zone, address.local_part,
        'notification-email-parser-v1'::text, claimed.attempt_count
      FROM claimed
      JOIN public.email_forwarding_addresses AS address ON address.user_id = claimed.user_id
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_claim_forwarded_email(text, boolean, timestamptz, boolean)
    OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_claim_forwarded_email(text, boolean, timestamptz, boolean)
    FROM PUBLIC
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_claim_forwarded_email(text, boolean, timestamptz, boolean)
    TO fidy_runtime
  `;

  yield* sql`
    CREATE FUNCTION fidy_exhaust_stale_forwarded_email(
      target_received_email_id text,
      exhausted_at timestamptz,
      stale_before timestamptz
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE
      generated_review_id uuid := gen_random_uuid();
      inserted_count integer := 0;
    BEGIN
      INSERT INTO public.email_needs_review_items (
        id, user_id, received_email_id, reason, service_market, locale, time_zone,
        source_format, source_channel, source_provider, provider_message_id,
        parser_revision, extractor_revision, issues, status, created_at
      )
      SELECT generated_review_id, receipt.user_id, receipt.received_email_id,
        'processing-interrupted', receipt.service_market, receipt.locale, receipt.time_zone,
        'notification-email', 'forwarded-email', 'resend', receipt.received_email_id,
        'notification-email-parser-v1', 'notification-email-extractor-v1',
        '[{"path":"email","message":"Processing was interrupted repeatedly"}]'::jsonb,
        'pending', exhausted_at
      FROM public.forwarded_email_receipts AS receipt
      WHERE receipt.received_email_id = target_received_email_id
        AND receipt.status = 'processing' AND receipt.attempt_count >= 3
        AND receipt.started_at < stale_before
      ON CONFLICT (received_email_id) DO NOTHING;
      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      IF inserted_count = 0 THEN RETURN false; END IF;
      UPDATE public.forwarded_email_receipts
      SET status = 'completed', claim_id = NULL, resume_at = NULL, started_at = NULL,
        review_item_id = generated_review_id, completed_at = exhausted_at
      WHERE received_email_id = target_received_email_id
        AND status = 'processing' AND attempt_count >= 3;
      RETURN true;
    END
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_exhaust_stale_forwarded_email(text, timestamptz, timestamptz)
    OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_exhaust_stale_forwarded_email(text, timestamptz, timestamptz)
    FROM PUBLIC
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_exhaust_stale_forwarded_email(text, timestamptz, timestamptz)
    TO fidy_runtime
  `;

  yield* sql`
    CREATE FUNCTION fidy_revoke_pending_forwarded_emails(
      subject_user_id uuid,
      revoked_at timestamptz
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      DELETE FROM public.raw_email_ingest_samples AS sample
      USING public.forwarded_email_receipts AS receipt
      WHERE sample.received_email_id = receipt.received_email_id
        AND receipt.user_id = subject_user_id
        AND receipt.status IN ('queued', 'deferred', 'processing');
      UPDATE public.forwarded_email_receipts
      SET status = 'revoked', claim_id = NULL, resume_at = NULL,
        started_at = NULL, completed_at = revoked_at
      WHERE user_id = subject_user_id
        AND status IN ('queued', 'deferred', 'processing');
    END
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_revoke_pending_forwarded_emails(uuid, timestamptz)
    OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_revoke_pending_forwarded_emails(uuid, timestamptz) FROM PUBLIC
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_revoke_pending_forwarded_emails(uuid, timestamptz)
    TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
