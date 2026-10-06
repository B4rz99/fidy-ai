import { redeemBrowserPairing } from "../browser-login/operations";
import { freshSessionQuery } from "../../src/shell/web-session/operations";
import { Clock, Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { authenticateWebSession, logoutWebSession } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = "10000000-0000-4000-8000-000000000001";
const sessionA = "20000000-0000-4000-8000-000000000001";
const tokenA = "a".repeat(43);
const cookieRequest = (cookie: string): Request =>
  new Request("https://api.fidyapp.com/user", { headers: { cookie } });

it("authenticates only one live browser credential and refuses duplicate cookies without renewing it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const digest = new Uint8Array(
        yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenA))
        )
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(`CREATE TABLE web_sessions (id TEXT, user_id TEXT, token_digest BLOB,
          revoked_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)`),
          db
            .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, 1100, 2000, 3000)")
            .bind(sessionA, userA, digest),
        ])
      );
      const valid = yield* Effect.tryPromise(() =>
        authenticateWebSession({
          request: cookieRequest(`__Host-fidy_session=${tokenA}`),
          db,
          current: 1000,
          freshness: "live",
        })
      );
      expect(valid).toEqual(Option.some({ id: sessionA, userId: userA, digest }));
      const duplicated = yield* Effect.tryPromise(() =>
        authenticateWebSession({
          request: cookieRequest(`__Host-fidy_session=${tokenA}; __Host-fidy_session=${tokenA}`),
          db,
          current: 1000,
          freshness: "live",
        })
      );
      expect(duplicated).toEqual(Option.none());
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT idle_expires_at_ms FROM web_sessions").first()
        )
      ).toEqual({ idle_expires_at_ms: 2000 });
    })
  ));

it("revokes only the presented browser session and never clears another User's authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const tokenB = "b".repeat(43);
      const digestA = new Uint8Array(
        yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenA))
        )
      );
      const digestB = new Uint8Array(
        yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenB))
        )
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(`CREATE TABLE web_sessions (id TEXT, user_id TEXT, token_digest BLOB,
          revoked_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)`),
          db
            .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, 1100, 2000, 3000)")
            .bind(sessionA, userA, digestA),
          db
            .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, 1100, 2000, 3000)")
            .bind(
              "20000000-0000-4000-8000-000000000002",
              "10000000-0000-4000-8000-000000000002",
              digestB
            ),
        ])
      );
      const response = yield* logoutWebSession({
        request: cookieRequest(`__Host-fidy_session=${tokenA}`),
        db,
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toBe(
        "__Host-fidy_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(
        yield* Effect.tryPromise(() =>
          authenticateWebSession({
            request: cookieRequest(`__Host-fidy_session=${tokenA}`),
            db,
            current: 1000,
            freshness: "live",
          })
        )
      ).toEqual(Option.none());
      expect(
        Option.isSome(
          yield* Effect.tryPromise(() =>
            authenticateWebSession({
              request: cookieRequest(`__Host-fidy_session=${tokenB}`),
              db,
              current: 1000,
              freshness: "live",
            })
          )
        )
      ).toBe(true);
    })
  ));

it.each([
  { freshness: "fresh" as const, current: 1100, idleExpiresAt: 2000 },
  { freshness: "live" as const, current: 2000, idleExpiresAt: 2000 },
  { freshness: "live" as const, current: 3000, idleExpiresAt: 4000 },
])(
  "refuses a browser credential at its exact $freshness deadline $current",
  ({ freshness, current, idleExpiresAt }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        const digest = new Uint8Array(
          yield* Effect.tryPromise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenA))
          )
        );
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare(`CREATE TABLE web_sessions (id TEXT, user_id TEXT, token_digest BLOB,
          revoked_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)`),
            db
              .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, 1100, ?, 3000)")
              .bind(sessionA, userA, digest, idleExpiresAt),
          ])
        );
        expect(
          yield* Effect.tryPromise(() =>
            authenticateWebSession({
              request: cookieRequest(`__Host-fidy_session=${tokenA}`),
              db,
              current,
              freshness,
            })
          )
        ).toEqual(Option.none());
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT idle_expires_at_ms, fresh_until_ms, revoked_at_ms FROM web_sessions")
              .first()
          )
        ).toEqual({ idle_expires_at_ms: idleExpiresAt, fresh_until_ms: 1100, revoked_at_ms: null });
      })
    )
);

