import { Option } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { StatementDecisionWork } from "../contract";

/** Credentials cannot resume a hosted clarification. Its live original conversation must match.
 * The column reference is a fixed owner SQL expression, never decoded from transport input.
 */
export const statementOriginGuard = ({
  work,
  submission,
}: Readonly<{ work: StatementDecisionWork; submission: string }>): OwnedStatement =>
  Option.match(work.originSessionId, {
    onNone: () => ({
      sql: `NOT EXISTS (SELECT 1 FROM statement_hosted_origins WHERE submission_id = ${submission})`,
      params: [],
    }),
    onSome: (sessionId) =>
      Option.match(work.originTurns, {
        onNone: () => ({ sql: "0 = 1", params: [] }),
        onSome: (turns) => ({
          sql: `EXISTS (SELECT 1 FROM statement_hosted_origins WHERE submission_id = ${submission} AND user_id = ? AND session_id = ? AND abandoned_at_ms IS NULL AND expires_at_ms > ? AND turn_id IN (${turns.sql}))`,
          params: [work.userId, sessionId, work.current, ...turns.params],
        }),
      }),
  });
