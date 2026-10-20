import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

const pairingWindowMs = 3_600_000;
const replacementWindowMs = 86_400_000;

/** Independent mailbox policies share persistence; pairing still aborts its whole batch at capacity. */
export const prepareEmailSecurityLimit = (
  input: Readonly<{
    db: D1Database;
    subject: OwnedStatement;
    current: number;
  }> &
    (
      | Readonly<{ kind: "pairing" | "pairing-global" }>
      | Readonly<{ kind: "replacement"; workId: string }>
    )
): D1PreparedStatement => {
  const cutoff =
    input.current - (input.kind === "replacement" ? replacementWindowMs : pairingWindowMs);
  return input.db
    .prepare(`INSERT INTO email_security_limits
    (kind,user_id,window_started_at_ms,requests,last_work_id)
    SELECT ?,${input.kind === "pairing-global" ? "NULL" : "user_id"},?,1,? FROM (${input.subject.sql}) WHERE true
    ON CONFLICT${input.kind === "pairing-global" ? "(kind) WHERE kind='pairing-global'" : "(kind,user_id)"} DO UPDATE SET
      window_started_at_ms=CASE WHEN window_started_at_ms<=? THEN excluded.window_started_at_ms ELSE window_started_at_ms END,
      requests=CASE WHEN window_started_at_ms<=? THEN 1 ELSE requests+1 END,
      last_work_id=excluded.last_work_id
    WHERE email_security_limits.kind IN ('pairing','pairing-global') OR requests<5 OR window_started_at_ms<=?`)
    .bind(
      input.kind,
      input.current,
      input.kind === "replacement" ? input.workId : null,
      ...input.subject.params,
      cutoff,
      cutoff,
      cutoff
    );
};
