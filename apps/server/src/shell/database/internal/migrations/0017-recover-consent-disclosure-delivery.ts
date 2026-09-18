import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds private durable provider-attempt evidence, bounded retry, and webhook reconciliation. */
export const recoverConsentDisclosureDelivery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE pending_consent_exchanges
      DROP CONSTRAINT pending_consent_delivery_started_requires_claim,
      DROP CONSTRAINT pending_consent_delivery_claim_pair,
      DROP COLUMN disclosure_delivery_started_at,
      DROP COLUMN disclosure_delivery_claim_expires_at,
      DROP COLUMN disclosure_delivery_claim_id
  `;

  yield* sql`
    CREATE TABLE whatsapp_consent_disclosure_delivery_attempts (
      id uuid PRIMARY KEY,
      exchange_id uuid NOT NULL REFERENCES pending_consent_exchanges(id) ON DELETE CASCADE,
      correlation_hash text NOT NULL UNIQUE CHECK (correlation_hash ~ '^[0-9a-f]{64}$'),
      business_phone_number_id text,
      status text NOT NULL CHECK (status IN (
        'claimed', 'started', 'reconciliation-required', 'retry-scheduled',
        'delivered', 'definitively-failed', 'retry-exhausted'
      )),
      attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 4),
      claim_expires_at timestamptz NOT NULL,
      started_at timestamptz,
      safe_reason text CHECK (safe_reason IN (
        'sandbox_bsuid_unsupported', 'invalid_recipient', 'conversation_window_closed',
        'rate_limited', 'authentication_failed', 'provider_unavailable', 'timeout',
        'invalid_response'
      )),
      failure_certainty text CHECK (failure_certainty IN ('rejected', 'ambiguous')),
      failure_occurred_at timestamptz,
      latest_evidence_at timestamptz,
      retry_at timestamptz,
      provider_message_id text,
      delivered_at timestamptz,
      CHECK ((status = 'claimed') = (started_at IS NULL)),
      CHECK ((safe_reason IS NULL) = (failure_certainty IS NULL)),
      CHECK ((safe_reason IS NULL) = (failure_occurred_at IS NULL)),
      CHECK ((status = 'retry-scheduled') = (retry_at IS NOT NULL)),
      CHECK (status <> 'delivered' OR (provider_message_id IS NOT NULL AND delivered_at IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX consent_disclosure_one_active_attempt
    ON whatsapp_consent_disclosure_delivery_attempts(exchange_id)
    WHERE status IN ('claimed', 'started', 'reconciliation-required', 'retry-scheduled')
  `;
  yield* sql`
    CREATE INDEX consent_disclosure_due_retries
    ON whatsapp_consent_disclosure_delivery_attempts(retry_at, id)
    WHERE status = 'retry-scheduled'
  `;
  yield* sql`
    REVOKE UPDATE ON pending_consent_exchanges FROM fidy_runtime;
    REVOKE ALL ON whatsapp_consent_disclosure_delivery_attempts FROM fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON whatsapp_consent_disclosure_delivery_attempts TO fidy_gateway;
    GRANT SELECT, UPDATE ON pending_consent_exchanges TO fidy_gateway
  `;

  yield* sql`
    CREATE FUNCTION fidy_claim_whatsapp_disclosure_delivery(
      target_exchange_id uuid, target_attempt_id uuid, target_correlation_hash text,
      target_claimed_at timestamptz
    ) RETURNS TABLE (attempt_id uuid, attempt_number integer)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
    BEGIN
      DELETE FROM public.whatsapp_consent_disclosure_delivery_attempts
      WHERE exchange_id = target_exchange_id AND status = 'claimed'
        AND claim_expires_at <= target_claimed_at;
      PERFORM 1 FROM public.pending_consent_exchanges
      WHERE id = target_exchange_id AND lifecycle = 'awaiting-disclosure-delivery' FOR UPDATE;
      IF NOT FOUND OR EXISTS (
        SELECT 1 FROM public.whatsapp_consent_disclosure_delivery_attempts
        WHERE exchange_id = target_exchange_id
      ) THEN RETURN; END IF;
      INSERT INTO public.whatsapp_consent_disclosure_delivery_attempts (
        id, exchange_id, correlation_hash, status, attempt_number, claim_expires_at
      ) VALUES (
        target_attempt_id, target_exchange_id, target_correlation_hash,
        'claimed', 1, target_claimed_at + interval '30 seconds'
      );
      RETURN QUERY SELECT target_attempt_id, 1;
    END
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_claim_whatsapp_disclosure_delivery(uuid,uuid,text,timestamptz)
      FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_claim_whatsapp_disclosure_delivery(uuid,uuid,text,timestamptz)
      TO fidy_runtime;

    CREATE FUNCTION fidy_release_whatsapp_disclosure_claim(
      target_exchange_id uuid, target_attempt_id uuid
    ) RETURNS void LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      DELETE FROM public.whatsapp_consent_disclosure_delivery_attempts
      WHERE exchange_id = target_exchange_id AND id = target_attempt_id AND status = 'claimed'
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_release_whatsapp_disclosure_claim(uuid,uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_release_whatsapp_disclosure_claim(uuid,uuid) TO fidy_runtime;

    CREATE FUNCTION fidy_find_due_whatsapp_disclosure_retry(claimed_at timestamptz)
    RETURNS TABLE (
      exchange_id uuid, attempt_id uuid, attempt_number integer,
      business_phone_number_id text
    ) LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      SELECT attempt.exchange_id, attempt.id, attempt.attempt_number,
        attempt.business_phone_number_id
      FROM public.whatsapp_consent_disclosure_delivery_attempts AS attempt
      WHERE attempt.status = 'retry-scheduled' AND attempt.retry_at <= claimed_at
      ORDER BY attempt.retry_at, attempt.id FOR UPDATE SKIP LOCKED LIMIT 1
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_find_due_whatsapp_disclosure_retry(timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_find_due_whatsapp_disclosure_retry(timestamptz) TO fidy_runtime;

    CREATE FUNCTION fidy_find_whatsapp_disclosure_delivery_state(target_exchange_id uuid)
    RETURNS TABLE (attempt_id uuid, state text, reason text, attempt_number integer)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$
      SELECT attempt.id, attempt.status, attempt.safe_reason, attempt.attempt_number
      FROM public.whatsapp_consent_disclosure_delivery_attempts AS attempt
      WHERE attempt.exchange_id = target_exchange_id
      ORDER BY attempt.attempt_number DESC LIMIT 1
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_find_whatsapp_disclosure_delivery_state(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_find_whatsapp_disclosure_delivery_state(uuid) TO fidy_runtime;

    CREATE FUNCTION fidy_record_pending_consent_disclosure_delivery(
      target_exchange_id uuid, target_correlation_token uuid, target_channel text,
      target_provider text, target_provider_message_id text, target_delivered_at timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      WITH changed AS (
        UPDATE public.pending_consent_exchanges
        SET lifecycle = 'awaiting-decision', disclosure_channel = target_channel,
          disclosure_provider = target_provider,
          disclosure_provider_message_id = target_provider_message_id,
          disclosed_at = target_delivered_at
        WHERE id = target_exchange_id AND lifecycle = 'awaiting-disclosure-delivery'
          AND (
            target_channel <> 'whatsapp' OR EXISTS (
              SELECT 1 FROM public.whatsapp_consent_disclosure_delivery_attempts AS attempt
              WHERE attempt.exchange_id = target_exchange_id
                AND attempt.status = 'delivered'
                AND attempt.provider_message_id = target_provider_message_id
                AND attempt.delivered_at = target_delivered_at
            )
          )
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_record_pending_consent_disclosure_delivery(
      uuid, uuid, text, text, text, timestamptz
    ) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_record_pending_consent_disclosure_delivery(
      uuid, uuid, text, text, text, timestamptz
    ) TO fidy_runtime;

    CREATE FUNCTION fidy_find_whatsapp_disclosure_attempt_by_correlation(
      target_correlation_token text
    ) RETURNS TABLE (
      exchange_id uuid, attempt_id uuid, attempt_number integer, state text
    ) LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      SELECT attempt.exchange_id, attempt.id, attempt.attempt_number, attempt.status
      FROM public.whatsapp_consent_disclosure_delivery_attempts AS attempt
      WHERE attempt.correlation_hash = target_correlation_token
        AND (
          attempt.status IN ('started', 'reconciliation-required', 'retry-scheduled')
          OR (
            attempt.status = 'definitively-failed' AND EXISTS (
              SELECT 1
              FROM public.whatsapp_consent_disclosure_delivery_attempts AS successor
              WHERE successor.exchange_id = attempt.exchange_id
                AND successor.attempt_number = attempt.attempt_number + 1
                AND successor.status = 'claimed'
            )
          )
        )
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_find_whatsapp_disclosure_attempt_by_correlation(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_find_whatsapp_disclosure_attempt_by_correlation(text)
      TO fidy_runtime;

    CREATE FUNCTION fidy_mark_whatsapp_disclosure_attempt_started(
      target_exchange_id uuid, target_attempt_id uuid,
      target_business_phone_number_id text, target_started_at timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      WITH changed AS (
        UPDATE public.whatsapp_consent_disclosure_delivery_attempts
        SET status = 'started', started_at = target_started_at,
          business_phone_number_id = target_business_phone_number_id
        WHERE id = target_attempt_id AND exchange_id = target_exchange_id AND status = 'claimed'
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_mark_whatsapp_disclosure_attempt_started(
      uuid, uuid, text, timestamptz
    ) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_mark_whatsapp_disclosure_attempt_started(
      uuid, uuid, text, timestamptz
    ) TO fidy_runtime;

    CREATE FUNCTION fidy_record_whatsapp_disclosure_attempt_accepted(
      target_exchange_id uuid, target_attempt_id uuid, target_correlation_token text,
      target_provider_message_id text, target_accepted_at timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      WITH changed AS (
        UPDATE public.whatsapp_consent_disclosure_delivery_attempts
        SET status = 'reconciliation-required',
          provider_message_id = target_provider_message_id
        WHERE id = target_attempt_id AND exchange_id = target_exchange_id
          AND correlation_hash = target_correlation_token AND status = 'started'
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_record_whatsapp_disclosure_attempt_accepted(
      uuid, uuid, text, text, timestamptz
    ) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_record_whatsapp_disclosure_attempt_accepted(
      uuid, uuid, text, text, timestamptz
    ) TO fidy_runtime;

    CREATE FUNCTION fidy_record_whatsapp_disclosure_attempt_sent(
      target_exchange_id uuid, target_attempt_id uuid, target_correlation_token text,
      target_provider_message_id text, target_occurred_at timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      WITH changed AS (
        UPDATE public.whatsapp_consent_disclosure_delivery_attempts
        SET status = 'reconciliation-required',
          provider_message_id = COALESCE(provider_message_id, target_provider_message_id),
          latest_evidence_at = target_occurred_at, retry_at = NULL
        WHERE id = target_attempt_id AND exchange_id = target_exchange_id
          AND correlation_hash = target_correlation_token
          AND (provider_message_id IS NULL OR provider_message_id = target_provider_message_id)
          AND status IN ('started', 'reconciliation-required', 'retry-scheduled')
          AND target_occurred_at >= date_trunc('second', started_at)
          AND target_occurred_at >= COALESCE(latest_evidence_at, '-infinity'::timestamptz)
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_record_whatsapp_disclosure_attempt_sent(
      uuid, uuid, text, text, timestamptz
    ) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_record_whatsapp_disclosure_attempt_sent(
      uuid, uuid, text, text, timestamptz
    ) TO fidy_runtime;

    CREATE FUNCTION fidy_record_whatsapp_disclosure_attempt_failure(
      target_exchange_id uuid, target_attempt_id uuid, target_correlation_token text,
      target_reason text, target_certainty text, target_occurred_at timestamptz,
      target_provider_evidence boolean, target_retry_at timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      WITH changed AS (
        UPDATE public.whatsapp_consent_disclosure_delivery_attempts
        SET status = CASE
              WHEN target_certainty = 'ambiguous' THEN 'reconciliation-required'
              WHEN target_retry_at IS NOT NULL THEN 'retry-scheduled'
              WHEN attempt_number >= 4 THEN 'retry-exhausted'
              ELSE 'definitively-failed'
            END,
          safe_reason = target_reason, failure_certainty = target_certainty,
          failure_occurred_at = target_occurred_at,
          latest_evidence_at = CASE WHEN target_provider_evidence
            THEN target_occurred_at ELSE latest_evidence_at END,
          retry_at = target_retry_at
        WHERE id = target_attempt_id AND exchange_id = target_exchange_id
          AND correlation_hash = target_correlation_token
          AND status IN ('started', 'reconciliation-required')
          AND target_certainty IN ('rejected', 'ambiguous')
          AND (status = 'started' OR target_certainty = 'rejected')
          AND target_occurred_at >= date_trunc('second', started_at)
          AND (
            NOT target_provider_evidence OR target_occurred_at >= COALESCE(
              latest_evidence_at, '-infinity'::timestamptz
            )
          )
        RETURNING id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_record_whatsapp_disclosure_attempt_failure(
      uuid, uuid, text, text, text, timestamptz, boolean, timestamptz
    ) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_record_whatsapp_disclosure_attempt_failure(
      uuid, uuid, text, text, text, timestamptz, boolean, timestamptz
    ) TO fidy_runtime;

    CREATE FUNCTION fidy_record_whatsapp_disclosure_attempt_delivered(
      target_exchange_id uuid, target_attempt_id uuid, target_correlation_token text,
      target_provider_message_id text, target_delivered_at timestamptz
    ) RETURNS boolean LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      WITH candidate AS (
        SELECT attempt.id, attempt.exchange_id, attempt.attempt_number, attempt.status
        FROM public.whatsapp_consent_disclosure_delivery_attempts AS attempt
        WHERE attempt.id = target_attempt_id AND attempt.exchange_id = target_exchange_id
          AND attempt.correlation_hash = target_correlation_token
          AND (attempt.provider_message_id IS NULL
            OR attempt.provider_message_id = target_provider_message_id)
          AND target_delivered_at >= date_trunc('second', attempt.started_at)
          AND target_delivered_at >= COALESCE(
            attempt.latest_evidence_at, '-infinity'::timestamptz
          )
          AND attempt.status IN (
            'started', 'reconciliation-required', 'retry-scheduled', 'definitively-failed'
          )
        FOR UPDATE
      ), canceled AS (
        DELETE FROM public.whatsapp_consent_disclosure_delivery_attempts AS successor
        USING candidate
        WHERE candidate.status = 'definitively-failed'
          AND successor.exchange_id = candidate.exchange_id
          AND successor.attempt_number = candidate.attempt_number + 1
          AND successor.status = 'claimed'
        RETURNING successor.id
      ), changed AS (
        UPDATE public.whatsapp_consent_disclosure_delivery_attempts AS attempt
        SET status = 'delivered', provider_message_id = target_provider_message_id,
          delivered_at = target_delivered_at, latest_evidence_at = target_delivered_at,
          retry_at = NULL
        FROM candidate
        WHERE attempt.id = candidate.id
          AND (
            candidate.status IN ('started', 'reconciliation-required', 'retry-scheduled')
            OR NOT EXISTS (
              SELECT 1
              FROM public.whatsapp_consent_disclosure_delivery_attempts AS active
              WHERE active.exchange_id = candidate.exchange_id
                AND active.id <> candidate.id
                AND active.status IN (
                  'claimed', 'started', 'reconciliation-required', 'retry-scheduled'
                )
                AND NOT EXISTS (SELECT 1 FROM canceled WHERE canceled.id = active.id)
            )
          )
        RETURNING attempt.id
      ) SELECT EXISTS (SELECT 1 FROM changed)
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_record_whatsapp_disclosure_attempt_delivered(
      uuid, uuid, text, text, timestamptz
    ) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_record_whatsapp_disclosure_attempt_delivered(
      uuid, uuid, text, text, timestamptz
    ) TO fidy_runtime;

    CREATE FUNCTION fidy_claim_whatsapp_disclosure_retry(
      target_previous_attempt_id uuid, target_attempt_id uuid,
      target_correlation_token text, target_claimed_at timestamptz
    ) RETURNS TABLE (
      exchange_id uuid, attempt_number integer, business_phone_number_id text
    ) LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS \$function\$
      WITH retired AS (
        UPDATE public.whatsapp_consent_disclosure_delivery_attempts
        SET status = 'definitively-failed', retry_at = NULL
        WHERE id = target_previous_attempt_id AND status = 'retry-scheduled'
        RETURNING whatsapp_consent_disclosure_delivery_attempts.exchange_id,
          whatsapp_consent_disclosure_delivery_attempts.attempt_number,
          whatsapp_consent_disclosure_delivery_attempts.business_phone_number_id
      ), inserted AS (
        INSERT INTO public.whatsapp_consent_disclosure_delivery_attempts (
          id, exchange_id, correlation_hash, status, attempt_number, claim_expires_at,
          business_phone_number_id
        ) SELECT target_attempt_id, retired.exchange_id, target_correlation_token, 'claimed',
          retired.attempt_number + 1, target_claimed_at + interval '30 seconds',
          retired.business_phone_number_id FROM retired WHERE retired.attempt_number < 4
        RETURNING whatsapp_consent_disclosure_delivery_attempts.exchange_id,
          whatsapp_consent_disclosure_delivery_attempts.attempt_number,
          whatsapp_consent_disclosure_delivery_attempts.business_phone_number_id
      ) SELECT inserted.exchange_id, inserted.attempt_number,
          inserted.business_phone_number_id FROM inserted
    \$function\$;
    REVOKE ALL ON FUNCTION fidy_claim_whatsapp_disclosure_retry(
      uuid, uuid, text, timestamptz
    ) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_claim_whatsapp_disclosure_retry(
      uuid, uuid, text, timestamptz
    ) TO fidy_runtime;

  `;
}).pipe(Effect.asVoid);
