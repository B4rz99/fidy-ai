import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Contracts the undeployed browser-email executor; Effect owns all new execution leases. */
export const effectPairingEmail = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DROP FUNCTION fidy_claim_browser_pairing_email_start_request(timestamptz, uuid, timestamptz);
    DROP FUNCTION fidy_claim_browser_pairing_email_delivery(timestamptz, uuid, timestamptz);
    DROP FUNCTION fidy_claim_expired_browser_pairing_email_workflow(timestamptz, uuid, timestamptz);
    DROP INDEX browser_pairing_email_start_request_claimable_idx;
    DROP INDEX browser_pairing_email_delivery_claimable_idx;
    ALTER TABLE browser_pairing_email_start_requests
      DROP COLUMN claim_token, DROP COLUMN claim_expires_at, DROP COLUMN status;
    ALTER TABLE browser_pairing_email_workflows
      DROP COLUMN retention_claim_token, DROP COLUMN retention_claim_expires_at;
    ALTER TABLE browser_pairing_email_delivery_intents
      DROP COLUMN claim_token, DROP COLUMN claim_expires_at, DROP COLUMN idempotency_key,
      DROP CONSTRAINT browser_pairing_email_delivery_intents_status_check,
      ADD CONSTRAINT pairing_email_delivery_status CHECK (status IN (
        'pending', 'armed', 'sent', 'rejected', 'uncertain', 'superseded', 'temporarily-refused', 'retry-exhausted'
      )),
      ADD COLUMN provider_attempt integer NOT NULL DEFAULT 0 CHECK (provider_attempt BETWEEN 0 AND 3),
      ADD COLUMN retry_at timestamptz;
    COMMENT ON COLUMN browser_pairing_email_delivery_intents.provider_attempt IS
      'Provider evidence fence: binds Armed/refusal evidence to one immutable send body, not an execution retry counter';
    CREATE FUNCTION fidy_resolve_browser_pairing_email_start_request(uuid, timestamptz)
    RETURNS TABLE (user_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    BEGIN
      PERFORM 1 FROM browser_pairing_email_start_requests request WHERE request.id = $1 FOR UPDATE;
      DELETE FROM browser_pairing_email_start_requests request WHERE request.id = $1 AND (
        request.expires_at <= $2 OR NOT EXISTS (
          SELECT 1 FROM verified_email_credential_authentication_lookups lookup
          WHERE lookup.authentication_lookup_key = request.address_lookup_key
            AND (request.user_id IS NULL OR lookup.user_id = request.user_id)
        )
      );
      RETURN QUERY UPDATE browser_pairing_email_start_requests request
        SET user_id = lookup.user_id
        FROM verified_email_credential_authentication_lookups lookup
        WHERE request.id = $1 AND lookup.authentication_lookup_key = request.address_lookup_key
          AND (request.user_id IS NULL OR request.user_id = lookup.user_id)
        RETURNING request.user_id;
    END $$;
    ALTER FUNCTION fidy_resolve_browser_pairing_email_start_request(uuid, timestamptz) OWNER TO fidy_gateway;
    REVOKE ALL ON FUNCTION fidy_resolve_browser_pairing_email_start_request(uuid, timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_resolve_browser_pairing_email_start_request(uuid, timestamptz) TO fidy_runtime;
  `;
}).pipe(Effect.asVoid);
