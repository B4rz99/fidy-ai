import { Clock, Effect } from "effect";
import {
  DisabledTelemetryResource,
  makeTelemetryService,
} from "../../src/shell/observability/operations";
import type { WebAuthenticationRequest } from "./contract";

export const withSessionTime = <A, E>(
  work: Effect.Effect<A, E>,
  current: number
): Effect.Effect<A, E> =>
  Clock.clockWith((clock) =>
    work.pipe(
      Effect.provideService(Clock.Clock, {
        currentTimeMillisUnsafe: () => current,
        currentTimeMillis: Effect.succeed(current),
        currentTimeNanosUnsafe: () => BigInt(current) * 1_000_000n,
        currentTimeNanos: Effect.succeed(BigInt(current) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
      })
    )
  );

export const sessionUser = "10000000-0000-4000-8000-000000000001";
export const sessionId = "20000000-0000-4000-8000-000000000001";
const bearerLength = 43;
export const sessionToken = "c".repeat(bearerLength);
const telemetry = makeTelemetryService(DisabledTelemetryResource.adapter);

export const sessionRequest = (db: D1Database, logout = false): WebAuthenticationRequest => ({
  request: new Request(`https://api.fidyapp.com${logout ? "/web/session/logout" : "/user"}`, {
    method: logout ? "POST" : "GET",
    headers: { cookie: `__Host-fidy_session=${sessionToken}` },
  }),
  db,
  telemetry,
  support: {
    CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUDIENCE: "support",
  },
  publish: () => {
    throw new Error("Session use must not publish authentication work");
  },
});

/** Hold one real D1 completion callback after the platform has settled its statement. */
export const holdSessionCallback = (
  db: D1Database,
  sqlPrefix: string,
  method: "first" | "run" | "all"
): Readonly<{ db: D1Database; entered: Promise<void>; release: () => void }> => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key): unknown {
        if (key === "bind") {
          return (...values: ReadonlyArray<unknown>): D1PreparedStatement =>
            wrap(target.bind(...values));
        }
        const member = Reflect.get(target, key, target);
        if (key === method) {
          return async (...args: ReadonlyArray<unknown>): Promise<unknown> => {
            const result = await Reflect.apply(member, target, args);
            if (!held) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return result;
          };
        }
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  const binding = new Proxy(db, {
    get(target, key): unknown {
      if (key === "prepare") {
        return (sql: string): D1PreparedStatement => {
          const statement = target.prepare(sql);
          return sql.startsWith(sqlPrefix) ? wrap(statement) : statement;
        };
      }
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { db: binding, entered: entered.promise, release: (): void => release.resolve() };
};

/** Minimal real-D1 projections, not migration or production-topology evidence. */
export const seedSession = async (
  db: D1Database,
  idle = 4102444801000,
  hard = 4110220800000
): Promise<void> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken))
  );
  await db.batch([
    db.prepare(
      "CREATE TABLE web_sessions (id TEXT, user_id TEXT, token_digest BLOB, revoked_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)"
    ),
    db
      .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, 4102444200000, ?, ?)")
      .bind(sessionId, sessionUser, digest, idle, hard),
    db.prepare(
      "CREATE TABLE users (id TEXT, service_market TEXT, locale TEXT, time_zone TEXT, created_at_ms INTEGER)"
    ),
    db
      .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)")
      .bind(sessionUser),
    db.prepare(
      "CREATE TABLE trial_periods (user_id TEXT, started_at_ms INTEGER, ends_at_ms INTEGER)"
    ),
    db.prepare("INSERT INTO trial_periods VALUES (?, 0, 604800000)").bind(sessionUser),
    db.prepare("CREATE TABLE onboarding_consent_records (user_id TEXT)"),
    db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(sessionUser),
    db.prepare(
      "CREATE TABLE canonical_user_reads (id TEXT, user_id TEXT, session_id TEXT, occurred_at_ms INTEGER)"
    ),
  ]);
};
