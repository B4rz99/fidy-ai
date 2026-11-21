import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Schema } from "effect";
import { TranscriptText } from "../../../src/core/agent/contract";
import { reminderPauseMention as reminder, weeklyPauseMention as weekly } from "../contract";

export const bindPauseNotice = Effect.fn(function* (
  turn: { id: string; user: string; session: string },
  newSession: boolean
) {
  const sql = yield* SqliteClient;
  yield* sql`UPDATE weekly_attention SET notice_turn=${turn.id} WHERE paused_ms IS NOT NULL AND notice_delivered=0 AND grant_id IN(SELECT id FROM proactive_grants WHERE user_id=${turn.user} AND revoked_at_ms IS NULL) AND (${Number(newSession)}=1 OR notice_turn IN(SELECT id FROM hosted_turns WHERE session_id=${turn.session}))`;
  yield* sql`UPDATE reminder_attention SET notice_turn=${turn.id} WHERE unanswered=5 AND notice_delivered=0 AND grant_id IN(SELECT id FROM proactive_grants WHERE user_id=${turn.user} AND kind='manual-entry-reminder' AND revoked_at_ms IS NULL)`;
});

export const includePauseNotice = Effect.fn(function* (turn: string, text: TranscriptText) {
  const sql = yield* SqliteClient;

  const results =
    yield* sql`SELECT ${weekly} AS message FROM weekly_attention a JOIN proactive_grants g ON g.id=a.grant_id AND g.revoked_at_ms IS NULL WHERE a.notice_turn=${turn} AND a.notice_delivered=0 AND a.paused_ms IS NOT NULL UNION ALL SELECT ${reminder} FROM reminder_attention a JOIN proactive_grants g ON g.id=a.grant_id AND g.revoked_at_ms IS NULL WHERE a.notice_turn=${turn} AND a.notice_delivered=0 AND a.unanswered=5`;

  if (results.length === 0) return text;

  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ message: Schema.String }))
  )(results);

  return yield* Schema.decodeEffect(TranscriptText)(
    rows.map((row) => row.message).join("\n") + "\n\n" + text
  );
});

export const acknowledgePauseNotice = Effect.fn(function* (turn: string) {
  const sql = yield* SqliteClient;
  yield* sql`UPDATE weekly_attention SET notice_delivered=1 WHERE notice_turn=${turn} AND paused_ms IS NOT NULL AND EXISTS(SELECT 1 FROM hosted_turns WHERE id=${turn} AND state='completed' AND instr(answer,${weekly})>0)`;
  yield* sql`UPDATE reminder_attention SET notice_delivered=1 WHERE notice_turn=${turn} AND unanswered=5 AND EXISTS(SELECT 1 FROM hosted_turns WHERE id=${turn} AND state='completed' AND instr(answer,${reminder})>0)`;
});
