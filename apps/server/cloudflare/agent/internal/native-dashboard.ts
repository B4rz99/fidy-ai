import { Schema } from "effect";
import { hostedSessionIdleMilliseconds } from "../../../src/core/agent/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { HostedDashboardAdmission } from "../contract";

/** Exact pending Turn and recorded tool call only; the caller must compose current channel and Consent authority in the same native unit. */
export const prepareHostedDashboardTurn = ({
  admission,
  current,
}: Readonly<{
  admission: HostedDashboardAdmission;
  current: number;
}>): OwnedStatement => {
  const subject = admission.subject;
  if (Schema.encodeSync(Schema.fromJsonString(Schema.Json))(admission.input) !== "{}") {
    return { sql: "SELECT NULL WHERE 0", params: [] };
  }
  const channel =
    subject._tag === "Browser"
      ? { sql: "t.inbound_message_id IS NULL", params: [] }
      : {
          sql: "t.inbound_message_id IS NOT NULL AND t.inbound_portfolio_id=? AND t.inbound_bsuid=?",
          params: [subject.portfolioId, subject.bsuid],
        };
  return {
    sql: `SELECT t.id FROM hosted_turns t JOIN hosted_agent_sessions s ON s.id=t.hosted_session_id AND s.user_id=t.user_id
      WHERE t.id=? AND t.user_id=? AND t.status='pending' AND t.proposal_text IS NULL
      AND s.status='active' AND max(coalesce(s.last_activity_at_ms,s.started_at_ms),t.started_at_ms)>?
      AND (${channel.sql})
      AND EXISTS (SELECT 1 FROM transcript_entries e WHERE e.user_id=t.user_id AND e.turn_id=t.id
        AND e.hosted_session_id=t.hosted_session_id AND e.kind='tool_call' AND e.iteration=?
        AND e.tool_call_id=? AND e.operation='dashboard.getDashboardView' AND e.input_json='{}')
      AND NOT EXISTS (SELECT 1 FROM transcript_entries e WHERE e.user_id=t.user_id AND e.turn_id=t.id
        AND e.kind='tool_result' AND e.tool_call_id=?)`,
    params: [
      admission.turnId,
      subject.userId,
      current - hostedSessionIdleMilliseconds,
      ...channel.params,
      admission.iteration,
      admission.toolCallId,
      admission.toolCallId,
    ],
  };
};
