import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Replaces replacement leases with provider evidence and bounded identifier-only execution receipts. */
export const effectEmailReplacement = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE email_replacement_workflows ADD COLUMN credential_verified_at timestamptz;
    UPDATE email_replacement_workflows workflow SET credential_verified_at = credential.verified_at
      FROM verified_email_credentials credential WHERE credential.user_id = workflow.user_id;
    ALTER TABLE email_replacement_workflows ALTER COLUMN credential_verified_at SET NOT NULL
  `;
  yield* sql`
    DROP FUNCTION fidy_claim_email_replacement_delivery(timestamptz, uuid, timestamptz);
    DROP FUNCTION fidy_claim_expired_email_replacement_workflow(timestamptz, uuid, timestamptz);
    DROP INDEX email_replacement_delivery_claimable_idx;
    ALTER TABLE email_replacement_delivery_intents DROP COLUMN claim_token CASCADE,
      DROP COLUMN claim_expires_at CASCADE;
    ALTER TABLE email_replacement_workflows DROP COLUMN retention_claim_token CASCADE,
      DROP COLUMN retention_claim_expires_at CASCADE;
    ALTER TABLE email_replacement_delivery_intents DROP CONSTRAINT email_replacement_delivery_intents_status_check;
    UPDATE email_replacement_delivery_intents SET status = 'uncertain' WHERE status IN ('claimed', 'armed');
    ALTER TABLE email_replacement_delivery_intents ADD CHECK
      (status IN ('pending', 'armed', 'sent', 'rejected', 'uncertain', 'superseded'));

    CREATE TABLE email_replacement_delivery_attempts (
      intent_id uuid NOT NULL REFERENCES email_replacement_delivery_intents(id) ON DELETE CASCADE,
      attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
      outcome text NOT NULL CHECK (outcome IN ('armed', 'sent', 'rejected', 'uncertain', 'retry')),
      PRIMARY KEY (intent_id, attempt)
    );
    ALTER TABLE email_replacement_delivery_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE email_replacement_delivery_attempts FORCE ROW LEVEL SECURITY;
    CREATE POLICY email_replacement_attempts_by_user ON email_replacement_delivery_attempts
      USING (EXISTS (SELECT 1 FROM email_replacement_delivery_intents intent WHERE intent.id = intent_id))
      WITH CHECK (EXISTS (SELECT 1 FROM email_replacement_delivery_intents intent WHERE intent.id = intent_id));
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_replacement_delivery_attempts TO fidy_runtime;

    CREATE TABLE email_replacement_executions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      kind text NOT NULL CHECK (kind IN ('delivery', 'expiry')),
      terminal_observed boolean NOT NULL DEFAULT FALSE,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX email_replacement_execution_expiry_idx ON email_replacement_executions (expires_at, id);
    ALTER TABLE email_replacement_executions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE email_replacement_executions FORCE ROW LEVEL SECURITY;
    CREATE POLICY email_replacement_executions_by_user ON email_replacement_executions
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_replacement_executions TO fidy_runtime;
    GRANT SELECT ON email_replacement_executions TO fidy_gateway;
    CREATE FUNCTION fidy_expired_email_replacement_executions(timestamptz, uuid)
    RETURNS TABLE (id uuid, user_id uuid, kind text, terminal_observed boolean) LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      SELECT id, user_id, kind, terminal_observed FROM email_replacement_executions
      WHERE expires_at <= $1 AND ($2 IS NULL OR id > $2)
      ORDER BY id LIMIT 100
    $$;
    ALTER FUNCTION fidy_expired_email_replacement_executions(timestamptz, uuid) OWNER TO fidy_gateway;
    REVOKE ALL ON FUNCTION fidy_expired_email_replacement_executions(timestamptz, uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_expired_email_replacement_executions(timestamptz, uuid) TO fidy_runtime;
    REVOKE UPDATE ON email_replacement_delivery_intents, email_replacement_workflows FROM fidy_gateway
  `;
});
