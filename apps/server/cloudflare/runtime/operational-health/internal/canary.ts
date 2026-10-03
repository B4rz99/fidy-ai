import { type Cause, Effect, Schema } from "effect";
import type { CanaryHealth } from "../contract";

export const periodMs = 300_000;
export const staleMs = 600_000;
export const WorkflowStatus = Schema.Struct({
  status: Schema.Literals([
    "queued",
    "running",
    "waiting",
    "complete",
    "paused",
    "errored",
    "terminated",
    "unknown",
    "waitingForPause",
  ]),
});
export const Check = Schema.Struct({
  kind: Schema.Literals(["queueExecution", "workflowExecution"]),
  last_succeeded_ms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const recordCanary = ({
  db,
  kind,
  now,
}: Readonly<{ db: D1Database; kind: CanaryHealth["operation"]; now: number }>): Effect.Effect<
  void,
  Cause.UnknownError
> =>
  Effect.tryPromise(() =>
    db
      .prepare(`INSERT INTO operational_canary (kind, last_succeeded_ms) VALUES (?, ?)
    ON CONFLICT(kind) DO UPDATE SET last_succeeded_ms = MAX(last_succeeded_ms, excluded.last_succeeded_ms)`)
      .bind(kind, now)
      .run()
  ).pipe(Effect.asVoid);
