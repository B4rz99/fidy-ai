import { deepStrictEqual } from "node:assert";
import { afterAll, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { handleWebAuthentication } from "./operations";
import {
  seedSession,
  sessionId,
  sessionRequest,
  sessionToken,
  sessionUser,
} from "./session.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const current = 4102444800000;

it.effect.each([
  { boundary: "idle expiry", idle: current, hard: 4110220800000, revoked: null },
  { boundary: "hard expiry", idle: 4105036800000, hard: current, revoked: null },
  { boundary: "revocation", idle: 4102444801000, hard: 4110220800000, revoked: 4102444799999 },
])(
  "refuses current-user at the composing Clock's $boundary without renewal or Audit",
  ({ idle, hard, revoked }) =>
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seedSession({ db, idle, hard });
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE web_sessions SET revoked_at_ms = ?").bind(revoked).run()
      );
      yield* TestClock.setTime(current);
      const outcome = yield* Effect.exit(
        handleWebAuthentication(sessionRequest({ db, logout: false })).pipe(
          Effect.flatMap((response) =>
            Effect.tryPromise(() => response.json()).pipe(
              Effect.map((body) => ({
                status: response.status,
                cookie: response.headers.get("set-cookie"),
                body,
              }))
            )
          )
        )
      );
      deepStrictEqual(
        outcome,
        Exit.succeed({
          status: 401,
          cookie: null,
          body: {
            error: { code: "unauthenticated", message: "Present a valid credential and retry." },
            next: [],
          },
        })
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT idle_expires_at_ms, hard_expires_at_ms, revoked_at_ms FROM web_sessions"
            )
            .first()
        )
      ).toEqual({ idle_expires_at_ms: idle, hard_expires_at_ms: hard, revoked_at_ms: revoked });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM canonical_user_reads").first()
        )
      ).toEqual({ count: 0 });
    })
);

it.effect.each([
  { renewal: "thirty days", idle: 4102444801000, hard: 4110220800000, renewed: 4105036800000 },
  {
    renewal: "the hard-expiry cap",
    idle: 4102444801000,
    hard: 4102444802000,
    renewed: 4102444802000,
  },
  {
    renewal: "an already longer idle lifetime",
    idle: 4105036801000,
    hard: 4110220800000,
    renewed: 4105036801000,
  },
])(
  "renews and audits live use with $renewal at the composing Clock without extending freshness or hard expiry",
  ({ idle, hard, renewed }) =>
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seedSession({ db, idle, hard });
      yield* TestClock.setTime(current);
      const outcome = yield* Effect.exit(
        handleWebAuthentication(sessionRequest({ db, logout: false })).pipe(
          Effect.flatMap((response) =>
            Effect.tryPromise(() => response.json()).pipe(
              Effect.map((body) => ({
                status: response.status,
                cookie: response.headers.get("set-cookie"),
                cache: response.headers.get("cache-control"),
                body,
              }))
            )
          )
        )
      );
      deepStrictEqual(
        outcome,
        Exit.succeed({
          status: 200,
          cache: "no-store",
          cookie: `__Host-fidy_session=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          body: {
            data: {
              id: sessionUser,
              serviceMarket: "CO",
              locale: "es-CO",
              timeZone: "America/Bogota",
              createdAt: "1970-01-01T00:00:00.000Z",
              trialPeriod: {
                startedAt: "1970-01-01T00:00:00.000Z",
                endsAt: "1970-01-08T00:00:00.000Z",
              },
            },
            next: [],
          },
        })
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT idle_expires_at_ms, hard_expires_at_ms, fresh_until_ms FROM web_sessions"
            )
            .first()
        )
      ).toEqual({
        idle_expires_at_ms: renewed,
        hard_expires_at_ms: hard,
        fresh_until_ms: 4102444200000,
      });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT user_id, session_id, occurred_at_ms FROM canonical_user_reads").all()
        )).results
      ).toEqual([{ user_id: sessionUser, session_id: sessionId, occurred_at_ms: current }]);
    })
);
