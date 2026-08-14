import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const createInboundQueueTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE whatsapp_message_evidence (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      provider_message_id text NOT NULL UNIQUE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      delivery_key text,
      occurred_at timestamptz NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE whatsapp_turn_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('claimed', 'started', 'failed')),
      claim_expires_at timestamptz NOT NULL,
      started_at timestamptz,
      failed_at timestamptz,
      safe_reason text CHECK (safe_reason IN ('lease_expired', 'ambiguous_crash', 'agent_failed', 'send_failed'))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX whatsapp_one_active_claim_per_user
    ON whatsapp_turn_claims(user_id) WHERE status IN ('claimed', 'started')
  `;
  yield* sql`
    CREATE TABLE whatsapp_inbound_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_evidence_id bigint NOT NULL UNIQUE REFERENCES whatsapp_message_evidence(id),
      content text,
      occurred_at timestamptz NOT NULL,
      enqueued_at timestamptz NOT NULL,
      debounce_until timestamptz NOT NULL,
      claim_id uuid REFERENCES whatsapp_turn_claims(id),
      completed_at timestamptz
    )
  `;
  yield* sql`
    CREATE INDEX whatsapp_pending_jobs_by_user
    ON whatsapp_inbound_jobs(user_id, debounce_until, occurred_at, message_evidence_id)
    WHERE completed_at IS NULL AND claim_id IS NULL
  `;
});

const createIngressBudgetTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE whatsapp_ingress_budgets (
      budget_key text PRIMARY KEY,
      window_started_at timestamptz NOT NULL,
      accepted_count integer NOT NULL CHECK (accepted_count > 0)
    )
  `;
  yield* sql`
    CREATE TABLE whatsapp_ingress_budget_receipts (
      budget_key text NOT NULL,
      provider_message_id text NOT NULL,
      consumed_at timestamptz NOT NULL,
      PRIMARY KEY (budget_key, provider_message_id)
    )
  `;
  yield* sql`
    CREATE INDEX whatsapp_ingress_budget_receipts_by_consumed_at
    ON whatsapp_ingress_budget_receipts(consumed_at)
  `;
});

const createReceiptAndWindowTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE whatsapp_inbound_receipts (
      provider_message_id text PRIMARY KEY,
      delivery_key text NOT NULL,
      status text NOT NULL CHECK (status IN ('processing', 'outbound_started', 'completed')),
      claim_id uuid NOT NULL,
      claim_expires_at timestamptz NOT NULL,
      first_received_at timestamptz NOT NULL,
      completed_at timestamptz
    )
  `;
  yield* sql`
    CREATE TABLE whatsapp_conversation_windows (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      identity_verified_at timestamptz NOT NULL,
      business_phone_number_id text NOT NULL,
      window_open_until timestamptz NOT NULL
    )
  `;
});

const restrictChannelTablesToOwner = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE whatsapp_message_evidence ENABLE ROW LEVEL SECURITY;
    ALTER TABLE whatsapp_message_evidence FORCE ROW LEVEL SECURITY;
    CREATE POLICY whatsapp_message_evidence_by_user ON whatsapp_message_evidence
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
    ALTER TABLE whatsapp_inbound_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE whatsapp_inbound_jobs FORCE ROW LEVEL SECURITY;
    CREATE POLICY whatsapp_inbound_jobs_by_user ON whatsapp_inbound_jobs
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
    ALTER TABLE whatsapp_turn_claims ENABLE ROW LEVEL SECURITY;
    ALTER TABLE whatsapp_turn_claims FORCE ROW LEVEL SECURITY;
    CREATE POLICY whatsapp_turn_claims_by_user ON whatsapp_turn_claims
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
    ALTER TABLE whatsapp_conversation_windows ENABLE ROW LEVEL SECURITY;
    ALTER TABLE whatsapp_conversation_windows FORCE ROW LEVEL SECURITY;
    CREATE POLICY whatsapp_conversation_windows_by_user ON whatsapp_conversation_windows
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
});

const grantChannelTableAuthority = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      whatsapp_message_evidence, whatsapp_inbound_jobs, whatsapp_turn_claims,
      whatsapp_conversation_windows
    TO fidy_runtime
  `;
  yield* sql`
    GRANT USAGE, SELECT ON SEQUENCE whatsapp_message_evidence_id_seq TO fidy_runtime
  `;

  yield* sql`GRANT SELECT, INSERT, UPDATE ON whatsapp_turn_claims TO fidy_gateway`;
  yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_ingress_budgets TO fidy_gateway`;
  yield* sql`GRANT SELECT, INSERT, DELETE ON whatsapp_ingress_budget_receipts TO fidy_gateway`;
  yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_inbound_receipts TO fidy_gateway`;
  yield* sql`GRANT SELECT, DELETE ON whatsapp_conversation_windows TO fidy_gateway`;
});

const createIngressBudgetGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE FUNCTION fidy_consume_whatsapp_budget(
      requested_key text, consumed_at timestamptz, maximum_count integer
    ) RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH pruned AS MATERIALIZED (
        DELETE FROM public.whatsapp_ingress_budgets
        WHERE window_started_at < consumed_at - interval '2 hours'
        RETURNING budget_key
      )
      INSERT INTO public.whatsapp_ingress_budgets(
        budget_key, window_started_at, accepted_count
      ) VALUES (requested_key, consumed_at, 1)
      ON CONFLICT (budget_key) DO UPDATE SET
        window_started_at = CASE
          WHEN public.whatsapp_ingress_budgets.window_started_at <= consumed_at - interval '1 hour'
          THEN consumed_at ELSE public.whatsapp_ingress_budgets.window_started_at END,
        accepted_count = CASE
          WHEN public.whatsapp_ingress_budgets.window_started_at <= consumed_at - interval '1 hour'
          THEN 1 ELSE public.whatsapp_ingress_budgets.accepted_count + 1 END
      WHERE public.whatsapp_ingress_budgets.window_started_at <= consumed_at - interval '1 hour'
         OR public.whatsapp_ingress_budgets.accepted_count < maximum_count
      RETURNING true
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_consume_whatsapp_budget(text, timestamptz, integer) OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_consume_whatsapp_budget(text, timestamptz, integer) FROM PUBLIC
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_consume_whatsapp_budget(text, timestamptz, integer) TO fidy_runtime
  `;
});

const createSingleUseIngressBudgetGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE FUNCTION fidy_consume_whatsapp_budget_once(
      requested_key text,
      requested_message_id text,
      consumed_at timestamptz,
      maximum_count integer
    ) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtextextended(requested_key || E'\n' || requested_message_id, 0)
      );
      IF EXISTS (
        SELECT 1 FROM public.whatsapp_ingress_budget_receipts
        WHERE budget_key = requested_key AND provider_message_id = requested_message_id
      ) THEN
        RETURN true;
      END IF;
      IF COALESCE(
        public.fidy_consume_whatsapp_budget(requested_key, consumed_at, maximum_count),
        false
      ) = false THEN
        RETURN false;
      END IF;
      INSERT INTO public.whatsapp_ingress_budget_receipts(
        budget_key, provider_message_id, consumed_at
      ) VALUES (requested_key, requested_message_id, consumed_at);
      RETURN true;
    END
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_consume_whatsapp_budget_once(text, text, timestamptz, integer)
    OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION
      fidy_consume_whatsapp_budget_once(text, text, timestamptz, integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION
      fidy_consume_whatsapp_budget_once(text, text, timestamptz, integer) TO fidy_runtime
  `;
});

const createOperationalPruningGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE FUNCTION fidy_prune_whatsapp_operational_data() RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      DELETE FROM public.whatsapp_ingress_budget_receipts
      WHERE consumed_at < statement_timestamp() - interval '2 hours';
      DELETE FROM public.whatsapp_ingress_budgets
      WHERE window_started_at < statement_timestamp() - interval '2 hours';
      DELETE FROM public.whatsapp_conversation_windows
      WHERE window_open_until < statement_timestamp();
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_prune_whatsapp_operational_data() OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_prune_whatsapp_operational_data() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_prune_whatsapp_operational_data() TO fidy_runtime
  `;
});

const createReceiptClaimGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE FUNCTION fidy_claim_whatsapp_receipt(
      requested_message_id text, requested_delivery_key text,
      requested_claim_id uuid, claimed_at timestamptz
    ) RETURNS text
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH claimed AS (
        INSERT INTO public.whatsapp_inbound_receipts(
          provider_message_id, delivery_key, status, claim_id,
          claim_expires_at, first_received_at
        ) VALUES (
          requested_message_id, requested_delivery_key, 'processing', requested_claim_id,
          claimed_at + interval '30 seconds', claimed_at
        )
        ON CONFLICT (provider_message_id) DO UPDATE SET
          delivery_key = EXCLUDED.delivery_key,
          claim_id = EXCLUDED.claim_id,
          claim_expires_at = EXCLUDED.claim_expires_at
        WHERE public.whatsapp_inbound_receipts.status = 'processing'
          AND public.whatsapp_inbound_receipts.claim_expires_at <= claimed_at
        RETURNING true
      )
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM claimed) THEN 'claimed'
        WHEN EXISTS (
          SELECT 1 FROM public.whatsapp_inbound_receipts
          WHERE provider_message_id = requested_message_id
            AND status IN ('outbound_started', 'completed')
        ) THEN 'completed'
        ELSE 'in_progress'
      END
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_claim_whatsapp_receipt(text, text, uuid, timestamptz) OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_claim_whatsapp_receipt(text, text, uuid, timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_claim_whatsapp_receipt(text, text, uuid, timestamptz) TO fidy_runtime
  `;
});

const createReceiptOutboundStartGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE FUNCTION fidy_mark_whatsapp_receipt_outbound_started(
      requested_message_id text, requested_claim_id uuid
    ) RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      UPDATE public.whatsapp_inbound_receipts
      SET status = 'outbound_started'
      WHERE provider_message_id = requested_message_id
        AND claim_id = requested_claim_id AND status = 'processing'
      RETURNING true
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_mark_whatsapp_receipt_outbound_started(text, uuid)
    OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_mark_whatsapp_receipt_outbound_started(text, uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_mark_whatsapp_receipt_outbound_started(text, uuid)
      TO fidy_runtime
  `;
});

const createReceiptReleaseGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE FUNCTION fidy_release_whatsapp_receipt(
      requested_message_id text, requested_claim_id uuid
    ) RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      DELETE FROM public.whatsapp_inbound_receipts
      WHERE provider_message_id = requested_message_id
        AND claim_id = requested_claim_id AND status = 'processing'
      RETURNING true
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_release_whatsapp_receipt(text, uuid) OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_release_whatsapp_receipt(text, uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_release_whatsapp_receipt(text, uuid) TO fidy_runtime
  `;
});

const createReceiptCompletionGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE FUNCTION fidy_complete_whatsapp_receipt(
      requested_message_id text, requested_claim_id uuid, completion_time timestamptz
    ) RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      UPDATE public.whatsapp_inbound_receipts
      SET status = 'completed', completed_at = completion_time
      WHERE provider_message_id = requested_message_id
        AND claim_id = requested_claim_id
        AND status IN ('processing', 'outbound_started')
      RETURNING true
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_complete_whatsapp_receipt(text, uuid, timestamptz) OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_complete_whatsapp_receipt(text, uuid, timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_complete_whatsapp_receipt(text, uuid, timestamptz) TO fidy_runtime
  `;
});

const createTurnClaimGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`GRANT SELECT, UPDATE ON whatsapp_inbound_jobs TO fidy_gateway`;
  yield* sql`
    CREATE FUNCTION fidy_claim_whatsapp_turn(claim_time timestamptz)
    RETURNS TABLE (claim_id uuid, subject_user_id uuid, claim_action text)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE
      selected_user uuid;
      selected_claim uuid;
    BEGIN
      SELECT turn.id, turn.user_id INTO selected_claim, selected_user
      FROM public.whatsapp_turn_claims AS turn
      WHERE turn.status = 'started' AND turn.claim_expires_at <= claim_time
      ORDER BY turn.claim_expires_at, turn.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1;

      IF selected_claim IS NOT NULL THEN
        RETURN QUERY SELECT selected_claim, selected_user, 'retire_ambiguous'::text;
        RETURN;
      END IF;

      WITH expired AS (
        UPDATE public.whatsapp_turn_claims
        SET status = 'failed', failed_at = claim_time, safe_reason = 'lease_expired'
        WHERE status = 'claimed' AND claim_expires_at <= claim_time
        RETURNING id
      )
      UPDATE public.whatsapp_inbound_jobs AS job
      SET claim_id = NULL
      FROM expired
      WHERE job.claim_id = expired.id AND job.completed_at IS NULL;

      SELECT due.user_id INTO selected_user
      FROM (
        SELECT job.user_id, min(job.enqueued_at) AS first_enqueued_at
        FROM public.whatsapp_inbound_jobs AS job
        WHERE job.completed_at IS NULL AND job.claim_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.whatsapp_turn_claims AS active
            WHERE active.user_id = job.user_id AND active.status IN ('claimed', 'started')
          )
        GROUP BY job.user_id
        HAVING max(job.debounce_until) <= claim_time
      ) AS due
      ORDER BY due.first_enqueued_at, due.user_id
      LIMIT 1;

      IF selected_user IS NULL THEN RETURN; END IF;
      IF NOT pg_try_advisory_xact_lock(hashtextextended(selected_user::text, 0)) THEN
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.whatsapp_turn_claims AS active
        WHERE active.user_id = selected_user AND active.status IN ('claimed', 'started')
      ) THEN
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.whatsapp_inbound_jobs AS pending
        WHERE pending.user_id = selected_user AND pending.completed_at IS NULL
          AND pending.claim_id IS NULL AND pending.debounce_until > claim_time
      ) THEN
        RETURN;
      END IF;

      INSERT INTO public.whatsapp_turn_claims(user_id, status, claim_expires_at)
      VALUES (selected_user, 'claimed', claim_time + interval '30 seconds')
      RETURNING id INTO selected_claim;

      UPDATE public.whatsapp_inbound_jobs AS job
      SET claim_id = selected_claim
      WHERE job.user_id = selected_user AND job.completed_at IS NULL AND job.claim_id IS NULL;

      RETURN QUERY SELECT selected_claim, selected_user, 'process'::text;
    END
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_claim_whatsapp_turn(timestamptz) OWNER TO fidy_gateway
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_claim_whatsapp_turn(timestamptz) FROM PUBLIC
  `;
  yield* sql`
    GRANT EXECUTE ON FUNCTION fidy_claim_whatsapp_turn(timestamptz) TO fidy_runtime
  `;
});

/** Adds the durable WhatsApp queue, evidence, window state, and narrow claim gateway. */
export const createWhatsAppChannel = Effect.gen(function* () {
  yield* createInboundQueueTables;
  yield* createIngressBudgetTables;
  yield* createReceiptAndWindowTables;
  yield* restrictChannelTablesToOwner;
  yield* grantChannelTableAuthority;
  yield* createIngressBudgetGateway;
  yield* createSingleUseIngressBudgetGateway;
  yield* createOperationalPruningGateway;
  yield* createReceiptClaimGateway;
  yield* createReceiptOutboundStartGateway;
  yield* createReceiptReleaseGateway;
  yield* createReceiptCompletionGateway;
  yield* createTurnClaimGateway;
}).pipe(Effect.asVoid);
