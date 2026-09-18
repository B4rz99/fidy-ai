import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Replaces statement claim leases and retry columns with identifier-only Effect queue work. */
export const effectStatementIngestion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP FUNCTION fidy_claim_statement_submission()`;
  yield* sql`ALTER TABLE statement_submissions DROP CONSTRAINT statement_submissions_check`;
  yield* sql`ALTER TABLE statement_submissions DROP CONSTRAINT statement_submissions_status_check`;
  yield* sql`
    UPDATE statement_submissions
    SET status = 'queued', claim_id = NULL
    WHERE status = 'processing'
  `;
  yield* sql`
    ALTER TABLE statement_submissions
      DROP COLUMN claim_id,
      DROP COLUMN attempt_count,
      ADD CONSTRAINT statement_submissions_status_check
        CHECK (status IN ('queued', 'completed', 'failed')),
      ADD CONSTRAINT statement_submissions_state_check CHECK (
        (status = 'queued' AND completed_at IS NULL AND file_content IS NOT NULL)
        OR (status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND input_rows = accepted_rows + needs_review_rows AND file_content IS NULL
          AND failure_reason IS NULL)
        OR (status = 'failed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND file_content IS NULL AND failure_reason IN ('unsupported-format', 'resource-limit',
            'malformed-file', 'mapping-unavailable', 'retention-expired'))
      )
  `;

  yield* sql`
    CREATE FUNCTION fidy_resolve_statement_submission_user(target_id uuid)
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT user_id FROM public.statement_submissions WHERE id = target_id
    $function$
  `;
  yield* sql`ALTER FUNCTION fidy_resolve_statement_submission_user(uuid) OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_resolve_statement_submission_user(uuid) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_resolve_statement_submission_user(uuid) TO fidy_runtime`;

  yield* sql`
    CREATE FUNCTION fidy_list_queued_statement_submissions(
      after_submitted_at timestamptz,
      after_id uuid,
      page_size integer
    )
    RETURNS TABLE (id uuid, user_id uuid, submitted_at timestamptz)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT submission.id, submission.user_id, submission.submitted_at
      FROM public.statement_submissions AS submission
      WHERE submission.status = 'queued'
        AND (
          after_submitted_at IS NULL
          OR (submission.submitted_at, submission.id) > (after_submitted_at, after_id)
        )
      ORDER BY submission.submitted_at, submission.id
      LIMIT LEAST(GREATEST(page_size, 1), 100)
    $function$
  `;
  yield* sql`ALTER FUNCTION fidy_list_queued_statement_submissions(timestamptz, uuid, integer)
    OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION
    fidy_list_queued_statement_submissions(timestamptz, uuid, integer) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION
    fidy_list_queued_statement_submissions(timestamptz, uuid, integer) TO fidy_runtime`;

  yield* sql`
    CREATE FUNCTION fidy_list_terminal_statement_executions(
      after_completed_at timestamptz,
      after_id uuid,
      page_size integer
    )
    RETURNS TABLE (id uuid, completed_at timestamptz)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT submission.id, submission.completed_at
      FROM public.statement_submissions AS submission
      WHERE submission.status IN ('completed', 'failed')
        AND submission.completed_at < now() - interval '1 day'
        AND (
          after_completed_at IS NULL
          OR (submission.completed_at, submission.id) > (after_completed_at, after_id)
        )
      ORDER BY submission.completed_at, submission.id
      LIMIT LEAST(GREATEST(page_size, 1), 100)
    $function$
  `;
  yield* sql`ALTER FUNCTION fidy_list_terminal_statement_executions(timestamptz, uuid, integer)
    OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION
    fidy_list_terminal_statement_executions(timestamptz, uuid, integer) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION
    fidy_list_terminal_statement_executions(timestamptz, uuid, integer) TO fidy_runtime`;

  yield* sql`
    CREATE FUNCTION fidy_expire_statement_ingestion()
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH expired_review AS MATERIALIZED (
        UPDATE public.needs_review_items
        SET status = 'expired', original_evidence = NULL
        WHERE status = 'pending' AND created_at < now() - interval '30 days'
      ), expired_submissions AS MATERIALIZED (
        UPDATE public.statement_submissions
        SET status = 'failed', file_content = NULL, started_at = coalesce(started_at, now()),
          completed_at = now(), failure_reason = 'retention-expired'
        WHERE status = 'queued' AND submitted_at < now() - interval '24 hours'
        RETURNING id
      )
      UPDATE public.statement_backfill_entitlements
      SET submission_id = NULL
      WHERE consumed_at IS NULL
        AND submission_id IN (SELECT id FROM expired_submissions)
    $function$
  `;
  yield* sql`ALTER FUNCTION fidy_expire_statement_ingestion() OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_expire_statement_ingestion() FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_expire_statement_ingestion() TO fidy_runtime`;
}).pipe(Effect.asVoid);
