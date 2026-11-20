import { Option } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { StatementDecisionWork } from "../contract";

export const statementOriginGuard = ({
  work,
  submission,
}: Readonly<{ work: StatementDecisionWork; submission: string }>): OwnedStatement =>
  Option.match(work.originSessionId, {
    onNone: () => ({
      sql: `NOT EXISTS (SELECT 1 FROM statement_submissions WHERE hosted_session_id IS NOT NULL AND id = ${submission})`,
      params: [],
    }),
    onSome: (sessionId) =>
      Option.match(work.originTurns, {
        onNone: () => ({ sql: "0 = 1", params: [] }),
        onSome: (turns) => ({
          sql: `EXISTS (SELECT 1 FROM statement_submissions WHERE hosted_session_id IS NOT NULL AND id = ${submission} AND user_id = ? AND hosted_session_id = ? AND hosted_abandoned_at_ms IS NULL AND hosted_expires_at_ms > ? AND hosted_turn_id IN (${turns.sql}))`,
          params: [work.userId, sessionId, work.current, ...turns.params],
        }),
      }),
  });
