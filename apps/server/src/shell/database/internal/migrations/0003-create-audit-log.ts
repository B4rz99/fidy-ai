import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// AuditLogEntries are append-only security evidence. WebSession and Hosted Agent Session
// attribution intentionally have no foreign keys, so audit and credential retention lifecycles
// remain independent.
export const createAuditLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE audit_log_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id),
      pat_id uuid REFERENCES tokens(id),
      web_session_id uuid,
      hosted_agent_session_id uuid,
      operation text NOT NULL CHECK (
        operation ~ '^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$'
      ),
      outcome text NOT NULL CHECK (outcome IN ('succeeded', 'rejected', 'failed')),
      occurred_at timestamptz NOT NULL,
      CONSTRAINT audit_log_entries_exactly_one_caller
        CHECK (num_nonnulls(pat_id, web_session_id, hosted_agent_session_id) = 1)
    )
  `;

  yield* sql`
    CREATE INDEX audit_log_entries_user_occurred_at_idx
      ON audit_log_entries (user_id, occurred_at)
  `;
}).pipe(Effect.asVoid);
