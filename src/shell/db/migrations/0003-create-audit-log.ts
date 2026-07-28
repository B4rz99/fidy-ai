import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// AuditLogEntries are append-only security evidence. Foreign keys preserve the
// stable User and AgentToken grant they attest; ordinary deletion cannot erase
// or orphan attribution.
export const createAuditLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE audit_log_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id),
      token_id uuid NOT NULL REFERENCES agent_tokens(id),
      operation text NOT NULL CHECK (
        operation ~ '^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$'
      ),
      outcome text NOT NULL CHECK (outcome IN ('succeeded', 'rejected', 'failed')),
      occurred_at timestamptz NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX audit_log_entries_user_occurred_at_idx
      ON audit_log_entries (user_id, occurred_at)
  `;
}).pipe(Effect.asVoid);
