import { Effect } from "effect";
import type { AlertSignal } from "./operational-alerts";

/** Latest private, metadata-only inspection; timestamps make stale observations visible. */
export const recordOperationalHealth = ({
  db,
  signals,
  observedAtMs,
}: Readonly<{
  db: D1Database;
  signals: ReadonlyArray<AlertSignal>;
  observedAtMs: number;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.tryPromise(() =>
      db.batch(
        signals.map((signal) =>
          db
            .prepare(`INSERT INTO operational_health_view
    (operation, state, observed_at_ms) VALUES (?, ?, ?)
    ON CONFLICT(operation) DO UPDATE SET state = excluded.state,
      observed_at_ms = excluded.observed_at_ms WHERE excluded.observed_at_ms >= observed_at_ms`)
            .bind(signal.operation, signal.state, observedAtMs)
        )
      )
    ).pipe(Effect.asVoid)
  );
