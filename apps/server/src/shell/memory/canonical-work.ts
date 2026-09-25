import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { liveWebSessionAuthority } from "~/shell/identity/browser-runtime";
import type { MemoryOperationId } from "./operations";

type BrowserMemorySubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;

/** Every operation whose durable Memory work is attributable to a stable User. */
export type MemoryAuditOperation = MemoryOperationId;
/** Closed outcome vocabulary for one audited Memory call. */
export type MemoryAuditOutcome = "success" | "not_found" | "validation_failed" | "resource_limit";

/**
 * Count one browser Memory call only for its live User-owned WebSession. `afterMutation` additionally
 * requires the preceding owner mutation in the same D1 unit to have changed a row, so a skipped
 * mutation cannot be audited as accepted.
 */
export const recordBrowserMemoryWork = ({
  subject,
  input,
}: Readonly<{
  subject: BrowserMemorySubject;
  input: Readonly<{
    id: string;
    operation: MemoryAuditOperation;
    outcome: MemoryAuditOutcome;
    afterMutation: boolean;
    current: number;
  }>;
}>): OwnedStatement => {
  const authority = liveWebSessionAuthority({ subject, current: input.current });
  return {
    sql: `INSERT INTO memory_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
      SELECT ?,user_id,id,?,?,? FROM ${authority.table} WHERE ${authority.predicate}
      ${input.afterMutation ? "AND changes() = 1" : ""}`,
    params: [input.id, input.operation, input.outcome, input.current, ...authority.bindings],
  };
};

/** The Memory owner refuses a mutation whose final guarded AuditLogEntry changed no row. */
export const memoryCompletion = `INSERT INTO memory_atomic_assertion (id, accepted)
VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;
