import { type Cause, Data, Deferred, Effect } from "effect";
import {
  DisabledTelemetryResource,
  makeTelemetryService,
} from "../../src/shell/observability/operations";
import type { WebAuthenticationRequest } from "./contract";

export const sessionUser = "10000000-0000-4000-8000-000000000001";
export const sessionId = "20000000-0000-4000-8000-000000000001";
const bearerLength = 43;
export const sessionToken = "c".repeat(bearerLength);
const telemetry = makeTelemetryService(DisabledTelemetryResource.adapter);

export const sessionRequest = ({
  db,
  logout,
}: Readonly<{
  db: D1Database;
  logout: boolean;
}>): WebAuthenticationRequest => ({
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

class SessionCallbackFailed extends Data.TaggedError("SessionCallbackFailed")<{
  readonly cause: unknown;
}> {}

const runHeldCallback = ({
  run,
  entered,
  released,
  settled,
  state,
}: Readonly<{
  run: () => PromiseLike<unknown>;
  entered: Deferred.Deferred<void>;
  released: Deferred.Deferred<void>;
  settled: Deferred.Deferred<void>;
  state: { held: boolean };
}>): Promise<unknown> =>
  // Genuine foreign D1 Promise ingress: retain the result and the original rejection as its cause.
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: run,
        catch: (cause) => new SessionCallbackFailed({ cause }),
      });
      if (!state.held) {
        state.held = true;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(released);
      }
      return result;
    }).pipe(Effect.ensuring(Deferred.succeed(settled, undefined)))
  );

/** Hold one real D1 completion callback after the platform has settled its statement. */
export const holdSessionCallback = ({
  db,
  sqlPrefix,
  method,
}: Readonly<{
  db: D1Database;
  sqlPrefix: string;
  method: "first" | "run" | "all";
}>): Effect.Effect<
  Readonly<{
    db: D1Database;
    entered: Deferred.Deferred<void>;
    settled: Deferred.Deferred<void>;
    release: Effect.Effect<void>;
  }>
> =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const settled = yield* Deferred.make<void>();
    const state = { held: false };
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, key): unknown {
          if (key === "bind") {
            return (...values: ReadonlyArray<unknown>): D1PreparedStatement =>
              wrap(target.bind(...values));
          }
          const member = Reflect.get(target, key, target);
          if (key === method) {
            return (...args: ReadonlyArray<unknown>): Promise<unknown> =>
              runHeldCallback({
                run: () => Reflect.apply(member, target, args),
                entered,
                released,
                settled,
                state,
              });
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
    const release = Deferred.succeed(released, undefined).pipe(Effect.asVoid);
    return { db: binding, entered, settled, release };
  });

/** Minimal real-D1 projections, not migration or production-topology evidence. */
export const seedSession = ({
  db,
  idle,
  hard,
}: Readonly<{
  db: D1Database;
  idle: number;
  hard: number;
}>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const digest = new Uint8Array(
      yield* Effect.tryPromise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken))
      )
    );
    yield* Effect.tryPromise(() =>
      db.batch([
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
      ])
    );
  });
