import { waitForDocument } from "./local-document-reply";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Predicate, Result, Schema } from "effect";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { hostedTranscriptRetentionMs } from "../contract";
import { Turn } from "./local-turn";
import { finishTurn } from "./local-turn-store";
import { executeTurn } from "./local-inference";

export const inspectTurns = Effect.fn(function* (current: number, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const [active] = yield* sql`SELECT min(at) AS at FROM (
   SELECT CASE WHEN state='queued' THEN min(deadline_ms,max(${current},coalesce((SELECT offer_ms FROM hosted_whatsapp_inbound i WHERE i.turn_id=t.id),0))) ELSE deadline_ms END AS at FROM hosted_turns t WHERE state IN ('queued','running','proposed')
   UNION ALL SELECT min(i.offer_ms) FROM hosted_whatsapp_inbound i JOIN hosted_turns t ON t.id=i.turn_id AND t.user_id=i.user_id WHERE t.state='proposed' AND NOT EXISTS(SELECT 1 FROM whatsapp_deliveries w WHERE w.user_id=t.user_id AND w.family='hosted' AND w.operation_id=t.id AND w.started_ms IS NOT NULL)
 )`;

  const [retention] = yield* sql`SELECT min(at) AS at FROM (
   SELECT min(terminal_ms)+${hostedTranscriptRetentionMs + 1} AS at FROM hosted_turns WHERE terminal_ms IS NOT NULL AND request_text<>''
   UNION ALL SELECT min(active_ms)+${hostedTranscriptRetentionMs + 1} FROM hosted_agent_sessions WHERE compacted_text IS NOT NULL
   UNION ALL SELECT min(day_ms)+${hostedTranscriptRetentionMs + 1} FROM hosted_compaction_budgets
   UNION ALL SELECT min(expires_ms)+1 FROM hosted_confirmations
 )`;

  const deadlines = [active?.at, retention?.at].filter(Predicate.isNumber);

  return deadlines.length > 0
    ? yield* preserveStoreAlarm(storage, Math.max(current, Math.min(...deadlines)))
    : false;
});

const expirePersonalTurnContent = Effect.fn(function* (now: number) {
  const sql = yield* SqliteClient,
    cutoff = now - hostedTranscriptRetentionMs;

  const due =
    yield* sql`SELECT id FROM hosted_turns WHERE terminal_ms<${cutoff} AND request_text<>'' ORDER BY terminal_ms,id LIMIT 32`;

  yield* Effect.forEach(
    due,
    Effect.fnUntraced(function* (row) {
      const id = yield* Schema.decodeUnknownEffect(Schema.String)(row.id);
      yield* sql`DELETE FROM hosted_transcript WHERE turn_id=${id}`;
      yield* sql`DELETE FROM hosted_whatsapp_inbound WHERE turn_id=${id}`;
      yield* sql`DELETE FROM hosted_confirmations WHERE issued_turn=${id}`;
      yield* sql`UPDATE hosted_turns SET request_text='',answer=NULL,receipt_digest=NULL,receipt_value=NULL,proposal_iteration=NULL WHERE id=${id}`;
    }),
    { discard: true }
  );

  yield* sql`UPDATE hosted_agent_sessions SET compacted_text=NULL,compacted_through=0 WHERE id IN(SELECT id FROM hosted_agent_sessions WHERE active_ms<${cutoff} AND compacted_text IS NOT NULL ORDER BY active_ms LIMIT 32)`;
  yield* sql`DELETE FROM hosted_compaction_budgets WHERE rowid IN(SELECT rowid FROM hosted_compaction_budgets WHERE day_ms<${cutoff} ORDER BY day_ms LIMIT 32)`;
  yield* sql`DELETE FROM hosted_confirmations WHERE issued_turn IN(SELECT issued_turn FROM hosted_confirmations WHERE expires_ms<${now} ORDER BY expires_ms LIMIT 32)`;
  yield* sql`DELETE FROM hosted_agent_sessions WHERE id IN(SELECT id FROM hosted_agent_sessions WHERE active_ms<${cutoff} AND NOT EXISTS(SELECT 1 FROM hosted_turns WHERE session_id=hosted_agent_sessions.id) LIMIT 32)`;
});

const claim = Effect.fn(function* (storage: DurableObjectStorage, owns: (id: string) => boolean) {
  const sql = yield* SqliteClient,
    current = yield* Clock.currentTimeMillis;

  yield* expirePersonalTurnContent(current);

  const [pending] =
    yield* sql`SELECT * FROM hosted_turns WHERE state IN ('queued','running','proposed') LIMIT 1`;

  if (pending === undefined) {
    yield* inspectTurns(current, storage);

    return Option.none();
  }

  const turn = yield* Schema.decodeUnknownEffect(Turn)(pending);

  if (!owns(turn.user_id)) return Option.none();

  if (
    turn.deadline_ms <= current ||
    (yield* sql`SELECT 1 FROM erasure_requests WHERE user_id=${turn.user_id}`).length === 1
  ) {
    yield* finishTurn({ turnId: turn.id, user: turn.user_id }, "interrupted", current);
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

  if (Result.isFailure(attempt)) {
    const current = yield* Clock.currentTimeMillis;
    yield* finishTurn({ turnId: held.id, user: held.user_id }, "failed", current).pipe(
      withStoreCapacity("required")
    );
    yield* inspectTurns(current, storage);
  }

  return { attempted: 1, failed: 0 };
});
