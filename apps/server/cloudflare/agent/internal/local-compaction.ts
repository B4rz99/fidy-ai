import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Predicate, Schema } from "effect";
import {
  CompactedConversationOutput,
  TranscriptEntry,
  TranscriptText,
} from "../../../src/core/agent/contract";
import {
  defaultCompactionMaximumTokens,
  shouldCompactConversation,
} from "../../../src/core/agent/operations";
import type { HostedInferenceService } from "../../../src/shell/hosted-inference/contract";
import type { SqlClient } from "effect/sql";
import type { StoreCapacity } from "../../runtime/sqlite/contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { type LocalTurn } from "./local-turn";
import { liveTurn } from "./local-turn-store";
import { AgentUnavailable } from "../contract";

const maximumRetainedEntries = 200;

const modelEntry = (entry: TranscriptEntry): TranscriptEntry =>
  Predicate.isTagged(entry, "UserTranscriptEntry") && entry.text.startsWith("CONFIRMAR ")
    ? { ...entry, text: TranscriptText.make("Confirmé la operación revisada.") }
    : entry;

const dayMs = 86400000;

export const continuity = Effect.fn(function* (turn: LocalTurn, mode: "full" | "prefix" = "full") {
  const sql = yield* SqliteClient;

  const [held] =
    yield* sql`SELECT compacted_text AS text,compacted_through AS cursor FROM hosted_agent_sessions WHERE user_id=${turn.user_id} AND id=${turn.session_id}`;

  const summary = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ text: Schema.NullOr(Schema.String), cursor: Schema.Int })
  )(held);

  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        sequence: Schema.Int,
        entry_json: Schema.fromJsonString(Schema.toCodecJson(TranscriptEntry)),
      })
    )
  )(
    yield* sql`SELECT e.sequence,e.entry_json FROM hosted_transcript e JOIN hosted_turns t ON t.id=e.turn_id AND t.session_id=e.session_id
    WHERE t.user_id=${turn.user_id} AND e.session_id=${turn.session_id} AND t.state IN ('completed','failed','interrupted') AND e.sequence>${summary.cursor} ORDER BY e.sequence LIMIT 201`
  );

  if (mode === "full" && rows.length > maximumRetainedEntries) return yield* new AgentUnavailable();
  const nextTurn = rows[maximumRetainedEntries]?.entry_json.turnId;

  return {
    summary,
    rows: rows
      .slice(0, maximumRetainedEntries)
      .filter((row) => row.entry_json.turnId !== nextTurn)
      .map((row) => ({ ...row, entry_json: modelEntry(row.entry_json) })),
  };
});

const reserve = Effect.fn(function* (turn: LocalTurn) {
  const now = yield* Clock.currentTimeMillis,
    sql = yield* SqliteClient;

  yield* liveTurn(turn, now);
  const day = Math.floor(now / dayMs) * dayMs;

  const granted =
    yield* sql`INSERT INTO hosted_compaction_budgets(user_id,day_ms,used) VALUES(${turn.user_id},${day},1) ON CONFLICT(user_id,day_ms) DO UPDATE SET used=used+1 WHERE used<3 RETURNING 1`;

  return granted.length === 1;
});

export type LocalInferenceServices = SqliteClient | SqlClient.SqlClient | StoreCapacity;

export const compact = Effect.fn(function* (
  turn: LocalTurn,
  inference: HostedInferenceService<LocalInferenceServices>
) {
  const snapshot = yield* Effect.gen(function* () {
    yield* liveTurn(turn, yield* Clock.currentTimeMillis);

    return yield* continuity(turn, "prefix");
  }).pipe(withStoreCapacity("required"));

  const newest = snapshot.rows.at(-1);

  if (newest === undefined) return;
  const entries = snapshot.rows.map((row) => row.entry_json);

  if (
    !shouldCompactConversation({
      entryCount: entries.length,
      tokenCount: yield* inference.countTranscript(entries),
    })
  ) {
    return;
  }

  if (!(yield* reserve(turn).pipe(withStoreCapacity("required")))) return;

  const prepared = yield* inference.prepareStructured({
    purpose: "conversation-compaction",
    outputSchema: CompactedConversationOutput,
    context: { prior: Option.fromNullishOr(snapshot.summary.text), entries },
  });

  const { compactedConversation } = yield* prepared.execute;

  if ((yield* inference.countText(compactedConversation)) > defaultCompactionMaximumTokens) return;
  yield* Effect.gen(function* () {
    yield* liveTurn(turn, yield* Clock.currentTimeMillis);
    const sql = yield* SqliteClient;

    const selected = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.Int, Schema.String])))
    )(snapshot.rows.map(({ sequence, entry_json }) => [sequence, entry_json.id] as const));

    const written =
      yield* sql`UPDATE hosted_agent_sessions SET compacted_text=${compactedConversation},compacted_through=${newest.sequence}
      WHERE user_id=${turn.user_id} AND id=${turn.session_id} AND compacted_through=${snapshot.summary.cursor}
      AND (SELECT count(*) FROM hosted_transcript WHERE session_id=${turn.session_id} AND sequence<=${newest.sequence})=${entries.length}
      AND NOT EXISTS(SELECT 1 FROM json_each(${selected}) AS expected WHERE NOT EXISTS(
        SELECT 1 FROM hosted_transcript e JOIN hosted_turns t ON t.id=e.turn_id AND t.user_id=${turn.user_id}
        WHERE e.session_id=${turn.session_id} AND e.sequence=json_extract(expected.value,'$[0]') AND json_extract(e.entry_json,'$.id')=json_extract(expected.value,'$[1]') AND t.state IN ('completed','interrupted','failed')
      )) RETURNING id`;

    if (written.length === 1) {
      const removed =
        yield* sql`DELETE FROM hosted_transcript WHERE session_id=${turn.session_id} AND sequence<=${newest.sequence} RETURNING 1`;

      if (removed.length !== entries.length) return yield* new AgentUnavailable();
    }
  }).pipe(withStoreCapacity("required"));
});
