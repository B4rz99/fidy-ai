import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds the bounded User-owned email replacement workflow and metadata-only lifecycle evidence. */
export const verifiedEmailReplacement = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE email_replacement_workflows (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      candidate_email_address text NOT NULL
        CHECK (candidate_email_address = lower(btrim(candidate_email_address))),
      public_code text NOT NULL UNIQUE
        CHECK (public_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$'),
      started_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at = started_at + interval '24 hours'),
      delivery_generation integer NOT NULL CHECK (delivery_generation BETWEEN 1 AND 5),
      resend_available_at timestamptz NOT NULL,
      proof_digest bytea CHECK (proof_digest IS NULL OR octet_length(proof_digest) = 32),
      proof_expires_at timestamptz,
      wrong_proof_attempts integer NOT NULL DEFAULT 0 CHECK (wrong_proof_attempts BETWEEN 0 AND 4),
      retention_claim_token uuid,
      retention_claim_expires_at timestamptz,
      CHECK ((retention_claim_token IS NULL) = (retention_claim_expires_at IS NULL)),
      CHECK ((proof_digest IS NULL) = (proof_expires_at IS NULL)),
      CHECK (proof_expires_at IS NULL OR proof_expires_at <= expires_at)
    );
    CREATE UNIQUE INDEX email_replacement_candidate_unique
      ON email_replacement_workflows (lower(candidate_email_address));
    CREATE INDEX email_replacement_expiry_idx ON email_replacement_workflows (expires_at, id);

    CREATE TABLE email_replacement_delivery_intents (
      id uuid PRIMARY KEY,
      workflow_id uuid NOT NULL REFERENCES email_replacement_workflows(id) ON DELETE CASCADE,
      generation integer NOT NULL CHECK (generation BETWEEN 1 AND 5),
      email_address text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'claimed', 'armed', 'sent', 'rejected', 'uncertain', 'superseded')),
      idempotency_key uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL,
      claim_token uuid,
      claim_expires_at timestamptz,
      provider_message_id text,
      CHECK ((status IN ('claimed', 'armed')) =
        (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)),
      UNIQUE (workflow_id, generation)
    );
    CREATE INDEX email_replacement_delivery_claimable_idx
      ON email_replacement_delivery_intents (created_at, id)
      WHERE status IN ('pending', 'claimed', 'armed');

    CREATE TABLE verified_email_credential_lifecycle_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      subject_user_id uuid NOT NULL,
      authorizing_web_session_id uuid NOT NULL,
      event_kind text NOT NULL DEFAULT 'Replaced' CHECK (event_kind = 'Replaced'),
      occurred_at timestamptz NOT NULL
    );
    CREATE INDEX verified_email_lifecycle_subject_idx
      ON verified_email_credential_lifecycle_events (subject_user_id, occurred_at, id);
    CREATE INDEX verified_email_lifecycle_retention_idx
      ON verified_email_credential_lifecycle_events (occurred_at, id);
  `;
  yield* sql`
    ALTER TABLE email_replacement_workflows ENABLE ROW LEVEL SECURITY;
    ALTER TABLE email_replacement_workflows FORCE ROW LEVEL SECURITY;
    CREATE POLICY email_replacement_workflows_by_user ON email_replacement_workflows
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
    ALTER TABLE email_replacement_delivery_intents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE email_replacement_delivery_intents FORCE ROW LEVEL SECURITY;
    CREATE POLICY email_replacement_delivery_intents_by_user ON email_replacement_delivery_intents
      USING (EXISTS (
        SELECT 1 FROM email_replacement_workflows workflow
        WHERE workflow.id = workflow_id
          AND workflow.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      )) WITH CHECK (EXISTS (
        SELECT 1 FROM email_replacement_workflows workflow
        WHERE workflow.id = workflow_id
          AND workflow.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ));
    ALTER TABLE verified_email_credential_lifecycle_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE verified_email_credential_lifecycle_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY verified_email_lifecycle_by_user ON verified_email_credential_lifecycle_events
      USING (subject_user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (subject_user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
  `;
  yield* sql`
    CREATE FUNCTION fidy_email_replacement_candidate_unavailable(uuid, text)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      SELECT EXISTS (
        SELECT 1 FROM verified_email_credentials WHERE lower(email_address) = lower($2)
      ) OR EXISTS (
        SELECT 1 FROM email_replacement_workflows
        WHERE user_id <> $1 AND lower(candidate_email_address) = lower($2)
      )
    $$;
    CREATE FUNCTION fidy_claim_email_replacement_delivery(timestamptz, uuid, timestamptz)
    RETURNS TABLE (intent_id uuid, user_id uuid, claim_token uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      WITH reconciled AS (
        UPDATE email_replacement_delivery_intents intent SET
          status = 'uncertain', claim_token = NULL, claim_expires_at = NULL
        FROM email_replacement_workflows workflow
        WHERE intent.workflow_id = workflow.id AND intent.status = 'armed'
          AND intent.claim_expires_at <= $1
        RETURNING intent.id
      ), claimed AS (
        SELECT candidate.id FROM email_replacement_delivery_intents candidate
        JOIN email_replacement_workflows workflow ON workflow.id = candidate.workflow_id
        WHERE candidate.status = 'pending'
          OR (candidate.status = 'claimed' AND candidate.claim_expires_at <= $1
            AND workflow.proof_digest IS NULL)
        ORDER BY candidate.created_at, candidate.id FOR UPDATE OF candidate SKIP LOCKED LIMIT 1
      )
      UPDATE email_replacement_delivery_intents intent SET
        status = 'claimed', claim_token = $2, claim_expires_at = $3
      FROM claimed, email_replacement_workflows workflow
      WHERE intent.id = claimed.id AND workflow.id = intent.workflow_id
      RETURNING intent.id, workflow.user_id, intent.claim_token
    $$;
    CREATE FUNCTION fidy_claim_expired_email_replacement_workflow(timestamptz, uuid, timestamptz)
    RETURNS TABLE (workflow_id uuid, user_id uuid, claim_token uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      UPDATE email_replacement_workflows workflow SET
        retention_claim_token = $2, retention_claim_expires_at = $3
      FROM (
        SELECT candidate.id FROM email_replacement_workflows candidate
        WHERE candidate.expires_at <= $1
          AND (candidate.retention_claim_token IS NULL OR candidate.retention_claim_expires_at <= $1)
        ORDER BY candidate.expires_at, candidate.id FOR UPDATE SKIP LOCKED LIMIT 1
      ) claimed
      WHERE workflow.id = claimed.id
      RETURNING workflow.id, workflow.user_id, workflow.retention_claim_token
    $$;
    CREATE FUNCTION fidy_lock_fresh_web_session_for_user(uuid, uuid, timestamptz)
    RETURNS boolean LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      WITH locked AS (
        SELECT id FROM web_sessions
        WHERE id = $1 AND user_id = $2
          AND $2::text = current_setting('fidy.user_id', true)
          AND revoked_at IS NULL AND fresh_until > $3
          AND idle_expires_at > $3 AND hard_expires_at > $3
        FOR UPDATE
      ) SELECT EXISTS (SELECT 1 FROM locked)
    $$;
    CREATE FUNCTION fidy_delete_verified_email_lifecycle_events_before(timestamptz)
    RETURNS bigint LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      WITH deleted AS (
        DELETE FROM verified_email_credential_lifecycle_events WHERE occurred_at < $1 RETURNING 1
      ) SELECT count(*) FROM deleted
    $$;
  `;
  yield* sql`
    GRANT SELECT, UPDATE ON email_replacement_delivery_intents TO fidy_gateway;
    GRANT SELECT, UPDATE ON email_replacement_workflows TO fidy_gateway;
    GRANT SELECT ON verified_email_credentials, web_sessions TO fidy_gateway;
    GRANT SELECT, DELETE ON verified_email_credential_lifecycle_events TO fidy_gateway
  `;
  yield* sql`ALTER FUNCTION fidy_email_replacement_candidate_unavailable(uuid, text) OWNER TO fidy_gateway`;
  yield* sql`ALTER FUNCTION fidy_claim_email_replacement_delivery(timestamptz, uuid, timestamptz) OWNER TO fidy_gateway`;
  yield* sql`ALTER FUNCTION fidy_claim_expired_email_replacement_workflow(timestamptz, uuid, timestamptz) OWNER TO fidy_gateway`;
  yield* sql`ALTER FUNCTION fidy_lock_fresh_web_session_for_user(uuid, uuid, timestamptz) OWNER TO fidy_gateway`;
  yield* sql`ALTER FUNCTION fidy_delete_verified_email_lifecycle_events_before(timestamptz) OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_email_replacement_candidate_unavailable(uuid, text) FROM PUBLIC`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_claim_email_replacement_delivery(timestamptz, uuid, timestamptz) FROM PUBLIC`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_claim_expired_email_replacement_workflow(timestamptz, uuid, timestamptz) FROM PUBLIC`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_lock_fresh_web_session_for_user(uuid, uuid, timestamptz) FROM PUBLIC`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_delete_verified_email_lifecycle_events_before(timestamptz) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_email_replacement_candidate_unavailable(uuid, text) TO fidy_runtime`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_claim_email_replacement_delivery(timestamptz, uuid, timestamptz) TO fidy_runtime`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_claim_expired_email_replacement_workflow(timestamptz, uuid, timestamptz) TO fidy_runtime`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_lock_fresh_web_session_for_user(uuid, uuid, timestamptz) TO fidy_runtime`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_delete_verified_email_lifecycle_events_before(timestamptz) TO fidy_runtime`;
  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_replacement_workflows TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_replacement_delivery_intents TO fidy_runtime;
    GRANT SELECT, INSERT ON verified_email_credential_lifecycle_events TO fidy_runtime
  `;
});
