import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Drained-worker cutover: retains provider evidence and removes the legacy executor. */
export const effectWhatsAppDisclosure = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DROP FUNCTION fidy_claim_whatsapp_disclosure_delivery(uuid,uuid,text,timestamptz);
    DROP FUNCTION fidy_release_whatsapp_disclosure_claim(uuid,uuid);
    DROP FUNCTION fidy_find_due_whatsapp_disclosure_retry(timestamptz);
    DROP FUNCTION fidy_claim_whatsapp_disclosure_retry(uuid,uuid,text,timestamptz);
    DROP FUNCTION fidy_mark_whatsapp_disclosure_attempt_started(uuid,uuid,text,timestamptz);
    DROP FUNCTION fidy_find_whatsapp_disclosure_delivery_state(uuid);
    DROP FUNCTION fidy_find_whatsapp_disclosure_attempt_by_correlation(text);
    DROP FUNCTION fidy_record_whatsapp_disclosure_attempt_failure(uuid,uuid,text,text,text,timestamptz,boolean,timestamptz);
    CREATE TABLE whatsapp_consent_disclosure_requests (
      exchange_id uuid PRIMARY KEY,
      expires_at timestamptz NOT NULL,
      business_phone_number_id text NOT NULL CHECK (length(business_phone_number_id) BETWEEN 1 AND 256),
      sandbox_phone text CHECK (sandbox_phone ~ '^[+][1-9][0-9]{6,14}$')
    );
    REVOKE ALL ON whatsapp_consent_disclosure_requests FROM PUBLIC, fidy_runtime;
    GRANT SELECT, INSERT, DELETE ON whatsapp_consent_disclosure_requests TO fidy_gateway;
    INSERT INTO whatsapp_consent_disclosure_requests(exchange_id, expires_at, business_phone_number_id)
      SELECT DISTINCT ON (a.exchange_id) a.exchange_id, e.expires_at, a.business_phone_number_id
      FROM whatsapp_consent_disclosure_delivery_attempts a
      JOIN pending_consent_exchanges e ON e.id = a.exchange_id
      WHERE a.business_phone_number_id IS NOT NULL ORDER BY a.exchange_id, a.attempt_number DESC;
    DELETE FROM whatsapp_consent_disclosure_delivery_attempts WHERE status = 'claimed';
    DROP INDEX consent_disclosure_one_active_attempt;
    DROP INDEX consent_disclosure_due_retries;
    ALTER TABLE whatsapp_consent_disclosure_delivery_attempts
      DROP CONSTRAINT whatsapp_consent_disclosure_delivery_attempts_status_check,
      DROP CONSTRAINT whatsapp_consent_disclosure_delivery_attempts_check,
      DROP CONSTRAINT whatsapp_consent_disclosure_delivery_attempts_check3,
      ADD COLUMN retryable boolean NOT NULL DEFAULT false,
      ADD COLUMN evidence_revision integer NOT NULL DEFAULT 0 CHECK (evidence_revision >= 0);
    UPDATE whatsapp_consent_disclosure_delivery_attempts SET
      retryable = status = 'retry-scheduled',
      status = CASE WHEN status = 'started' THEN 'reconciliation-required'
        WHEN status = 'retry-scheduled' THEN 'definitively-failed' ELSE status END;
    ALTER TABLE whatsapp_consent_disclosure_delivery_attempts
      DROP COLUMN claim_expires_at, DROP COLUMN retry_at,
      ADD CHECK (status IN ('started','reconciliation-required','delivered','definitively-failed','retry-exhausted')),
      ADD CHECK (started_at IS NOT NULL),
      ADD UNIQUE(exchange_id, attempt_number);
    CREATE UNIQUE INDEX consent_disclosure_one_active_attempt
      ON whatsapp_consent_disclosure_delivery_attempts(exchange_id)
      WHERE status IN ('started','reconciliation-required');
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_lock_whatsapp_disclosure(target_exchange_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
      SELECT 1 FROM public.pending_consent_exchanges WHERE id = target_exchange_id FOR UPDATE
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_lock_whatsapp_disclosure(uuid) FROM PUBLIC;
    ALTER FUNCTION fidy_lock_whatsapp_disclosure(uuid) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_lock_whatsapp_disclosure(uuid) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_request_whatsapp_disclosure(target_exchange_id uuid, phone_id text, sandbox text, at_time timestamptz) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
    BEGIN
      PERFORM public.fidy_lock_whatsapp_disclosure(target_exchange_id);
      IF NOT EXISTS (SELECT 1 FROM public.pending_consent_exchanges WHERE id = target_exchange_id
        AND lifecycle = 'awaiting-disclosure-delivery' AND expires_at > at_time) THEN RETURN false; END IF;
      INSERT INTO public.whatsapp_consent_disclosure_requests
        SELECT target_exchange_id, expires_at, phone_id, sandbox
        FROM public.pending_consent_exchanges WHERE id = target_exchange_id
        ON CONFLICT DO NOTHING;
      RETURN true;
    END
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_request_whatsapp_disclosure(uuid,text,text,timestamptz) FROM PUBLIC;
    ALTER FUNCTION fidy_request_whatsapp_disclosure(uuid,text,text,timestamptz) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_request_whatsapp_disclosure(uuid,text,text,timestamptz) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_find_whatsapp_disclosure_request(target_exchange_id uuid, at_time timestamptz) RETURNS TABLE(business_phone_number_id text, sandbox_phone text)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
      SELECT r.business_phone_number_id, r.sandbox_phone FROM public.whatsapp_consent_disclosure_requests r
      JOIN public.pending_consent_exchanges e ON e.id = r.exchange_id
      WHERE e.id = target_exchange_id AND e.lifecycle = 'awaiting-disclosure-delivery' AND e.expires_at > at_time
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_find_whatsapp_disclosure_request(uuid,timestamptz) FROM PUBLIC;
    ALTER FUNCTION fidy_find_whatsapp_disclosure_request(uuid,timestamptz) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_find_whatsapp_disclosure_request(uuid,timestamptz) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_find_pending_whatsapp_disclosure_requests(at_time timestamptz, after_id uuid) RETURNS TABLE(exchange_id uuid)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
      SELECT r.exchange_id FROM public.whatsapp_consent_disclosure_requests r
      JOIN public.pending_consent_exchanges e ON e.id = r.exchange_id
      WHERE e.lifecycle = 'awaiting-disclosure-delivery' AND e.expires_at > at_time
        AND (after_id IS NULL OR r.exchange_id > after_id)
      ORDER BY r.exchange_id LIMIT 100
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_find_pending_whatsapp_disclosure_requests(timestamptz,uuid) FROM PUBLIC;
    ALTER FUNCTION fidy_find_pending_whatsapp_disclosure_requests(timestamptz,uuid) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_find_pending_whatsapp_disclosure_requests(timestamptz,uuid) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_arm_whatsapp_disclosure_attempt(target_exchange_id uuid, target_attempt_id uuid, target_hash text, ordinal integer, at_time timestamptz) RETURNS TABLE(attempt_id uuid, attempt_number integer)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
    DECLARE previous public.whatsapp_consent_disclosure_delivery_attempts%ROWTYPE;
    BEGIN
      PERFORM public.fidy_lock_whatsapp_disclosure(target_exchange_id);
      IF ordinal NOT BETWEEN 1 AND 4 OR NOT EXISTS (
        SELECT 1 FROM public.pending_consent_exchanges e JOIN public.whatsapp_consent_disclosure_requests r ON r.exchange_id = e.id
        WHERE e.id = target_exchange_id AND e.lifecycle = 'awaiting-disclosure-delivery' AND e.expires_at > at_time
      ) THEN RETURN; END IF;
      SELECT prior.* INTO previous FROM public.whatsapp_consent_disclosure_delivery_attempts prior
        WHERE prior.exchange_id = target_exchange_id ORDER BY prior.attempt_number DESC LIMIT 1 FOR UPDATE;
      IF FOUND THEN
        IF previous.attempt_number + 1 <> ordinal OR previous.status <> 'definitively-failed'
          OR NOT previous.retryable OR previous.failure_certainty <> 'rejected'
          OR previous.failure_occurred_at > at_time THEN RETURN; END IF;
      ELSIF ordinal <> 1 THEN RETURN;
      END IF;
      INSERT INTO public.whatsapp_consent_disclosure_delivery_attempts
        (id,exchange_id,correlation_hash,business_phone_number_id,status,attempt_number,started_at)
        SELECT target_attempt_id,target_exchange_id,target_hash,r.business_phone_number_id,'started',ordinal,at_time
        FROM public.whatsapp_consent_disclosure_requests r WHERE r.exchange_id = target_exchange_id;
      RETURN QUERY SELECT target_attempt_id, ordinal;
    END
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_arm_whatsapp_disclosure_attempt(uuid,uuid,text,integer,timestamptz) FROM PUBLIC;
    ALTER FUNCTION fidy_arm_whatsapp_disclosure_attempt(uuid,uuid,text,integer,timestamptz) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_arm_whatsapp_disclosure_attempt(uuid,uuid,text,integer,timestamptz) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_find_whatsapp_disclosure_delivery_state(target_exchange_id uuid) RETURNS TABLE(attempt_id uuid,state text,reason text,attempt_number integer,retryable boolean,failure_occurred_at timestamptz,evidence_revision integer)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
      SELECT id,status,safe_reason,attempt_number,retryable,failure_occurred_at,evidence_revision
      FROM public.whatsapp_consent_disclosure_delivery_attempts WHERE exchange_id = target_exchange_id
      ORDER BY attempt_number DESC LIMIT 1
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_find_whatsapp_disclosure_delivery_state(uuid) FROM PUBLIC;
    ALTER FUNCTION fidy_find_whatsapp_disclosure_delivery_state(uuid) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_find_whatsapp_disclosure_delivery_state(uuid) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_find_whatsapp_disclosure_attempt_by_correlation(target_correlation_token text) RETURNS TABLE(exchange_id uuid,attempt_id uuid,attempt_number integer,state text,evidence_revision integer)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
      SELECT exchange_id,id,attempt_number,status,evidence_revision
      FROM public.whatsapp_consent_disclosure_delivery_attempts WHERE correlation_hash = target_correlation_token
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_find_whatsapp_disclosure_attempt_by_correlation(text) FROM PUBLIC;
    ALTER FUNCTION fidy_find_whatsapp_disclosure_attempt_by_correlation(text) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_find_whatsapp_disclosure_attempt_by_correlation(text) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_record_whatsapp_disclosure_attempt_accepted(target_exchange_id uuid, target_attempt_id uuid, target_correlation_token text, target_provider_message_id text, target_accepted_at timestamptz) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
    BEGIN
      PERFORM public.fidy_lock_whatsapp_disclosure(target_exchange_id);
      UPDATE public.whatsapp_consent_disclosure_delivery_attempts attempt SET status = 'reconciliation-required', provider_message_id = target_provider_message_id, evidence_revision = evidence_revision + 1
        WHERE           id = target_attempt_id AND exchange_id = target_exchange_id
          AND correlation_hash = target_correlation_token
          AND EXISTS (SELECT 1 FROM public.whatsapp_consent_disclosure_requests request
            JOIN public.pending_consent_exchanges owner ON owner.id = request.exchange_id
            WHERE request.exchange_id = target_exchange_id AND owner.lifecycle = 'awaiting-disclosure-delivery')
          AND NOT EXISTS (SELECT 1 FROM public.whatsapp_consent_disclosure_delivery_attempts successor
            WHERE successor.exchange_id = target_exchange_id AND successor.attempt_number > attempt.attempt_number)
          AND (provider_message_id IS NULL OR provider_message_id = target_provider_message_id)
          AND target_accepted_at >= date_trunc('second', started_at)
          AND status = 'started' AND latest_evidence_at IS NULL
;
      RETURN FOUND;
    END
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_record_whatsapp_disclosure_attempt_accepted(uuid,uuid,text,text,timestamptz) FROM PUBLIC;
    ALTER FUNCTION fidy_record_whatsapp_disclosure_attempt_accepted(uuid,uuid,text,text,timestamptz) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_record_whatsapp_disclosure_attempt_accepted(uuid,uuid,text,text,timestamptz) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_record_whatsapp_disclosure_attempt_sent(target_exchange_id uuid, target_attempt_id uuid, target_correlation_token text, target_provider_message_id text, target_occurred_at timestamptz) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
    BEGIN
      PERFORM public.fidy_lock_whatsapp_disclosure(target_exchange_id);
      UPDATE public.whatsapp_consent_disclosure_delivery_attempts attempt SET status = 'reconciliation-required', provider_message_id = target_provider_message_id, evidence_revision = evidence_revision + 1, latest_evidence_at = target_occurred_at, retryable = false
        WHERE           id = target_attempt_id AND exchange_id = target_exchange_id
          AND correlation_hash = target_correlation_token
          AND EXISTS (SELECT 1 FROM public.whatsapp_consent_disclosure_requests request
            JOIN public.pending_consent_exchanges owner ON owner.id = request.exchange_id
            WHERE request.exchange_id = target_exchange_id AND owner.lifecycle = 'awaiting-disclosure-delivery')
          AND NOT EXISTS (SELECT 1 FROM public.whatsapp_consent_disclosure_delivery_attempts successor
            WHERE successor.exchange_id = target_exchange_id AND successor.attempt_number > attempt.attempt_number)
          AND (provider_message_id IS NULL OR provider_message_id = target_provider_message_id)
          AND target_occurred_at >= date_trunc('second', started_at)
          AND status IN ('started','reconciliation-required','definitively-failed','retry-exhausted')
          AND target_occurred_at >= COALESCE(latest_evidence_at, '-infinity'::timestamptz)
          AND NOT (status = 'reconciliation-required' AND latest_evidence_at IS NOT NULL AND provider_message_id IS NOT DISTINCT FROM target_provider_message_id AND latest_evidence_at = target_occurred_at)
;
      RETURN FOUND;
    END
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_record_whatsapp_disclosure_attempt_sent(uuid,uuid,text,text,timestamptz) FROM PUBLIC;
    ALTER FUNCTION fidy_record_whatsapp_disclosure_attempt_sent(uuid,uuid,text,text,timestamptz) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_record_whatsapp_disclosure_attempt_sent(uuid,uuid,text,text,timestamptz) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_record_whatsapp_disclosure_attempt_delivered(target_exchange_id uuid, target_attempt_id uuid, target_correlation_token text, target_provider_message_id text, target_delivered_at timestamptz) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
    BEGIN
      PERFORM public.fidy_lock_whatsapp_disclosure(target_exchange_id);
      UPDATE public.whatsapp_consent_disclosure_delivery_attempts attempt SET status = 'delivered', provider_message_id = target_provider_message_id, evidence_revision = evidence_revision + 1, latest_evidence_at = target_delivered_at, retryable = false, delivered_at = target_delivered_at
        WHERE           id = target_attempt_id AND exchange_id = target_exchange_id
          AND correlation_hash = target_correlation_token
          AND EXISTS (SELECT 1 FROM public.whatsapp_consent_disclosure_requests request
            JOIN public.pending_consent_exchanges owner ON owner.id = request.exchange_id
            WHERE request.exchange_id = target_exchange_id AND owner.lifecycle = 'awaiting-disclosure-delivery')
          AND NOT EXISTS (SELECT 1 FROM public.whatsapp_consent_disclosure_delivery_attempts successor
            WHERE successor.exchange_id = target_exchange_id AND successor.attempt_number > attempt.attempt_number)
          AND (provider_message_id IS NULL OR provider_message_id = target_provider_message_id)
          AND target_delivered_at >= date_trunc('second', started_at)
          AND status IN ('started','reconciliation-required','definitively-failed','retry-exhausted')
          AND target_delivered_at >= COALESCE(latest_evidence_at, '-infinity'::timestamptz)
;
      RETURN FOUND;
    END
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_record_whatsapp_disclosure_attempt_delivered(uuid,uuid,text,text,timestamptz) FROM PUBLIC;
    ALTER FUNCTION fidy_record_whatsapp_disclosure_attempt_delivered(uuid,uuid,text,text,timestamptz) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_record_whatsapp_disclosure_attempt_delivered(uuid,uuid,text,text,timestamptz) TO fidy_runtime;
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_record_whatsapp_disclosure_attempt_failure(target_exchange_id uuid, target_attempt_id uuid, target_correlation_token text, target_reason text, target_certainty text, target_occurred_at timestamptz, target_provider_evidence boolean, target_retryable boolean, target_provider_message_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
    BEGIN
      PERFORM public.fidy_lock_whatsapp_disclosure(target_exchange_id);
      UPDATE public.whatsapp_consent_disclosure_delivery_attempts attempt SET
        status = CASE WHEN target_certainty = 'ambiguous' THEN 'reconciliation-required'
          WHEN attempt_number = 4 AND target_retryable THEN 'retry-exhausted' ELSE 'definitively-failed' END,
        safe_reason = target_reason, failure_certainty = target_certainty,
        provider_message_id = COALESCE(provider_message_id, target_provider_message_id),
        failure_occurred_at = target_occurred_at,
        latest_evidence_at = CASE WHEN target_provider_evidence THEN target_occurred_at ELSE latest_evidence_at END,
        retryable = target_certainty = 'rejected' AND target_retryable,
        evidence_revision = evidence_revision + 1
      WHERE           id = target_attempt_id AND exchange_id = target_exchange_id
          AND correlation_hash = target_correlation_token
          AND EXISTS (SELECT 1 FROM public.whatsapp_consent_disclosure_requests request
            JOIN public.pending_consent_exchanges owner ON owner.id = request.exchange_id
            WHERE request.exchange_id = target_exchange_id AND owner.lifecycle = 'awaiting-disclosure-delivery')
          AND NOT EXISTS (SELECT 1 FROM public.whatsapp_consent_disclosure_delivery_attempts successor
            WHERE successor.exchange_id = target_exchange_id AND successor.attempt_number > attempt.attempt_number)

        AND status IN ('started','reconciliation-required')
        AND target_certainty IN ('rejected','ambiguous')
        AND (NOT target_provider_evidence OR target_provider_message_id IS NOT NULL)
        AND (target_provider_evidence OR target_provider_message_id IS NULL)
        AND (provider_message_id IS NULL OR provider_message_id = target_provider_message_id)
        AND (target_provider_evidence OR (status = 'started' AND latest_evidence_at IS NULL))
        AND target_occurred_at >= date_trunc('second', started_at)
        AND target_occurred_at >= COALESCE(latest_evidence_at, '-infinity'::timestamptz)
        AND NOT (safe_reason IS NOT DISTINCT FROM target_reason
          AND failure_certainty IS NOT DISTINCT FROM target_certainty
          AND failure_occurred_at IS NOT DISTINCT FROM target_occurred_at);
      RETURN FOUND;
    END
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_record_whatsapp_disclosure_attempt_failure(uuid,uuid,text,text,text,timestamptz,boolean,boolean,text) FROM PUBLIC;
    ALTER FUNCTION fidy_record_whatsapp_disclosure_attempt_failure(uuid,uuid,text,text,text,timestamptz,boolean,boolean,text) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_record_whatsapp_disclosure_attempt_failure(uuid,uuid,text,text,text,timestamptz,boolean,boolean,text) TO fidy_runtime;
  `;
  yield* sql`
    CREATE FUNCTION fidy_find_expired_whatsapp_disclosure_requests(at_time timestamptz)
    RETURNS TABLE(exchange_id uuid) LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      SELECT r.exchange_id FROM public.whatsapp_consent_disclosure_requests r
      WHERE r.expires_at <= at_time OR NOT EXISTS (
        SELECT 1 FROM public.pending_consent_exchanges e WHERE e.id = r.exchange_id
      ) ORDER BY r.expires_at, r.exchange_id LIMIT 100
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_find_expired_whatsapp_disclosure_requests(timestamptz) FROM PUBLIC;
    ALTER FUNCTION fidy_find_expired_whatsapp_disclosure_requests(timestamptz) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_find_expired_whatsapp_disclosure_requests(timestamptz) TO fidy_runtime;

    CREATE FUNCTION fidy_remove_whatsapp_disclosure_request(target_exchange_id uuid)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
    BEGIN
      PERFORM public.fidy_lock_whatsapp_disclosure(target_exchange_id);
      DELETE FROM public.whatsapp_consent_disclosure_delivery_attempts WHERE exchange_id = target_exchange_id;
      DELETE FROM public.whatsapp_consent_disclosure_requests WHERE exchange_id = target_exchange_id;
    END
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_remove_whatsapp_disclosure_request(uuid) FROM PUBLIC;
    ALTER FUNCTION fidy_remove_whatsapp_disclosure_request(uuid) OWNER TO fidy_gateway;
    GRANT EXECUTE ON FUNCTION fidy_remove_whatsapp_disclosure_request(uuid) TO fidy_runtime;
  `;
}).pipe(Effect.asVoid);
