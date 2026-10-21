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

const runHeldCallback = <A>({
  run,
  entered,
  released,
  settled,
  state,
}: Readonly<{
  run: () => PromiseLike<A>;
  entered: Deferred.Deferred<void>;
  released: Deferred.Deferred<void>;
  settled: Deferred.Deferred<void>;
  state: { held: boolean };
}>): Promise<A> =>
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

const heldStatement = ({
  statement,
  method,
  complete,
}: Readonly<{
  statement: D1PreparedStatement;
  method: "first" | "run" | "all";
  complete: <A>(run: () => PromiseLike<A>) => Promise<A>;
}>): D1PreparedStatement =>
  new Proxy(statement, {
    get(target, key): unknown {
      if (key === "bind") {
        return (...values: ReadonlyArray<unknown>): D1PreparedStatement =>
          heldStatement({
            statement: target.bind(...values),
            method,
            complete,
          });
      }
      if (key === "first") {
        return <Value = unknown>(column?: string): ReturnType<typeof target.first<Value>> => {
          const run = (): ReturnType<typeof target.first<Value>> =>
            column === undefined ? target.first<Value>() : target.first<Value>(column);
          return method === "first" ? complete(run) : run();
        };
      }
      if (key === "run") {
        return <Row = Record<string, unknown>>(): Promise<D1Result<Row>> =>
          method === "run" ? complete(() => target.run<Row>()) : target.run<Row>();
      }
      if (key === "all") {
        return <Row = Record<string, unknown>>(): Promise<D1Result<Row>> =>
          method === "all" ? complete(() => target.all<Row>()) : target.all<Row>();
      }
      if (key === "raw") return target.raw.bind(target);
      return Reflect.get(target, key, target);
    },
  });

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
    const complete = <A>(run: () => PromiseLike<A>): Promise<A> =>
      runHeldCallback({ run, entered, released, settled, state });
    const binding = new Proxy(db, {
      get(target, key): unknown {
        if (key === "prepare") {
          return (sql: string): D1PreparedStatement => {
            const statement = target.prepare(sql);
            return sql.startsWith(sqlPrefix)
              ? heldStatement({ statement, method, complete })
              : statement;
          };
        }
        if (key === "batch") return target.batch.bind(target);
        if (key === "exec") return target.exec.bind(target);
        if (key === "dump") return target.dump.bind(target);
        if (key === "withSession") return target.withSession.bind(target);
        return Reflect.get(target, key, target);
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
          "CREATE TABLE users (paid_attempt_id TEXT,paid_price_id TEXT,paid_period_ends_at_ms INTEGER,paid_renewal_anchor_ms INTEGER,id TEXT, service_market TEXT, locale TEXT, time_zone TEXT, created_at_ms INTEGER, trial_started_at_ms INTEGER, trial_ends_at_ms INTEGER ,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER,route_portfolio_id TEXT,route_bsuid TEXT,route_phone_number_id TEXT,route_verified_at_ms INTEGER)"
        ),
        db
          .prepare(
            "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
          )
          .bind(sessionUser),
        db
          .prepare("UPDATE users SET trial_started_at_ms=0,trial_ends_at_ms=604800000 WHERE id=?1")
          .bind(sessionUser),
        db.prepare(
          "CREATE TABLE consent_history (record_type TEXT NOT NULL,user_id TEXT NOT NULL)"
        ),
        db
          .prepare(
            "INSERT INTO consent_history (record_type,user_id) VALUES ('processing_grant',?)"
          )
          .bind(sessionUser),
        db.prepare(
          "CREATE TABLE IF NOT EXISTS audit_entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_type TEXT NOT NULL,id TEXT,user_id TEXT,session_id TEXT,operation TEXT,outcome TEXT,occurred_at_ms INTEGER,pat_id TEXT,oauth_connection_id TEXT,oauth_credential_id TEXT,hosted_turn_id TEXT,attempt_id TEXT,transition TEXT,accepted_at_ms INTEGER,UNIQUE(record_type,id),UNIQUE(attempt_id,transition))"
        ),
      ])
    );
  });