it("rechecks the correlated fresh session's exact User at commit and refuses revocation without partial work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const userB = "10000000-0000-4000-8000-000000000002";
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(`CREATE TABLE web_sessions (id TEXT, user_id TEXT, revoked_at_ms INTEGER,
          fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)`),
          db
            .prepare("INSERT INTO web_sessions VALUES (?, ?, NULL, 1100, 2000, 3000)")
            .bind(sessionA, userA),
          db.prepare("CREATE TABLE email_replacements (user_id TEXT, session_id TEXT)"),
          db
            .prepare("INSERT INTO email_replacements VALUES (?, ?), (?, ?)")
            .bind(userA, sessionA, userB, sessionA),
          db.prepare("CREATE TABLE protected_work (user_id TEXT)"),
        ])
      );
      const query = freshSessionQuery({
        subject: { sql: "SELECT r.session_id AS sessionId, r.user_id AS userId", params: [] },
        current: 1000,
      });
      const commit = db
        .prepare(
          `INSERT INTO protected_work SELECT r.user_id FROM email_replacements AS r WHERE EXISTS (${query.sql})`
        )
        .bind(...query.params);
      yield* Effect.tryPromise(() => commit.run());
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT user_id FROM protected_work").all()))
          .results
      ).toEqual([{ user_id: userA }]);
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("DELETE FROM protected_work"),
          db.prepare("UPDATE web_sessions SET revoked_at_ms = 1000 WHERE id = ?").bind(sessionA),
        ])
      );
      yield* Effect.tryPromise(() => commit.run());
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT user_id FROM protected_work").all()))
          .results
      ).toEqual([]);
    })
  ));

it("refuses session establishment without the exact browser-private verifier and leaves the pairing reusable by its owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const pairingId = "30000000-0000-4000-8000-000000000001";
      const privateVerifier = "q".repeat(43);
      const current = yield* Clock.currentTimeMillis;
      const verifierDigest = new Uint8Array(
        yield* Effect.tryPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(privateVerifier))
        )
      );
      const redeem = (verifier: string): Effect.Effect<Response> =>
        redeemBrowserPairing({
          db,
          request: new Request("https://api.fidyapp.com/web/pairings/redeem", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pairingId, privateVerifier: verifier }),
          }),
        });
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE browser_login_pairings (id TEXT, state TEXT, user_id TEXT, expires_at_ms INTEGER, wrong_attempts INTEGER, verifier_digest BLOB, last_poll_at_ms INTEGER, minimum_poll_interval_seconds INTEGER)"
          ),
          db
            .prepare("INSERT INTO browser_login_pairings VALUES (?, 'ready', ?, ?, 0, ?, NULL, 5)")
            .bind(pairingId, userA, current + 600_000, verifierDigest),
          db.prepare(`CREATE TABLE web_sessions (id TEXT, pairing_id TEXT UNIQUE, user_id TEXT, token_digest BLOB,
          created_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)`),
        ])
      );
      const rejected = yield* redeem("r".repeat(43));
      expect(rejected.status).toBe(400);
      expect(rejected.headers.get("set-cookie")).toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM browser_login_pairings").first()
        )
      ).toEqual({ state: "ready" });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM web_sessions").first()
        )
      ).toEqual({ count: 0 });
      const accepted = yield* redeem(privateVerifier);
      expect(accepted.status).toBe(200);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT user_id FROM web_sessions").first())
      ).toEqual({ user_id: userA });
    })
  ));
