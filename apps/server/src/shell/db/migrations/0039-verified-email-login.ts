import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { EmailAddress } from "~/core/email-authentication/model";
import { emailCredentialLookupKey } from "~/shell/email-authentication/admission";

/** Adds bounded verified-email approval of existing BrowserLogin pairings. */
export const verifiedEmailLogin = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE verified_email_credential_authentication_lookups (
      user_id uuid PRIMARY KEY REFERENCES verified_email_credentials(user_id) ON DELETE CASCADE,
      authentication_lookup_key text NOT NULL
        CONSTRAINT verified_email_auth_lookup_key_unique UNIQUE
        CHECK (authentication_lookup_key ~ '^[0-9a-f]{64}$')
    );

    CREATE TABLE browser_pairing_email_workflows (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pairing_id uuid NOT NULL UNIQUE REFERENCES browser_login_pairings(id) ON DELETE CASCADE,
      credential_verified_at timestamptz NOT NULL,
      public_code text NOT NULL
        CHECK (public_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$'),
      started_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at > started_at),
      delivery_generation integer NOT NULL CHECK (delivery_generation BETWEEN 1 AND 5),
      resend_available_at timestamptz NOT NULL,
      proof_digest bytea CHECK (proof_digest IS NULL OR octet_length(proof_digest) = 32),
      proof_expires_at timestamptz,
      wrong_proof_attempts integer NOT NULL DEFAULT 0 CHECK (wrong_proof_attempts BETWEEN 0 AND 4),
      retention_claim_token uuid,
      retention_claim_expires_at timestamptz,
      CHECK ((proof_digest IS NULL) = (proof_expires_at IS NULL)),
      CHECK (proof_expires_at IS NULL OR proof_expires_at <= expires_at),
      CHECK ((retention_claim_token IS NULL) = (retention_claim_expires_at IS NULL))
    );
    CREATE INDEX browser_pairing_email_workflow_expiry_idx
      ON browser_pairing_email_workflows (expires_at, id);
    CREATE INDEX browser_pairing_email_workflow_user_idx
      ON browser_pairing_email_workflows (user_id, id);

    CREATE TABLE browser_pairing_email_delivery_intents (
      id uuid PRIMARY KEY,
      workflow_id uuid NOT NULL REFERENCES browser_pairing_email_workflows(id) ON DELETE CASCADE,
      generation integer NOT NULL CHECK (generation BETWEEN 1 AND 5),
      email_address text NOT NULL
        CHECK (email_address = lower(btrim(email_address))),
      status text NOT NULL CHECK (status IN (
        'pending', 'claimed', 'armed', 'sent', 'rejected', 'uncertain', 'superseded'
      )),
      idempotency_key uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL,
      claim_token uuid,
      claim_expires_at timestamptz,
      CHECK ((status IN ('claimed', 'armed')) =
        (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)),
      UNIQUE (workflow_id, generation)
    );
    CREATE INDEX browser_pairing_email_delivery_claimable_idx
      ON browser_pairing_email_delivery_intents (created_at, id)
      WHERE status IN ('pending', 'claimed', 'armed');

    CREATE TABLE browser_pairing_email_start_requests (
      id uuid PRIMARY KEY,
      pairing_id uuid NOT NULL REFERENCES browser_login_pairings(id) ON DELETE CASCADE,
      address_lookup_key text NOT NULL CHECK (address_lookup_key ~ '^[0-9a-f]{64}$'),
      requested_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at > requested_at),
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('pending', 'claimed')),
      claim_token uuid,
      claim_expires_at timestamptz,
      CHECK ((status = 'claimed') =
        (user_id IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL))
    );
    CREATE INDEX browser_pairing_email_start_request_claimable_idx
      ON browser_pairing_email_start_requests (requested_at, id)
      WHERE status IN ('pending', 'claimed');

    CREATE TABLE email_pairing_login_admission_scopes (
      scope_key text PRIMARY KEY CHECK (scope_key ~ '^[0-9a-f]{64}$'),
      scope_kind text NOT NULL CHECK (scope_kind IN ('address', 'source', 'pairing')),
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX email_pairing_login_admission_expiry_idx
      ON email_pairing_login_admission_scopes (expires_at, scope_key);

    CREATE TABLE email_pairing_login_admission_attempts (
      scope_key text NOT NULL REFERENCES email_pairing_login_admission_scopes(scope_key)
        ON DELETE CASCADE,
      attempted_at timestamptz NOT NULL
    );
    CREATE INDEX email_pairing_login_attempt_scope_time_idx
      ON email_pairing_login_admission_attempts (scope_key, attempted_at DESC);
  `;

  yield* sql`
    ALTER TABLE verified_email_credential_authentication_lookups ENABLE ROW LEVEL SECURITY;
    ALTER TABLE verified_email_credential_authentication_lookups FORCE ROW LEVEL SECURITY;
    CREATE POLICY verified_email_credential_authentication_lookups_by_user
      ON verified_email_credential_authentication_lookups
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

    ALTER TABLE browser_pairing_email_workflows ENABLE ROW LEVEL SECURITY;
    ALTER TABLE browser_pairing_email_workflows FORCE ROW LEVEL SECURITY;
    CREATE POLICY browser_pairing_email_workflows_by_user ON browser_pairing_email_workflows
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

    ALTER TABLE browser_pairing_email_delivery_intents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE browser_pairing_email_delivery_intents FORCE ROW LEVEL SECURITY;
    CREATE POLICY browser_pairing_email_delivery_intents_by_user
      ON browser_pairing_email_delivery_intents
      USING (EXISTS (
        SELECT 1 FROM browser_pairing_email_workflows workflow
        WHERE workflow.id = workflow_id
          AND workflow.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      )) WITH CHECK (EXISTS (
        SELECT 1 FROM browser_pairing_email_workflows workflow
        WHERE workflow.id = workflow_id
          AND workflow.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ));

    ALTER TABLE browser_pairing_email_start_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE browser_pairing_email_start_requests FORCE ROW LEVEL SECURITY;
    CREATE POLICY browser_pairing_email_start_requests_context
      ON browser_pairing_email_start_requests
      USING (
        (user_id IS NULL AND NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
        OR user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ) WITH CHECK (
        (user_id IS NULL AND NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
        OR user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      );

    ALTER TABLE email_pairing_login_admission_scopes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE email_pairing_login_admission_scopes FORCE ROW LEVEL SECURITY;
    CREATE POLICY email_pairing_login_admission_scopes_anonymous
      ON email_pairing_login_admission_scopes
      USING (NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
      WITH CHECK (NULLIF(current_setting('fidy.user_id', true), '') IS NULL);

    ALTER TABLE email_pairing_login_admission_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE email_pairing_login_admission_attempts FORCE ROW LEVEL SECURITY;
    CREATE POLICY email_pairing_login_admission_attempts_anonymous
      ON email_pairing_login_admission_attempts
      USING (NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
      WITH CHECK (NULLIF(current_setting('fidy.user_id', true), '') IS NULL);
  `;

  const existingCredentials = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ userId: Schema.String, emailAddress: EmailAddress }),
    execute: () => sql`
      SELECT user_id::text AS "userId", email_address AS "emailAddress"
      FROM verified_email_credentials credential WHERE NOT EXISTS (
        SELECT 1 FROM verified_email_credential_authentication_lookups lookup
        WHERE lookup.user_id = credential.user_id
      )
    `,
  })(undefined);
  yield* Effect.forEach(existingCredentials, ({ userId, emailAddress }) =>
    Effect.gen(function* () {
      const lookupKey = yield* emailCredentialLookupKey(emailAddress);
      yield* sql`
        INSERT INTO verified_email_credential_authentication_lookups (
          user_id, authentication_lookup_key
        ) VALUES (${userId}, ${lookupKey})
        ON CONFLICT (user_id) DO NOTHING
      `;
    })
  );
  yield* sql`
    CREATE FUNCTION fidy_claim_browser_pairing_email_start_request(
      timestamptz, uuid, timestamptz
    ) RETURNS TABLE (request_id uuid, user_id uuid, claim_token uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
    DECLARE candidate_id uuid;
    BEGIN
      DELETE FROM browser_pairing_email_start_requests request
      WHERE request.expires_at <= $1;

      SELECT request.id INTO candidate_id
      FROM browser_pairing_email_start_requests request
      WHERE request.status = 'pending'
        OR (request.status = 'claimed' AND request.claim_expires_at <= $1)
      ORDER BY request.requested_at, request.id
      FOR UPDATE SKIP LOCKED LIMIT 1;

      IF candidate_id IS NULL THEN RETURN; END IF;

      DELETE FROM browser_pairing_email_start_requests request
      WHERE request.id = candidate_id AND NOT EXISTS (
        SELECT 1 FROM verified_email_credential_authentication_lookups lookup
        WHERE lookup.authentication_lookup_key = request.address_lookup_key
      );
      IF FOUND THEN
        RETURN QUERY SELECT candidate_id, NULL::uuid, NULL::uuid;
        RETURN;
      END IF;

      RETURN QUERY
          UPDATE browser_pairing_email_start_requests request SET
            user_id = lookup.user_id, status = 'claimed', claim_token = $2,
            claim_expires_at = $3
          FROM verified_email_credential_authentication_lookups lookup
          WHERE request.id = candidate_id
            AND lookup.authentication_lookup_key = request.address_lookup_key
          RETURNING request.id, request.user_id, request.claim_token;
    END
    $$;

    CREATE FUNCTION fidy_resolve_browser_pairing_email_workflow_owner(uuid)
    RETURNS TABLE (workflow_id uuid, user_id uuid, expires_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      SELECT workflow.id, workflow.user_id, workflow.expires_at
      FROM browser_pairing_email_workflows workflow
      WHERE workflow.pairing_id = $1
      LIMIT 1
    $$;

    CREATE FUNCTION fidy_claim_browser_pairing_email_delivery(timestamptz, uuid, timestamptz)
    RETURNS TABLE (intent_id uuid, user_id uuid, claim_token uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      WITH reconciled AS (
        UPDATE browser_pairing_email_delivery_intents intent SET
          status = 'uncertain', claim_token = NULL, claim_expires_at = NULL
        FROM browser_pairing_email_workflows workflow
        WHERE intent.workflow_id = workflow.id AND intent.status = 'armed'
          AND intent.claim_expires_at <= $1
        RETURNING intent.id
      ), candidate AS (
        SELECT intent.id FROM browser_pairing_email_delivery_intents intent
        JOIN browser_pairing_email_workflows workflow ON workflow.id = intent.workflow_id
        WHERE intent.status = 'pending'
          OR (intent.status = 'claimed' AND intent.claim_expires_at <= $1
            AND workflow.proof_digest IS NULL)
        ORDER BY intent.created_at, intent.id FOR UPDATE OF intent SKIP LOCKED LIMIT 1
      )
      UPDATE browser_pairing_email_delivery_intents intent SET
        status = 'claimed', claim_token = $2, claim_expires_at = $3
      FROM candidate, browser_pairing_email_workflows workflow
      WHERE intent.id = candidate.id AND workflow.id = intent.workflow_id
      RETURNING intent.id, workflow.user_id, intent.claim_token
    $$;

    CREATE FUNCTION fidy_claim_expired_browser_pairing_email_workflow(
      timestamptz, uuid, timestamptz
    ) RETURNS TABLE (workflow_id uuid, user_id uuid, claim_token uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      UPDATE browser_pairing_email_workflows workflow SET
        retention_claim_token = $2, retention_claim_expires_at = $3
      FROM (
        SELECT candidate.id FROM browser_pairing_email_workflows candidate
        WHERE candidate.expires_at <= $1
          AND (candidate.retention_claim_token IS NULL
            OR candidate.retention_claim_expires_at <= $1)
        ORDER BY candidate.expires_at, candidate.id FOR UPDATE SKIP LOCKED LIMIT 1
      ) claimed
      WHERE workflow.id = claimed.id
      RETURNING workflow.id, workflow.user_id, workflow.retention_claim_token
    $$;

    CREATE FUNCTION fidy_purge_email_pairing_login_admission_evidence(timestamptz)
    RETURNS bigint LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      WITH expired AS (
        SELECT scope_key FROM email_pairing_login_admission_scopes
        WHERE expires_at <= $1 ORDER BY expires_at, scope_key LIMIT 1000
        FOR UPDATE SKIP LOCKED
      ), deleted AS (
        DELETE FROM email_pairing_login_admission_scopes scope USING expired
        WHERE scope.scope_key = expired.scope_key RETURNING 1
      ) SELECT count(*) FROM deleted
    $$;
  `;

  yield* sql`
    GRANT SELECT ON verified_email_credentials,
    verified_email_credential_authentication_lookups, browser_login_pairings TO fidy_gateway;
    GRANT SELECT, UPDATE ON browser_pairing_email_workflows TO fidy_gateway;
    GRANT SELECT, UPDATE ON browser_pairing_email_delivery_intents TO fidy_gateway;
    GRANT SELECT, UPDATE, DELETE ON browser_pairing_email_start_requests TO fidy_gateway;
    GRANT SELECT, UPDATE, DELETE ON email_pairing_login_admission_scopes TO fidy_gateway;
    GRANT SELECT, DELETE ON email_pairing_login_admission_attempts TO fidy_gateway;
  `;
  yield* sql`ALTER FUNCTION fidy_claim_browser_pairing_email_start_request(timestamptz, uuid, timestamptz) OWNER TO fidy_gateway`;
  yield* sql`ALTER FUNCTION fidy_resolve_browser_pairing_email_workflow_owner(uuid) OWNER TO fidy_gateway`;
  yield* sql`ALTER FUNCTION fidy_claim_browser_pairing_email_delivery(timestamptz, uuid, timestamptz) OWNER TO fidy_gateway`;
  yield* sql`ALTER FUNCTION fidy_claim_expired_browser_pairing_email_workflow(timestamptz, uuid, timestamptz) OWNER TO fidy_gateway`;
  yield* sql`ALTER FUNCTION fidy_purge_email_pairing_login_admission_evidence(timestamptz) OWNER TO fidy_gateway`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_claim_browser_pairing_email_start_request(timestamptz, uuid, timestamptz) FROM PUBLIC`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_resolve_browser_pairing_email_workflow_owner(uuid) FROM PUBLIC`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_claim_browser_pairing_email_delivery(timestamptz, uuid, timestamptz) FROM PUBLIC`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_claim_expired_browser_pairing_email_workflow(timestamptz, uuid, timestamptz) FROM PUBLIC`;
  yield* sql`REVOKE ALL ON FUNCTION fidy_purge_email_pairing_login_admission_evidence(timestamptz) FROM PUBLIC`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_claim_browser_pairing_email_start_request(timestamptz, uuid, timestamptz) TO fidy_runtime`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_resolve_browser_pairing_email_workflow_owner(uuid) TO fidy_runtime`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_claim_browser_pairing_email_delivery(timestamptz, uuid, timestamptz) TO fidy_runtime`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_claim_expired_browser_pairing_email_workflow(timestamptz, uuid, timestamptz) TO fidy_runtime`;
  yield* sql`GRANT EXECUTE ON FUNCTION fidy_purge_email_pairing_login_admission_evidence(timestamptz) TO fidy_runtime`;
  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON verified_email_credential_authentication_lookups TO fidy_runtime;
  GRANT SELECT, INSERT, UPDATE, DELETE ON browser_pairing_email_workflows TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON browser_pairing_email_delivery_intents TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON browser_pairing_email_start_requests TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_pairing_login_admission_scopes TO fidy_runtime;
    GRANT SELECT, INSERT, DELETE ON email_pairing_login_admission_attempts TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
