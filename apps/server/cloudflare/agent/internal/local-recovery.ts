import { waitForDocument } from "./local-document-reply";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { hostedTranscriptRetentionMs } from "../contract";
import { type LocalTurn, Turn } from "./local-turn";
import { appendEntry, entryIdentity } from "./local-turn-store";
import { executeTurn } from "./local-inference";

const finish = Effect.fn(function* (
  turn: LocalTurn,
  reason: "interrupted" | "failed",
  now: number
) {
  const sql = yield* SqliteClient;
  const marked =
    yield* sql`UPDATE hosted_turns SET state=${reason},terminal_ms=${now},receipt_digest=NULL,receipt_value=NULL,answer=NULL WHERE id=${turn.id} AND user_id=${turn.user_id} AND state IN ('queued','running','proposed') RETURNING id`;
  if (marked.length === 0) return;
  const identity = entryIdentity(turn.id)(now);
  yield* appendEntry(
    turn.session_id,
    reason === "interrupted"
      ? { ...identity, _tag: "InterruptedTurnTranscriptEntry" }
      : { ...identity, _tag: "FailedTurnTranscriptEntry", reason: "HostedInferenceFailed" }
  );
  yield* sql`UPDATE hosted_agent_sessions SET active_ms=${now} WHERE id=${turn.session_id}`;
});
export const inspectTurns = Effect.fn(function* (current: number, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;
  const [row] = yield* sql`SELECT min(at) AS at FROM (
   SELECT CASE WHEN state='queued' THEN min(deadline_ms,max(${current},coalesce((SELECT offer_ms FROM hosted_whatsapp_inbound i WHERE i.turn_id=t.id),0))) ELSE deadline_ms END AS at FROM hosted_turns t WHERE state IN ('queued','running','proposed')
   UNION ALL SELECT min(i.offer_ms) FROM hosted_whatsapp_inbound i JOIN hosted_turns t ON t.id=i.turn_id AND t.user_id=i.user_id WHERE t.state='proposed' AND NOT EXISTS(SELECT 1 FROM whatsapp_deliveries w WHERE w.user_id=t.user_id AND w.family='hosted' AND w.operation_id=t.id AND w.started_ms IS NOT NULL)
   UNION ALL SELECT min(terminal_ms)+${hostedTranscriptRetentionMs} AS at FROM hosted_turns WHERE terminal_ms IS NOT NULL
 )`;
  return typeof row?.at === "number"
    ? yield* preserveStoreAlarm(storage, Math.max(current, row.at))
    : false;
});
const claim = Effect.fn(function* (storage: DurableObjectStorage, owns: (id: string) => boolean) {
  const sql = yield* SqliteClient,
    current = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM hosted_turns WHERE id IN (SELECT id FROM hosted_turns WHERE terminal_ms<=${current - hostedTranscriptRetentionMs} ORDER BY terminal_ms LIMIT 32)`;
  yield* sql`DELETE FROM hosted_agent_sessions WHERE id IN (SELECT id FROM hosted_agent_sessions WHERE active_ms<=${current - hostedTranscriptRetentionMs} AND NOT EXISTS(SELECT 1 FROM hosted_turns WHERE session_id=hosted_agent_sessions.id) LIMIT 32)`;
  const [pending] =
    yield* sql`SELECT * FROM hosted_turns WHERE state IN ('queued','running','proposed') LIMIT 1`;
  if (pending === undefined) {
    yield* inspectTurns(current, storage);
    return Option.none();
  }
  const turn = yield* Schema.decodeUnknownEffect(Turn)(pending);
  if (!owns(turn.user_id)) return Option.none();
  if (turn.deadline_ms <= current) {
    yield* finish(turn, "interrupted", current);
    yield* inspectTurns(current, storage);
    return Option.none();
  }
  yield* preserveStoreAlarm(storage, turn.deadline_ms);
  if (pending.state === "queued" && (yield* waitForDocument(turn, current, storage))) {
    return Option.none();
  }
  const marked =
    yield* sql`UPDATE hosted_turns SET state='running' WHERE id=${turn.id} AND state='queued' RETURNING id`;
  return marked.length === 0 ? Option.none() : Option.some(turn);
});
export const recoverTurns = Effect.fn(function* (
  env: Parameters<typeof executeTurn>[0],
  storage: DurableObjectStorage,
  owns: (id: string) => boolean
) {
  const next = yield* claim(storage, owns).pipe(withStoreCapacity("required"));
  if (Option.isNone(next)) return { attempted: 0, failed: 0 };
  const held = next.value;
  const attempt = yield* executeTurn(env, held, storage).pipe(Effect.result);
  if (attempt._tag === "Failure") {
    const current = yield* Clock.currentTimeMillis;
    yield* finish(held, "failed", current).pipe(withStoreCapacity("required"));
    yield* inspectTurns(current, storage);
  }
  return { attempted: 1, failed: 0 };
});
