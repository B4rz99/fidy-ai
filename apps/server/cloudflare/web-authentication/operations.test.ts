import { deepStrictEqual } from "node:assert";
import { it as effectIt } from "@effect/vitest";
import { Clock, Effect, Exit, Option } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, expect, it } from "vitest";
import {
  DisabledTelemetryResource,
  makeTelemetryService,
} from "../../src/shell/observability/operations";

import { isolatedTestDatabases } from "../d1-test-fixture";
import { authenticateWebSession } from "../web-session/operations";
import { handleWebAuthentication } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const telemetry = makeTelemetryService(DisabledTelemetryResource.adapter);
const support = {
  CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUDIENCE: "support",
};

it("refuses wrong-method authentication and unknown paths before any owner can create authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => db.prepare("CREATE TABLE web_sessions (id TEXT)").run());
      for (const [path, method, status] of [
        ["/web/pairings", "GET", 405],
        ["/web/pairings/redeem", "GET", 405],
        ["/web/email/authentication/complete", "GET", 405],
        ["/web/onboarding/email/verify", "GET", 405],
        ["/recovery/backup-code/rotate", "GET", 405],
        ["/internal/support-recovery", "GET", 405],
        ["/web/session/logout", "GET", 405],
        ["/web/pairings/unknown", "POST", 404],
      ] as const) {
        const response = yield* handleWebAuthentication({
          request: new Request(`https://api.fidyapp.com${path}`, { method }),
          db,
          support,
          telemetry,
          publish: () => {
            throw new Error("Rejected authentication must not publish work");
          },
        });
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT COUNT(*) AS count FROM web_sessions").first()
        )
      ).toEqual({ count: 0 });
    })
  ));

it("never turns a foreign or duplicate cookie into another User's logout authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const current = yield* Clock.currentTimeMillis;
      const tokenA = "a".repeat(43);
      const tokenB = "b".repeat(43);
      const users = [
        {
          token: tokenA,
          user: "10000000-0000-4000-8000-000000000001",
          session: "20000000-0000-4000-8000-000000000001",
        },
        {
          token: tokenB,
          user: "10000000-0000-4000-8000-000000000002",
          session: "20000000-0000-4000-8000-000000000002",
        },
      ];
      yield* Effect.tryPromise(() =>
        db
          .prepare(`CREATE TABLE web_sessions (id TEXT, user_id TEXT, token_digest BLOB,
        revoked_at_ms INTEGER, fresh_until_ms INTEGER, idle_expires_at_ms INTEGER, hard_expires_at_ms INTEGER)`)
          .run()
      );
      for (const user of users) {
        const digest = new Uint8Array(
          yield* Effect.tryPromise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(user.token))
          )
        );
        yield* Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?, ?)")
            .bind(user.session, user.user, digest, current + 1000, current + 2000, current + 3000)
            .run()
        );
      }
      const duplicate = yield* handleWebAuthentication({
        request: new Request("https://api.fidyapp.com/web/session/logout", {
          method: "POST",
          headers: { cookie: `__Host-fidy_session=${tokenA}; __Host-fidy_session=${tokenB}` },
        }),
        db,
        support,
        telemetry,
        publish: () => {},
      });
      expect(duplicate.status).toBe(204);
      for (const user of users) {
        const session = yield* Effect.tryPromise(() =>
          authenticateWebSession({
            request: new Request("https://api.fidyapp.com/user", {
              headers: { cookie: `__Host-fidy_session=${user.token}` },
            }),
            db,
            current,
            freshness: "live",
          })
        );
        expect(Option.map(session, (subject) => subject.userId)).toEqual(Option.some(user.user));
      }
      const logout = yield* handleWebAuthentication({
        request: new Request("https://api.fidyapp.com/web/session/logout", {
          method: "POST",
          headers: { cookie: `__Host-fidy_session=${tokenA}` },
        }),
        db,
        support,
        telemetry,
        publish: () => {},
      });
      expect(logout.status).toBe(204);
      expect(logout.headers.get("cache-control")).toBe("no-store");
      expect(logout.headers.get("set-cookie")).toBe(
        "__Host-fidy_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
      );
      for (const user of users) {
        const session = yield* Effect.tryPromise(() =>
          authenticateWebSession({
            request: new Request("https://api.fidyapp.com/user", {
              headers: { cookie: `__Host-fidy_session=${user.token}` },
            }),
            db,
            current,
            freshness: "live",
          })
        );
        expect(Option.map(session, (subject) => subject.userId)).toEqual(
          user.token === tokenA ? Option.none() : Option.some(user.user)
        );
      }
    })
  ));

effectIt.effect("retains the composing caller's Clock when revoking the presented session", () =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    const token = "c".repeat(43);
    const digest = new Uint8Array(
      yield* Effect.tryPromise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
      )
    );
    yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare("CREATE TABLE web_sessions (token_digest BLOB, revoked_at_ms INTEGER)"),
        db.prepare("INSERT INTO web_sessions VALUES (?, NULL)").bind(digest),
      ])
    );
    yield* TestClock.setTime(4102444800000);
    const outcome = yield* Effect.exit(
      handleWebAuthentication({
        request: new Request("https://api.fidyapp.com/web/session/logout", {
          method: "POST",
          headers: { cookie: `__Host-fidy_session=${token}` },
        }),
        db,
        support,
        telemetry,
        publish: () => {},
      }).pipe(
        Effect.map((response) => ({
          status: response.status,
          cookie: response.headers.get("set-cookie"),
          cache: response.headers.get("cache-control"),
        }))
      )
    );
    deepStrictEqual(
      outcome,
      Exit.succeed({
        status: 204,
        cookie: "__Host-fidy_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        cache: "no-store",
      })
    );
    expect(
      yield* Effect.tryPromise(() => db.prepare("SELECT revoked_at_ms FROM web_sessions").first())
    ).toEqual({ revoked_at_ms: 4102444800000 });
  })
);
