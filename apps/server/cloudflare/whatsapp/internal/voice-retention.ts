import { Effect } from "effect";

const voiceRefusalSweepLimit = 128;
const voiceRefusalRetentionMs = 604_800_000;
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
/** Expire only the bounded, metadata-only voice-refusal replay purpose. */
export const expireVoiceRefusals = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: number }>): Effect.Effect<void, void> =>
  attempt(() =>
    db
      .prepare(`DELETE FROM whatsapp_event_records WHERE kind='voice-refusal' AND rowid IN (
        SELECT rowid FROM (SELECT rowid,portfolio_id,message_id,user_id,claimed_at_ms,outcome FROM whatsapp_event_records WHERE kind='voice-refusal') WHERE claimed_at_ms < ?
        ORDER BY claimed_at_ms LIMIT ?
      )`)
      .bind(now - voiceRefusalRetentionMs, voiceRefusalSweepLimit)
      .run()
  ).pipe(Effect.asVoid);
