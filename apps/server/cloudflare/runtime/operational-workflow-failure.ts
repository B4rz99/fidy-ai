import { Clock, Effect } from "effect";

const minuteMs = 60_000;
const maximumBucketCount = 1_000;

/** Best-effort failure evidence never replaces a Workflow's original success or rejection. */
export const captureWorkflowFailure = <A>({
  work,
  db,
}: Readonly<{
  work: Promise<A>;
  db: D1Database;
}>): Promise<A> =>
  work.catch((original: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bucket = Math.floor((yield* Clock.currentTimeMillis) / minuteMs) * minuteMs;
        yield* Effect.exit(
          Effect.tryPromise(() =>
            db
              .prepare(`INSERT INTO operational_event_buckets (kind, bucket_ms, count)
        VALUES ('workflow_failure', ?, 1)
        ON CONFLICT(kind, bucket_ms) DO UPDATE SET count = MIN(count + 1, ?)`)
              .bind(bucket, maximumBucketCount)
              .run()
          ).pipe(Effect.timeout("250 millis"))
        );
      })
    ).then(() => Promise.reject(original))
  );
