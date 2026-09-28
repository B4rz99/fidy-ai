import { Clock, Effect, Option, Schema } from "effect";
import { projectOperationalEvents } from "./runtime/operational-events";

const Received = Schema.Struct({
  eventTimestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const minuteMs = 60_000;
const maximumAgeMinutes = 15;
const maximumAgeMs = maximumAgeMinutes * minuteMs;
const maximumFutureMs = 2 * minuteMs;
const maximumEvents = 32;
const maximumBucketCount = 1_000;

/** Tails are post-invocation; only closed counters cross into D1, never tail messages or URLs. */
const tail = (
  events: ReadonlyArray<unknown>,
  environment: { readonly DB: D1Database }
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const recent = events.slice(0, maximumEvents).filter((event) => {
        const decoded = Schema.decodeUnknownOption(Received)(event);
        return (
          Option.isSome(decoded) &&
          decoded.value.eventTimestamp >= now - maximumAgeMs &&
          decoded.value.eventTimestamp <= now + maximumFutureMs
        );
      });
      if (recent.length === 0) return;
      const projected = projectOperationalEvents(recent);
      const overflow =
        events.length > maximumEvents
          ? [
              environment.DB.prepare(`INSERT INTO operational_event_buckets (kind, bucket_ms, count)
    VALUES ('tail_overflow', ?, 1) ON CONFLICT(kind, bucket_ms) DO NOTHING`).bind(
                Math.floor(now / minuteMs) * minuteMs
              ),
            ]
          : [];
      const heartbeat =
        environment.DB.prepare(`INSERT INTO operational_event_buckets (kind, bucket_ms, count)
    VALUES ('heartbeat', ?, 1) ON CONFLICT(kind, bucket_ms) DO NOTHING`).bind(
          Math.floor(now / minuteMs) * minuteMs
        );
      yield* Effect.tryPromise(() =>
        environment.DB.batch([
          heartbeat,
          ...overflow,
          ...projected.map((event) =>
            environment.DB.prepare(`INSERT INTO operational_event_buckets (kind, bucket_ms, count)
      VALUES (?, ?, 1) ON CONFLICT(kind, bucket_ms) DO UPDATE SET count = MIN(count + 1, ?)`).bind(
              event.kind,
              event.bucketMs,
              maximumBucketCount
            )
          ),
        ])
      );
    })
  );

export default { tail };
