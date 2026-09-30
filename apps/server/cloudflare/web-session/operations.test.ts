import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { Effect, Option } from "effect";
import {
  browserSession,
  currentUser,
  logoutBrowser,
  prepareWebSessionIssuance,
} from "@fidy/server/web-session-runtime";

it("prepares session issuance for an explicit User and releases its cookie only after insertion", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* fromTestPromise(() => db.prepare("DROP TABLE web_sessions").run());
      yield* fromTestPromise(() =>
        db
          .prepare(
            `CREATE TABLE web_sessions (id TEXT PRIMARY KEY, pairing_id TEXT UNIQUE, user_id TEXT NOT NULL, token_digest BLOB NOT NULL, created_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER, revoked_at_ms INTEGER) STRICT`
          )
          .run()
      );
      const prepared = yield* prepareWebSessionIssuance({
        db,
        pairingId: sessionA,
        userId: userA,
        current: 99,
      });
      const absent = yield* fromTestPromise(() =>
        db.prepare("SELECT count(*) AS count FROM web_sessions").first()
      );
      expect(absent).toEqual({ count: 0 });
      const inserted = yield* fromTestPromise(() => prepared.statement.run());
      const response = prepared.complete(inserted);
      expect(response.status).toBe(200);
      const replay = prepared.complete(inserted);
      expect(replay.status).toBe(400);
      expect(replay.headers.has("set-cookie")).toBe(false);
      const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      const resolved = yield* fromTestPromise(() =>
        browserSession({
          request: new Request("https://api.fidyapp.com", { headers: { cookie } }),
          db,
          input: { current: 100, fresh: true },
        })
      );
      expect(Option.map(resolved, (session) => session.userId)).toEqual(Option.some(userA));
    })
  ));

const instances: Array<Miniflare> = [];
const fromTestPromise = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
afterEach(() => Promise.all(instances.splice(0).map((instance) => instance.dispose())));
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const sessionA = "20000000-0000-4000-8000-000000000001";
const sessionB = "20000000-0000-4000-8000-000000000002";
const tokenA = "A".repeat(43);
const tokenB = "B".repeat(43);
let nextDatabase = 0;
const request = (token: string): Request =>
  new Request("https://api.fidyapp.com/user", {
    headers: { cookie: `__Host-fidy_session=${token}` },
  });
const setup = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const instance = new Miniflare({
      workers: [
        {
          config: {
            name: "session-test",
            type: "worker",
            compatibilityDate: "2026-09-08",
            env: { DB: { id: `session-${++nextDatabase}`, type: "d1" } },
            manifest: {
              mainModule: "index.mjs",
              modules: {
                "index.mjs": {
                  contents: "export default {fetch() {return new Response('ok')}}",
                  type: "esm",
                },
              },
            },
          },
        },
      ],
    });
    instances.push(instance);
    const db = yield* fromTestPromise(() => instance.getD1Database("DB"));
    yield* fromTestPromise(() =>
      db
        .prepare(`CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    token_digest BLOB NOT NULL, revoked_at_ms INTEGER, fresh_until_ms INTEGER NOT NULL,
    idle_expires_at_ms INTEGER NOT NULL, hard_expires_at_ms INTEGER NOT NULL) STRICT`)
        .run()
    );
    for (const [id, userId, token] of [
      [sessionA, userA, tokenA],
      [sessionB, userB, tokenB],
    ]) {
      const digest = new Uint8Array(
        yield* fromTestPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
        )
      );
      yield* fromTestPromise(() =>
        db
          .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, 100, 200, 300)")
          .bind(id, userId, digest)
          .run()
      );
    }
    return db;
  });
const authenticate = (
  db: D1Database,
  token: string,
  input: Readonly<{ current: number; fresh: boolean }>
): Effect.Effect<Option.Option<Readonly<{ id: string; userId: string }>>> =>
  fromTestPromise(() => browserSession({ request: request(token), db, input }));

it("authenticates only the User bound to the browser credential and denies freshness at its exact deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      expect(yield* authenticate(db, tokenB, { current: 99, fresh: true })).toEqual(
        Option.some({ id: sessionB, userId: userB })
      );
      expect(yield* authenticate(db, tokenA, { current: 100, fresh: true })).toEqual(Option.none());
      expect(yield* authenticate(db, tokenA, { current: 100, fresh: false })).toEqual(
        Option.some({ id: sessionA, userId: userA })
      );
    })
  ));

it("rejects duplicate cookies without revoking either User and refuses idle expiry at its exact deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const duplicate = new Request("https://api.fidyapp.com/user", {
        headers: {
          cookie: `__Host-fidy_session=${tokenA}; __Host-fidy_session=${tokenB}`,
        },
      });
      expect((yield* fromTestPromise(() => currentUser({ request: duplicate, db }))).status).toBe(
        401
      );
      expect((yield* fromTestPromise(() => logoutBrowser({ request: duplicate, db }))).status).toBe(
        204
      );
      expect(yield* authenticate(db, tokenA, { current: 199, fresh: false })).toEqual(
        Option.some({ id: sessionA, userId: userA })
      );
      expect(yield* authenticate(db, tokenB, { current: 200, fresh: false })).toEqual(
        Option.none()
      );
    })
  ));

it("logs out only the exact browser credential, leaving another User authenticated", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const response = yield* fromTestPromise(() =>
        logoutBrowser({ request: request(tokenA), db })
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toBe(
        "__Host-fidy_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
      );
      expect(yield* authenticate(db, tokenA, { current: 99, fresh: false })).toEqual(Option.none());
      expect(yield* authenticate(db, tokenB, { current: 99, fresh: false })).toEqual(
        Option.some({ id: sessionB, userId: userB })
      );
    })
  ));
