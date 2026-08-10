import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds a bounded, complete-or-absent trace context to each durable inbound message. */
export const whatsappDurablePropagation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE whatsapp_inbound_jobs
      ADD COLUMN trace_version integer,
      ADD COLUMN trace_id text,
      ADD COLUMN parent_span_id text,
      ADD COLUMN trace_sampled boolean,
      ADD COLUMN trace_captured_at bigint,
      ADD COLUMN processing_attempt integer NOT NULL DEFAULT 0
        CHECK (processing_attempt >= 0 AND processing_attempt <= 100),
      ADD CONSTRAINT whatsapp_inbound_jobs_trace_complete_or_absent CHECK (
        (trace_version IS NULL AND trace_id IS NULL AND parent_span_id IS NULL
          AND trace_sampled IS NULL AND trace_captured_at IS NULL)
        OR
        (trace_version IS NOT NULL AND trace_id IS NOT NULL AND parent_span_id IS NOT NULL
          AND trace_sampled IS NOT NULL AND trace_captured_at IS NOT NULL
          AND trace_version = 1
          AND trace_id ~ '^[0-9a-f]{32}$'
          AND parent_span_id ~ '^[0-9a-f]{16}$'
          AND trace_captured_at >= 0 AND trace_captured_at <= 8640000000000000)
      )
  `;
}).pipe(Effect.asVoid);
