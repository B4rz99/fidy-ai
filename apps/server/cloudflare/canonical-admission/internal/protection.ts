import { Effect } from "effect";
import { CanonicalAdmissionUnavailable, canonicalRequestProtection as policy } from "../contract";

/** Fixed per-User request protection, not a commercial allowance. Refusals never spend quota. */
export const acquireRequest = ({
  db,
  userId,
  id,
  current,
}: Readonly<{ db: D1Database; userId: string; id: string; current: number }>): Effect.Effect<
  "accepted" | "rate_limited" | "unavailable"
> =>
  Effect.tryPromise({
    try: () =>
      db.batch([
        db
          .prepare("DELETE FROM canonical_request_leases WHERE user_id = ? AND expires_at_ms <= ?")
          .bind(userId, current),
        db
          .prepare("INSERT INTO canonical_request_leases VALUES (?,?,?)")
          .bind(id, userId, current + policy.leaseMs),
        db
          .prepare(
            `INSERT INTO canonical_request_buckets VALUES (?,?) ON CONFLICT(subject) DO UPDATE SET virtual_at_ms = max(virtual_at_ms,?) + ? WHERE virtual_at_ms <= ?`
          )
          .bind(
            `user:${userId}`,
            current + policy.intervalMs,
            current,
            policy.intervalMs,
            current + (policy.burst - 1) * policy.intervalMs
          ),
        db.prepare("INSERT INTO canonical_request_assertions VALUES (?,changes())").bind(id),
        db.prepare("DELETE FROM canonical_request_assertions WHERE id = ?").bind(id),
      ]),
    catch: (cause) => new CanonicalAdmissionUnavailable({ cause }),
  }).pipe(
    Effect.map(() => "accepted" as const),
    Effect.catch((error) =>
      Effect.succeed(
        error.cause instanceof Error &&
          /canonical_request_(rate|concurrency)/u.test(error.cause.message)
          ? ("rate_limited" as const)
          : ("unavailable" as const)
      )
    )
  );

/** Release the request slot even for a failed or interrupted implementation. */
export const releaseRequest = ({
  db,
  id,
}: Readonly<{ db: D1Database; id: string }>): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => db.prepare("DELETE FROM canonical_request_leases WHERE id = ?").bind(id).run(),
    catch: () => undefined,
  }).pipe(Effect.ignore);

/** Invalid credentials share a keyed trusted-source envelope, with no raw address or credential persisted. */
export const admitUnresolvedSource = ({
  db,
  source,
  current,
}: Readonly<{ db: D1Database; source: string; current: number }>): Effect.Effect<
  "accepted" | "rate_limited" | "unavailable"
> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `INSERT INTO canonical_request_buckets VALUES (?,?) ON CONFLICT(subject) DO UPDATE SET virtual_at_ms = max(virtual_at_ms,?) + ? WHERE virtual_at_ms <= ? RETURNING subject`
        )
        .bind(
          `source:${source}`,
          current + policy.intervalMs,
          current,
          policy.intervalMs,
          current + (policy.burst - 1) * policy.intervalMs
        )
        .first(),
    catch: () => undefined,
  }).pipe(
    Effect.map((row) => (row === null ? ("rate_limited" as const) : ("accepted" as const))),
    Effect.orElseSucceed(() => "unavailable" as const)
  );
