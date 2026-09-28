import { Effect } from "effect";

const minuteMs = 60_000;
const maximumBucketCount = 1_000;

/** Best-effort failure evidence never replaces a Workflow's original success or rejection. */
export const captureWorkflowFailure = <A>(work: Promise<A>, db: D1Database): Promise<A> =>
  work.catch(async (original: unknown) => {
    const bucket = Math.floor(Date.now() / minuteMs) * minuteMs;
    await Effect.runPromise(
      Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO operational_event_buckets (kind, bucket_ms, count)
        VALUES ('workflow_failure', ?, 1)
        ON CONFLICT(kind, bucket_ms) DO UPDATE SET count = MIN(count + 1, ?)`)
          .bind(bucket, maximumBucketCount)
          .run()
      ).pipe(Effect.timeout("250 millis"), Effect.exit)
    );
    throw original;
  });
