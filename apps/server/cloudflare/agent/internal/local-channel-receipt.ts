import { HostedPauseNotice } from "../../insights/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Data, Effect, Schema } from "effect";
import {
  AgentIteration,
  HostedAgentSessionId,
  type TranscriptEntry,
  TranscriptText,
  TranscriptTurnId,
} from "../../../src/core/agent/contract";
import { appendEntry, entryIdentity } from "./local-turn-store";

const Entry = Data.taggedEnum<TranscriptEntry>();

export const foldHostedReceipt = Effect.fn(function* (user: string, id: string) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT t.state,t.session_id,t.id,t.answer,t.proposal_iteration,w.state AS delivery,w.delivered_at_ms AS at FROM hosted_whatsapp_inbound i JOIN hosted_turns t ON t.id=i.turn_id AND t.user_id=i.user_id JOIN whatsapp_deliveries w ON w.operation_id=t.id AND w.user_id=t.user_id AND w.correlation=i.correlation AND w.family='hosted' WHERE t.user_id=${user} AND t.id=${id}`;

  if (row === undefined) return false;

  if (row.state !== "proposed" || row.delivery !== "delivered") return true;

  const value = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      session_id: HostedAgentSessionId,
      id: TranscriptTurnId,
      answer: TranscriptText,
      at: Schema.Int,
      proposal_iteration: AgentIteration,
    })
  )(row);

  yield* appendEntry(
    value.session_id,
    Entry.AssistantTranscriptEntry({
      ...entryIdentity(value.id)(value.at),
      text: value.answer,
      iteration: value.proposal_iteration,
    })
  );
  yield* sql`UPDATE hosted_turns SET state='completed',terminal_ms=${value.at} WHERE user_id=${user} AND id=${value.id} AND state='proposed'`;
  yield* (yield* HostedPauseNotice).acknowledge(value.id);
  yield* sql`UPDATE hosted_agent_sessions SET active_ms=max(active_ms,${value.at}) WHERE user_id=${user} AND id=${value.session_id}`;

  return true;
});
