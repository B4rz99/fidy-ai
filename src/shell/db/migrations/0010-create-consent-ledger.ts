import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds the append-only consent ledger and minimal 24-hour pre-User exchange state. */
export const createConsentLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE agent_tokens
      ADD CONSTRAINT agent_tokens_id_user_id_key UNIQUE (id, user_id)
  `;

  yield* sql`
    CREATE TABLE consent_records (
      id uuid PRIMARY KEY,
      subject_user_id uuid NOT NULL REFERENCES users(id),
      event_type text NOT NULL CHECK (event_type IN ('granted', 'revoked')),
      grant_type text CHECK (grant_type IN ('onboarding', 'agent-token', 'insight-delivery')),
      agent_token_id uuid,
      insight_kind text,
      revoked_grant_id uuid,
      service_market text NOT NULL,
      locale text NOT NULL,
      disclosure_revision text NOT NULL,
      disclosure_sha256 text NOT NULL CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
      disclosure_text text NOT NULL,
      policy_url text NOT NULL,
      policy_revision text NOT NULL,
      policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
      purposes text[] NOT NULL CHECK (cardinality(purposes) > 0),
      data_categories text[] NOT NULL CHECK (cardinality(data_categories) > 0),
      duration text NOT NULL,
      revocation_method text NOT NULL,
      disclosure_channel text NOT NULL,
      disclosure_provider text NOT NULL,
      disclosure_provider_message_id text NOT NULL,
      decision_channel text NOT NULL,
      decision_provider text NOT NULL,
      decision_provider_message_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      CHECK (
        (event_type = 'granted' AND grant_type IS NOT NULL AND revoked_grant_id IS NULL)
        OR
        (event_type = 'revoked' AND grant_type IS NULL AND agent_token_id IS NULL
          AND insight_kind IS NULL AND revoked_grant_id IS NOT NULL)
      ),
      CHECK (
        (grant_type = 'onboarding' AND agent_token_id IS NULL AND insight_kind IS NULL)
        OR
        (grant_type = 'agent-token' AND agent_token_id IS NOT NULL AND insight_kind IS NULL)
        OR
        (grant_type = 'insight-delivery' AND agent_token_id IS NULL AND insight_kind IS NOT NULL)
        OR grant_type IS NULL
      ),
      UNIQUE (id, subject_user_id),
      FOREIGN KEY (revoked_grant_id, subject_user_id)
        REFERENCES consent_records(id, subject_user_id),
      FOREIGN KEY (agent_token_id, subject_user_id)
        REFERENCES agent_tokens(id, user_id),
      UNIQUE (decision_channel, decision_provider, decision_provider_message_id)
    )
  `;

  yield* sql`
    CREATE INDEX consent_records_current_grant_idx
    ON consent_records (subject_user_id, grant_type, occurred_at, id)
  `;

  yield* sql`
    CREATE INDEX consent_records_revoked_grant_idx
    ON consent_records (revoked_grant_id)
    WHERE event_type = 'revoked'
  `;

  yield* sql`
    CREATE TABLE pending_consent_exchanges (
      id uuid PRIMARY KEY,
      phone_number text NOT NULL UNIQUE CHECK (phone_number ~ '^\\+[1-9][0-9]{7,14}$'),
      lifecycle text NOT NULL CHECK (
        lifecycle IN ('awaiting-disclosure-delivery', 'awaiting-decision')
      ),
      service_market text NOT NULL,
      locale text NOT NULL,
      disclosure_revision text NOT NULL,
      disclosure_sha256 text NOT NULL CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
      disclosure_text text NOT NULL,
      policy_url text NOT NULL,
      policy_revision text NOT NULL,
      policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
      purposes text[] NOT NULL CHECK (cardinality(purposes) > 0),
      data_categories text[] NOT NULL CHECK (cardinality(data_categories) > 0),
      duration text NOT NULL,
      revocation_method text NOT NULL,
      disclosure_channel text,
      disclosure_provider text,
      disclosure_provider_message_id text,
      created_at timestamptz NOT NULL,
      disclosed_at timestamptz,
      expires_at timestamptz NOT NULL CHECK (expires_at = created_at + INTERVAL '24 hours'),
      CHECK (
        (
          lifecycle = 'awaiting-disclosure-delivery'
          AND disclosure_channel IS NULL
          AND disclosure_provider IS NULL
          AND disclosure_provider_message_id IS NULL
          AND disclosed_at IS NULL
        )
        OR
        (
          lifecycle = 'awaiting-decision'
          AND disclosure_channel IS NOT NULL
          AND disclosure_provider IS NOT NULL
          AND disclosure_provider_message_id IS NOT NULL
          AND disclosed_at IS NOT NULL
        )
      )
    )
  `;

  yield* sql`REVOKE UPDATE, DELETE ON consent_records FROM fidy_runtime`;
  yield* sql`GRANT SELECT, INSERT ON consent_records TO fidy_runtime`;
  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON pending_consent_exchanges TO fidy_runtime
  `;
  yield* sql`GRANT SELECT ON consent_records TO fidy_gateway`;
  yield* sql`
    ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
    CREATE POLICY consent_records_by_user ON consent_records
      USING (subject_user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (subject_user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    CREATE FUNCTION fidy_resolve_consent_decision_subject(
      lookup_channel text,
      lookup_provider text,
      lookup_message_id text
    ) RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT record.subject_user_id
      FROM public.consent_records AS record
      WHERE record.decision_channel = lookup_channel
        AND record.decision_provider = lookup_provider
        AND record.decision_provider_message_id = lookup_message_id
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_resolve_consent_decision_subject(text, text, text)
    OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_resolve_consent_decision_subject(text, text, text) FROM PUBLIC
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_resolve_consent_decision_subject(text, text, text)
    TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
