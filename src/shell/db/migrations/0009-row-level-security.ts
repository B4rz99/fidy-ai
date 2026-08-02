import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds restricted runtime authority, transaction-scoped RLS, and narrow pre-subject gateways. */
export const rowLevelSecurity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fidy_runtime') THEN
        CREATE ROLE fidy_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'fidy_gateway') THEN
        CREATE ROLE fidy_gateway NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'fidy_runtime' AND (rolsuper OR rolbypassrls)
      ) THEN
        RAISE EXCEPTION 'fidy_runtime must not be superuser or BYPASSRLS';
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'fidy_gateway' AND (rolsuper OR NOT rolbypassrls OR rolcanlogin)
      ) THEN
        RAISE EXCEPTION 'fidy_gateway must be NOLOGIN, NOSUPERUSER, BYPASSRLS';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS runtime_role
        INNER JOIN pg_catalog.pg_roles AS granted_role
          ON granted_role.oid <> runtime_role.oid
          AND pg_catalog.pg_has_role(runtime_role.oid, granted_role.oid, 'MEMBER')
        WHERE runtime_role.rolname = 'fidy_runtime'
          AND (
            granted_role.rolsuper
            OR granted_role.rolbypassrls
            OR EXISTS (
              SELECT 1
              FROM pg_catalog.pg_class AS relation
              INNER JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'public'
                AND relation.relname = ANY(ARRAY[
                  'users', 'whatsapp_identities', 'agent_tokens', 'audit_log_entries',
                  'consent_records', 'transactions', 'keyword_rules', 'source_attestations', 'insight_events',
                  'insight_money_groups', 'insight_delivery_attempts', 'dashboards',
                  'transcript_entries'
                ])
                AND relation.relowner = granted_role.oid
            )
          )
      ) THEN
        RAISE EXCEPTION 'fidy_runtime must not inherit or assume an RLS-bypass authority';
      END IF;
    END
    $roles$
  `;

  yield* sql`GRANT USAGE ON SCHEMA public TO fidy_runtime, fidy_gateway`;
  yield* sql`GRANT SELECT ON categories TO fidy_runtime`;
  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      users, whatsapp_identities, agent_tokens, audit_log_entries,
      transactions, keyword_rules, source_attestations, insight_events,
      insight_money_groups, insight_delivery_attempts, dashboards, transcript_entries
    TO fidy_runtime
  `;
  yield* sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fidy_runtime`;

  yield* sql`
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE users FORCE ROW LEVEL SECURITY;
    CREATE POLICY users_by_user ON users
      USING (id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE whatsapp_identities ENABLE ROW LEVEL SECURITY;
    ALTER TABLE whatsapp_identities FORCE ROW LEVEL SECURITY;
    CREATE POLICY whatsapp_identities_by_user ON whatsapp_identities
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE agent_tokens ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agent_tokens FORCE ROW LEVEL SECURITY;
    CREATE POLICY agent_tokens_by_user ON agent_tokens
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE audit_log_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_log_entries FORCE ROW LEVEL SECURITY;
    CREATE POLICY audit_log_entries_by_user ON audit_log_entries
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
    CREATE POLICY transactions_by_user ON transactions
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE keyword_rules ENABLE ROW LEVEL SECURITY;
    ALTER TABLE keyword_rules FORCE ROW LEVEL SECURITY;
    CREATE POLICY keyword_rules_by_user ON keyword_rules
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE source_attestations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE source_attestations FORCE ROW LEVEL SECURITY;
    CREATE POLICY source_attestations_by_user ON source_attestations
      USING (EXISTS (
        SELECT 1 FROM transactions
        WHERE transactions.id = source_attestations.transaction_id
          AND transactions.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM transactions
        WHERE transactions.id = source_attestations.transaction_id
          AND transactions.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ))
  `;
  yield* sql`
    ALTER TABLE insight_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE insight_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY insight_events_by_user ON insight_events
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE insight_money_groups ENABLE ROW LEVEL SECURITY;
    ALTER TABLE insight_money_groups FORCE ROW LEVEL SECURITY;
    CREATE POLICY insight_money_groups_by_user ON insight_money_groups
      USING (EXISTS (
        SELECT 1 FROM insight_events
        WHERE insight_events.id = insight_money_groups.insight_event_id
          AND insight_events.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM insight_events
        WHERE insight_events.id = insight_money_groups.insight_event_id
          AND insight_events.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ))
  `;
  yield* sql`
    ALTER TABLE insight_delivery_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE insight_delivery_attempts FORCE ROW LEVEL SECURITY;
    CREATE POLICY insight_delivery_attempts_by_user ON insight_delivery_attempts
      USING (EXISTS (
        SELECT 1 FROM insight_events
        WHERE insight_events.id = insight_delivery_attempts.insight_event_id
          AND insight_events.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM insight_events
        WHERE insight_events.id = insight_delivery_attempts.insight_event_id
          AND insight_events.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ))
  `;
  yield* sql`
    ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
    ALTER TABLE dashboards FORCE ROW LEVEL SECURITY;
    CREATE POLICY dashboards_by_user ON dashboards
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE transcript_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE transcript_entries FORCE ROW LEVEL SECURITY;
    CREATE POLICY transcript_entries_by_user ON transcript_entries
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;

  yield* sql`GRANT SELECT ON whatsapp_identities TO fidy_gateway`;
  yield* sql`GRANT SELECT, UPDATE ON agent_tokens TO fidy_gateway`;
  yield* sql`GRANT SELECT, DELETE ON audit_log_entries TO fidy_gateway`;

  yield* sql`
    CREATE FUNCTION fidy_resolve_whatsapp_user(lookup_phone_number text)
    RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT identity.user_id
      FROM public.whatsapp_identities AS identity
      WHERE identity.phone_number = lookup_phone_number
    $function$
  `;
  yield* sql`
    CREATE FUNCTION fidy_use_agent_token(
      lookup_token_hash text,
      use_time timestamptz,
      renewed_idle_expiry timestamptz
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
        FROM public.agent_tokens
        WHERE token_hash = lookup_token_hash AND revoked_at IS NULL
        FOR UPDATE
      ),
      auto_revoked AS (
        UPDATE public.agent_tokens AS token
        SET revoked_at = use_time
        FROM candidate
        WHERE token.id = candidate.id
          AND (
            (token.kind = 'user' AND token.idle_expires_at <= use_time)
            OR (token.kind = 'hosted' AND token.expires_at <= use_time)
          )
      ),
      active AS (
        UPDATE public.agent_tokens AS token
        SET last_used_at = GREATEST(token.last_used_at, use_time),
          idle_expires_at = GREATEST(token.idle_expires_at, renewed_idle_expiry)
        FROM candidate
        WHERE token.id = candidate.id
          AND (
            (token.kind = 'user' AND token.idle_expires_at > use_time)
            OR (token.kind = 'hosted' AND token.expires_at > use_time)
          )
        RETURNING token.id, token.user_id, token.scopes, token.last_used_at
      )
      SELECT active.id, active.user_id, active.scopes, active.last_used_at FROM active
    $function$
  `;
  yield* sql`
    CREATE FUNCTION fidy_delete_audit_log_entries_before(cutoff timestamptz)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      DELETE FROM public.audit_log_entries WHERE occurred_at < cutoff
    $function$
  `;

  yield* sql`ALTER FUNCTION fidy_resolve_whatsapp_user(text) OWNER TO fidy_gateway`;
  yield* sql`
    ALTER FUNCTION fidy_use_agent_token(text, timestamptz, timestamptz) OWNER TO fidy_gateway
  `;
  yield* sql`
    ALTER FUNCTION fidy_delete_audit_log_entries_before(timestamptz) OWNER TO fidy_gateway
  `;
  yield* sql`REVOKE ALL ON FUNCTION fidy_resolve_whatsapp_user(text) FROM PUBLIC`;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_use_agent_token(text, timestamptz, timestamptz) FROM PUBLIC
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_delete_audit_log_entries_before(timestamptz) FROM PUBLIC
  `;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_resolve_whatsapp_user(text) TO fidy_runtime`;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_use_agent_token(text, timestamptz, timestamptz) TO fidy_runtime
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_delete_audit_log_entries_before(timestamptz) TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
