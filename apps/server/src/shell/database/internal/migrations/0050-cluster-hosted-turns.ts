import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Transfers submitted WhatsApp work to Cluster without retaining a channel execution deadline. */
export const clusterHostedTurns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE whatsapp_turn_claims DROP CONSTRAINT whatsapp_turn_claims_status_check`;
  yield* sql`ALTER TABLE whatsapp_turn_claims
    ADD CHECK (status IN ('claimed', 'started', 'submitted', 'failed')),
    ALTER COLUMN claim_expires_at DROP NOT NULL`;
  yield* sql`DROP INDEX whatsapp_one_active_claim_per_user`;
  yield* sql`CREATE UNIQUE INDEX whatsapp_one_active_claim_per_user ON whatsapp_turn_claims(user_id)
    WHERE status IN ('claimed', 'started', 'submitted')`;
  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_claim_whatsapp_turn(claim_time timestamptz)
    RETURNS TABLE (claim_id uuid, subject_user_id uuid, claim_action text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE selected_user uuid; selected_claim uuid;
    BEGIN
      SELECT turn.id, turn.user_id INTO selected_claim, selected_user
      FROM public.whatsapp_turn_claims AS turn
      WHERE turn.status = 'started' AND turn.claim_expires_at <= claim_time
      ORDER BY turn.claim_expires_at, turn.id FOR UPDATE SKIP LOCKED LIMIT 1;
      IF selected_claim IS NOT NULL THEN
        RETURN QUERY SELECT selected_claim, selected_user, 'retire_ambiguous'::text;
        RETURN;
      END IF;
      WITH expired AS (
        UPDATE public.whatsapp_turn_claims
        SET status = 'failed', failed_at = claim_time, safe_reason = 'lease_expired'
        WHERE status = 'claimed' AND claim_expires_at <= claim_time RETURNING id
      ) UPDATE public.whatsapp_inbound_jobs AS job SET claim_id = NULL FROM expired
        WHERE job.claim_id = expired.id AND job.completed_at IS NULL;
      SELECT due.user_id INTO selected_user FROM (
        SELECT job.user_id, min(job.enqueued_at) AS first_enqueued_at
        FROM public.whatsapp_inbound_jobs AS job
        WHERE job.completed_at IS NULL AND job.claim_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM public.whatsapp_turn_claims AS active
          WHERE active.user_id = job.user_id AND active.status IN ('claimed', 'started', 'submitted')
        ) GROUP BY job.user_id HAVING max(job.debounce_until) <= claim_time
      ) AS due ORDER BY due.first_enqueued_at, due.user_id LIMIT 1;
      IF selected_user IS NULL THEN RETURN; END IF;
      IF NOT pg_try_advisory_xact_lock(hashtextextended(selected_user::text, 0)) THEN RETURN; END IF;
      IF EXISTS (SELECT 1 FROM public.whatsapp_turn_claims AS active
        WHERE active.user_id = selected_user AND active.status IN ('claimed', 'started', 'submitted'))
        THEN RETURN; END IF;
      IF EXISTS (SELECT 1 FROM public.whatsapp_inbound_jobs AS pending
        WHERE pending.user_id = selected_user AND pending.completed_at IS NULL
          AND pending.claim_id IS NULL AND pending.debounce_until > claim_time) THEN RETURN; END IF;
      INSERT INTO public.whatsapp_turn_claims(user_id, status, claim_expires_at)
      VALUES (selected_user, 'claimed', claim_time + interval '30 seconds') RETURNING id INTO selected_claim;
      UPDATE public.whatsapp_inbound_jobs AS job SET claim_id = selected_claim
        WHERE job.user_id = selected_user AND job.completed_at IS NULL AND job.claim_id IS NULL;
      RETURN QUERY SELECT selected_claim, selected_user, 'process'::text;
    END
    $function$
  `;
});
