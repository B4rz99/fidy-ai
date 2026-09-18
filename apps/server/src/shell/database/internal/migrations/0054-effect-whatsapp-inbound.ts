import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Replaces WhatsApp Turn claims and polling with durable queue publication and User-keyed Cluster
 * execution. Deployment drains old workers before this migration and starts new workers afterward.
 */
export const effectWhatsAppInbound = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Keep infrastructure DDL under the migration credential; Effect's runtime
  // store will observe this migration as already applied.
  yield* sql`CREATE TABLE IF NOT EXISTS fidy_durable.fidy_queue (
    sequence SERIAL PRIMARY KEY,
    id VARCHAR(36) NOT NULL,
    queue_name VARCHAR(100) NOT NULL,
    element TEXT NOT NULL,
    completed BOOLEAN NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_failure TEXT NULL,
    acquired_at TIMESTAMP NULL,
    acquired_by UUID NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_fidy_queue_id
    ON fidy_durable.fidy_queue (id, queue_name)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fidy_queue_take
    ON fidy_durable.fidy_queue (queue_name, completed, attempts, acquired_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_fidy_queue_update
    ON fidy_durable.fidy_queue (sequence, acquired_by)`;
  yield* sql`CREATE TABLE IF NOT EXISTS fidy_durable.fidy_queue_migrations (
    migration_id INTEGER PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL
  )`;
  yield* sql`INSERT INTO fidy_durable.fidy_queue_migrations (migration_id, name)
    VALUES (1, 'create_table') ON CONFLICT (migration_id) DO NOTHING`;
  yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE
    ON fidy_durable.fidy_queue TO fidy_runtime`;
  yield* sql`GRANT USAGE, SELECT
    ON SEQUENCE fidy_durable.fidy_queue_sequence_seq TO fidy_runtime`;
  yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE
    ON fidy_durable.fidy_queue_migrations TO fidy_runtime`;

  yield* sql`DROP FUNCTION fidy_claim_whatsapp_turn(timestamptz)`;
  yield* sql`DROP INDEX whatsapp_pending_jobs_by_user`;
  yield* sql`ALTER TABLE whatsapp_inbound_jobs
    ADD COLUMN turn_id uuid,
    ADD COLUMN terminal_outcome text
      CHECK (terminal_outcome IN ('delivered', 'agent_failed', 'send_failed', 'ambiguous_crash'))`;

  // Preserve already selected legacy burst identities, and publish one stable trigger per selected
  // burst (or per still-unselected message) before removing the claim lifecycle.
  yield* sql`UPDATE whatsapp_inbound_jobs SET turn_id = claim_id
    WHERE completed_at IS NULL AND claim_id IS NOT NULL`;
  yield* sql`INSERT INTO fidy_durable.fidy_queue
    (id, queue_name, element, completed, attempts, created_at, updated_at)
    SELECT trigger.id::text, 'whatsapp-inbound-turn',
      jsonb_build_object(
        'version', 1,
        'userId', trigger.user_id,
        'inboundJobId', trigger.id
      )::text,
      FALSE, 0, now(), now()
    FROM (
      SELECT DISTINCT ON (user_id, coalesce(claim_id, id)) id, user_id
      FROM whatsapp_inbound_jobs
      WHERE completed_at IS NULL
      ORDER BY user_id, coalesce(claim_id, id), enqueued_at, message_evidence_id
    ) AS trigger
    ON CONFLICT (id, queue_name) DO NOTHING`;

  yield* sql`ALTER TABLE whatsapp_inbound_jobs DROP CONSTRAINT whatsapp_inbound_jobs_claim_id_fkey`;
  yield* sql`ALTER TABLE whatsapp_inbound_jobs DROP COLUMN claim_id`;
  yield* sql`CREATE INDEX whatsapp_pending_jobs_by_user
    ON whatsapp_inbound_jobs(user_id, debounce_until, enqueued_at, message_evidence_id)
    WHERE completed_at IS NULL AND turn_id IS NULL`;
  yield* sql`CREATE INDEX whatsapp_jobs_by_turn
    ON whatsapp_inbound_jobs(user_id, turn_id, enqueued_at, message_evidence_id)
    WHERE turn_id IS NOT NULL`;
  yield* sql`DROP TABLE whatsapp_turn_claims`;
});
