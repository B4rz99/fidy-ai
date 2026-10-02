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
      .prepare(`DELETE FROM hosted_voice_refusals WHERE rowid IN (
        SELECT rowid FROM hosted_voice_refusals WHERE claimed_at_ms < ?
        ORDER BY claimed_at_ms LIMIT ?
      )`)
      .bind(now - voiceRefusalRetentionMs, voiceRefusalSweepLimit)
      .run()
  ).pipe(Effect.asVoid);
