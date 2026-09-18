import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Replaces renewable PAT inactivity deadlines with one fixed expiration chosen at issuance. */
export const fixedPATLifetimes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP FUNCTION IF EXISTS public.fidy_use_token(text, timestamptz, timestamptz);

    DO $migration$
    DECLARE lifecycle_constraint record;
    BEGIN
      FOR lifecycle_constraint IN
        SELECT constraint_name
        FROM information_schema.check_constraints
        WHERE constraint_schema = 'public'
          AND constraint_name IN (
            SELECT constraint_name
            FROM information_schema.constraint_column_usage
            WHERE table_schema = 'public'
              AND table_name = 'tokens'
              AND column_name IN ('last_used_at', 'idle_expires_at')
          )
      LOOP
        EXECUTE format(
          'ALTER TABLE public.tokens DROP CONSTRAINT %I',
          lifecycle_constraint.constraint_name
        );
      END LOOP;
    END
    $migration$;

    ALTER TABLE tokens RENAME COLUMN idle_expires_at TO expires_at;
    ALTER TABLE tokens ADD COLUMN lifetime_days integer NOT NULL DEFAULT 90;
    UPDATE tokens SET expires_at = created_at + INTERVAL '90 days';
    ALTER TABLE tokens ALTER COLUMN lifetime_days DROP DEFAULT;
    ALTER TABLE tokens
      ADD CONSTRAINT tokens_lifetime_days_check
        CHECK (lifetime_days IN (7, 30, 90, 365)),
      ADD CONSTRAINT tokens_fixed_expiration_check
        CHECK (
          expires_at > created_at
          AND expires_at <= created_at + make_interval(days => lifetime_days)
        ),
      ADD CONSTRAINT tokens_last_used_lifecycle_check
        CHECK (last_used_at IS NULL OR (last_used_at >= created_at AND last_used_at < expires_at)),
      ADD CONSTRAINT tokens_revocation_after_use_check
        CHECK (revoked_at IS NULL OR last_used_at IS NULL OR revoked_at >= last_used_at);

    ALTER TABLE consent_records
      DROP CONSTRAINT consent_records_decision_origin_check,
      ADD CONSTRAINT consent_records_decision_origin_check CHECK (
        (
          decision_origin = 'provider-qualified-messages'
          AND disclosure_channel IS NOT NULL
          AND disclosure_provider IS NOT NULL
          AND disclosure_provider_message_id IS NOT NULL
          AND decision_channel IS NOT NULL
          AND decision_provider IS NOT NULL
          AND decision_provider_message_id IS NOT NULL
          AND web_session_id IS NULL
          AND automatic_policy IS NULL
        ) OR (
          decision_origin = 'authenticated-web'
          AND disclosure_channel IS NULL
          AND disclosure_provider IS NULL
          AND disclosure_provider_message_id IS NULL
          AND decision_channel IS NULL
          AND decision_provider IS NULL
          AND decision_provider_message_id IS NULL
          AND web_session_id IS NOT NULL
          AND automatic_policy IS NULL
        ) OR (
          decision_origin = 'automatic-policy'
          AND disclosure_channel IS NULL
          AND disclosure_provider IS NULL
          AND disclosure_provider_message_id IS NULL
          AND decision_channel IS NULL
          AND decision_provider IS NULL
          AND decision_provider_message_id IS NULL
          AND web_session_id IS NULL
          AND automatic_policy IN (
            'pat-approved-unclaimed-expiry', 'pat-fixed-lifetime-expiry'
          )
        )
      );

    CREATE FUNCTION public.fidy_use_token(
      lookup_token_hash text,
      use_time timestamptz
    ) RETURNS TABLE (
      token_id uuid,
      subject_user_id uuid,
      scopes text[],
      last_used_at timestamptz
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH candidate AS MATERIALIZED (
        SELECT id
        FROM public.tokens
        WHERE token_hash = lookup_token_hash AND revoked_at IS NULL
        FOR UPDATE
      ),
      expired AS (
        UPDATE public.tokens AS token
        SET revoked_at = use_time
        FROM candidate
        WHERE token.id = candidate.id
          AND token.expires_at <= use_time
      ),
      active AS (
        UPDATE public.tokens AS token
        SET last_used_at = GREATEST(token.last_used_at, use_time)
        FROM candidate
        WHERE token.id = candidate.id
          AND token.expires_at > use_time
        RETURNING token.id, token.user_id, token.scopes, token.last_used_at
      )
      SELECT active.id, active.user_id, active.scopes, active.last_used_at FROM active
    $function$;

    ALTER FUNCTION public.fidy_use_token(text, timestamptz) OWNER TO fidy_gateway;
    REVOKE ALL ON FUNCTION public.fidy_use_token(text, timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.fidy_use_token(text, timestamptz) TO fidy_runtime;
  `;
}).pipe(Effect.asVoid);
