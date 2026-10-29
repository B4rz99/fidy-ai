import {
  prepareChangedRowAssertion,
  prepareReservedChangeAssertion,
} from "../../../src/shell/sql-assertions/operations";
import { Effect, Option } from "effect";
import type { AuthenticatedWebSession, BoundWebSessionLookup } from "../../web-session/contract";
import { resolveBoundCanonicalWebSession } from "../../web-session/operations";
import { CanonicalAdmissionUnavailable, canonicalRequestProtection as policy } from "../contract";

type BoundBrowserRequest = Readonly<{
  db: D1Database;
  lookup: BoundWebSessionLookup;
  id: string;
  current: number;
}>;

const prepareBoundBrowserRequest = ({
  db,
  lookup,
  id,
  current,
}: BoundBrowserRequest): Array<D1PreparedStatement> => {
  const { statement } = lookup;
  return [
    db
      .prepare(`DELETE FROM canonical_request_leases WHERE expires_at_ms <= ?
        AND user_id IN (SELECT userId FROM (${statement.sql}))`)
      .bind(current, ...statement.params),
    db
      .prepare(`INSERT INTO canonical_request_leases(id,user_id,expires_at_ms)
        SELECT ?, userId, ? FROM (${statement.sql})`)
      .bind(id, current + policy.leaseMs, ...statement.params),
    db
      .prepare(`INSERT INTO canonical_request_buckets(subject,virtual_at_ms)
        SELECT 'user:' || user_id, ? FROM canonical_request_leases WHERE id = ?
        ON CONFLICT(subject) DO UPDATE SET virtual_at_ms = max(virtual_at_ms,?) + ?
          WHERE virtual_at_ms <= ?`)
      .bind(
        current + policy.intervalMs,
        id,
        current,
        policy.intervalMs,
        current + (policy.burst - 1) * policy.intervalMs
      ),
    prepareReservedChangeAssertion({
      db,
      scope: "canonical_request",
      reservation: {
        sql: "SELECT 1 FROM canonical_request_leases WHERE id = ?",
        params: [id],
      },
    }),
    db.prepare(statement.sql).bind(...statement.params),
  ];
};

/** Resolve cookie binding and Consent with pressure acquisition in the same native snapshot. */
export const acquireBoundBrowserRequest = ({
  db,
  lookup,
  id,
  current,
}: BoundBrowserRequest): Effect.Effect<
  AuthenticatedWebSession | "unauthenticated" | "rate_limited" | "unavailable"
> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () => db.batch(prepareBoundBrowserRequest({ db, lookup, id, current })),
      catch: (cause) => new CanonicalAdmissionUnavailable({ cause }),
    });
    const subject = resolveBoundCanonicalWebSession({ lookup, row: rows[4]?.results[0] });
    if (Option.isSome(subject)) return subject.value;
    if (rows[1]?.meta.changes === 1) {
      yield* Effect.tryPromise({
        try: () => db.prepare("DELETE FROM canonical_request_leases WHERE id = ?").bind(id).run(),
        catch: (cause) => new CanonicalAdmissionUnavailable({ cause }),
      });
      return "unavailable" as const;
    }
    return "unauthenticated" as const;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error.cause instanceof Error &&
          /canonical_request_(rate|concurrency)/u.test(error.cause.message)
          ? ("rate_limited" as const)
          : ("unavailable" as const)
      )
    ),
    // A lost response can hide a committed lease; reconcile only this server-owned id.
    Effect.tap((result) => (result === "unavailable" ? releaseRequest({ db, id }) : Effect.void))
  );

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
        prepareChangedRowAssertion({ db, scope: "canonical_request" }),
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
    ),
    // A lost response can hide a committed lease; reconcile only this server-owned id.
    Effect.tap((result) => (result === "unavailable" ? releaseRequest({ db, id }) : Effect.void))
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
