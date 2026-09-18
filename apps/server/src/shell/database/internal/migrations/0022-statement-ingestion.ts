import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds durable statement work, review ownership, mapping reuse, and statement provenance. */
export const statementIngestion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE statement_submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      idempotency_key uuid NOT NULL,
      content_hash text NOT NULL,
      source_format text NOT NULL CHECK (source_format IN ('csv', 'xlsx')),
      file_content bytea,
      status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
      service_market text NOT NULL,
      locale text NOT NULL,
      time_zone text NOT NULL,
      parser_revision text NOT NULL,
      claim_id uuid,
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
      input_rows integer,
      accepted_rows integer,
      needs_review_rows integer,
      failure_reason text,
      submitted_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz,
      UNIQUE (user_id, idempotency_key),
      CHECK (
        (status = 'queued' AND started_at IS NULL AND completed_at IS NULL AND claim_id IS NULL)
        OR (status = 'processing' AND started_at IS NOT NULL AND completed_at IS NULL
          AND claim_id IS NOT NULL)
        OR (status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND input_rows = accepted_rows + needs_review_rows AND file_content IS NULL
          AND failure_reason IS NULL AND claim_id IS NULL)
        OR (status = 'failed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND file_content IS NULL AND claim_id IS NULL AND failure_reason IN ('unsupported-format', 'resource-limit',
            'malformed-file', 'mapping-unavailable', 'retention-expired'))
      )
    )
  `;
  yield* sql`
    CREATE TABLE statement_backfill_entitlements (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
      consumed_at timestamptz,
      submission_id uuid REFERENCES statement_submissions(id) DEFERRABLE INITIALLY DEFERRED
    )
  `;

  yield* sql`
    CREATE TABLE statement_format_profiles (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      fingerprint text NOT NULL,
      mapping jsonb NOT NULL,
      extractor_revision text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, fingerprint)
    )
  `;

  yield* sql`
    CREATE TABLE needs_review_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      submission_id uuid NOT NULL REFERENCES statement_submissions(id) ON DELETE RESTRICT,
      record_number integer NOT NULL CHECK (record_number > 0),
      reason text NOT NULL,
      known_amount numeric,
      known_currency text,
      service_market text NOT NULL,
      locale text NOT NULL,
      time_zone text NOT NULL,
      source_format text NOT NULL CHECK (source_format IN ('csv', 'xlsx')),
      source_channel text NOT NULL CHECK (source_channel = 'statement-upload'),
      source_provider text,
      parser_revision text NOT NULL,
      extractor_revision text NOT NULL,
      original_evidence jsonb,
      issues jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'expired', 'resolved')),
      transaction_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      UNIQUE (submission_id, record_number),
      CHECK ((known_amount IS NULL) = (known_currency IS NULL)),
      CHECK (
        (status = 'pending' AND original_evidence IS NOT NULL
          AND transaction_id IS NULL AND resolved_at IS NULL)
        OR (status = 'expired' AND original_evidence IS NULL
          AND transaction_id IS NULL AND resolved_at IS NULL)
        OR (status = 'resolved' AND original_evidence IS NULL
          AND transaction_id IS NOT NULL AND resolved_at IS NOT NULL)
      )
    )
  `;
  yield* sql`
    CREATE INDEX needs_review_items_user_status_created_idx
    ON needs_review_items (user_id, status, created_at, id)
  `;

  yield* sql`ALTER TABLE source_attestations DROP CONSTRAINT source_attestations_kind_check`;
  yield* sql`
    ALTER TABLE source_attestations
      ADD CONSTRAINT source_attestations_kind_check CHECK (kind IN ('manual', 'statement-line')),
      ADD COLUMN statement_submission_id uuid,
      ADD COLUMN statement_record_number integer,
      ADD COLUMN statement_content_hash text,
      ADD COLUMN source_format text,
      ADD COLUMN extractor_revision text,
      ADD CONSTRAINT source_attestations_statement_shape_check CHECK (
        (kind = 'manual' AND statement_submission_id IS NULL AND statement_record_number IS NULL
          AND statement_content_hash IS NULL AND source_format IS NULL AND extractor_revision IS NULL)
        OR (kind = 'statement-line' AND statement_submission_id IS NOT NULL
          AND statement_record_number IS NOT NULL AND statement_record_number > 0
          AND statement_content_hash IS NOT NULL AND source_format IN ('csv', 'xlsx')
          AND extractor_revision IS NOT NULL)
      )
  `;

  for (const table of [
    "statement_submissions",
    "statement_backfill_entitlements",
    "statement_format_profiles",
    "needs_review_items",
  ]) {
    yield* sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    yield* sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    yield* sql.unsafe(`CREATE POLICY ${table}_by_user ON ${table}
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)`);
  }
  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      statement_submissions, statement_backfill_entitlements, statement_format_profiles,
      needs_review_items TO fidy_runtime
  `;
  yield* sql`GRANT SELECT, UPDATE ON statement_submissions TO fidy_gateway`;
  yield* sql`GRANT SELECT, UPDATE ON statement_backfill_entitlements TO fidy_gateway`;
  yield* sql`GRANT SELECT, UPDATE ON needs_review_items TO fidy_gateway`;

  yield* sql`
    CREATE FUNCTION fidy_claim_statement_submission()
    RETURNS TABLE (
      id uuid, user_id uuid, claim_id uuid, content_hash text, source_format text,
      file_content bytea, service_market text, locale text, time_zone text,
      parser_revision text, attempt_count integer
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH expired_review AS MATERIALIZED (
        UPDATE public.needs_review_items AS review
        SET status = 'expired', original_evidence = NULL
        WHERE review.status = 'pending'
          AND review.created_at < now() - interval '30 days'
        RETURNING review.id
      ), expired_submissions AS MATERIALIZED (
        UPDATE public.statement_submissions AS submission
        SET status = 'failed', file_content = NULL, started_at = coalesce(started_at, now()),
          completed_at = now(), claim_id = NULL, failure_reason = 'retention-expired'
        WHERE submission.status IN ('queued', 'processing')
          AND submission.submitted_at < now() - interval '24 hours'
        RETURNING submission.id
      ), released_entitlements AS MATERIALIZED (
        UPDATE public.statement_backfill_entitlements AS entitlement
        SET submission_id = NULL
        WHERE entitlement.consumed_at IS NULL
          AND entitlement.submission_id IN (
            SELECT expired.id FROM expired_submissions AS expired
          )
        RETURNING entitlement.user_id
      ), candidate AS MATERIALIZED (
        SELECT submission.id
        FROM public.statement_submissions AS submission
        WHERE (
          submission.status = 'queued'
          OR (submission.status = 'processing' AND submission.started_at < now() - interval '15 minutes')
        )
          AND NOT EXISTS (
            SELECT 1 FROM expired_submissions AS expired WHERE expired.id = submission.id
          )
        ORDER BY submission.submitted_at, submission.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE public.statement_submissions AS submission
        SET status = 'processing', started_at = now(),
        attempt_count = submission.attempt_count + 1,
        claim_id = md5(random()::text || clock_timestamp()::text || pg_backend_pid()::text)::uuid
        FROM candidate
        WHERE submission.id = candidate.id
        RETURNING submission.*
      )
      SELECT claimed.id, claimed.user_id, claimed.claim_id, claimed.content_hash,
        claimed.source_format, claimed.file_content, claimed.service_market, claimed.locale,
        claimed.time_zone, claimed.parser_revision, claimed.attempt_count
      FROM claimed
      LEFT JOIN released_entitlements ON false
    $function$
  `;
  yield* sql`ALTER FUNCTION fidy_claim_statement_submission() OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_claim_statement_submission() FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_claim_statement_submission() TO fidy_runtime`;
}).pipe(Effect.asVoid);
