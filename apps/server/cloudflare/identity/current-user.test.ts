import { prepareCurrentUser } from "../../src/shell/identity/operations";
import { Unavailable } from "../../src/shell/public-http/contract";
import { User, UserId } from "../../src/core/identity/contract";
import { Effect, Exit, Schema } from "effect";
import assert from "node:assert/strict";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { IdentityUnavailable } from "./contract";
import { readCurrentUser } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("10000000-0000-4000-8000-000000000002");

const setup = (): Effect.Effect<D1Database, never> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare(
          "CREATE TABLE users (id TEXT PRIMARY KEY, service_market TEXT, locale TEXT, time_zone TEXT, created_at_ms INTEGER)"
        ),
        db.prepare(
          "CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY, started_at_ms INTEGER, ends_at_ms INTEGER)"
        ),
        db.prepare("CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY)"),
        db
          .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1000)")
          .bind(userA),
        db
          .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/New_York', 2000)")
          .bind(userB),
        db.prepare("INSERT INTO trial_periods VALUES (?, 1000, 604801000)").bind(userA),
        db.prepare("INSERT INTO trial_periods VALUES (?, 2000, 604802000)").bind(userB),
        db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(userA),
      ])
    );
    return db;
  }).pipe(Effect.orDie);

it("returns only the resolved User's complete canonical projection and original TrialPeriod", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const current = yield* readCurrentUser({ db, userId: userA });
      expect(yield* Schema.encodeEffect(Schema.toCodecJson(User))(current.data)).toEqual({
        id: userA,
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: "America/Bogota",
        createdAt: "1970-01-01T00:00:01.000Z",
        trialPeriod: {
          startedAt: "1970-01-01T00:00:01.000Z",
          endsAt: "1970-01-08T00:00:01.000Z",
        },
      });
      expect(current.next).toEqual([]);
    })
  ));

it("refuses a User without their own current Consent grant without borrowing another User's projection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const currentB = readCurrentUser({ db, userId: userB });
      assert.deepStrictEqual(yield* Effect.exit(currentB), Exit.fail(new IdentityUnavailable()));
      yield* Effect.tryPromise(() =>
        db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(userB).run()
      );
      expect((yield* currentB).data.id).toBe(userB);
      yield* Effect.tryPromise(() =>
        db.prepare("DELETE FROM onboarding_consent_records WHERE user_id = ?").bind(userB).run()
      );
      assert.deepStrictEqual(yield* Effect.exit(currentB), Exit.fail(new IdentityUnavailable()));
      expect((yield* readCurrentUser({ db, userId: userA })).data.id).toBe(userA);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM trial_periods ORDER BY user_id").all()
        )).results
      ).toEqual([
        { user_id: userA, started_at_ms: 1000, ends_at_ms: 604801000 },
        { user_id: userB, started_at_ms: 2000, ends_at_ms: 604802000 },
      ]);
    })
  ));

it.each([
  {
    invalid: "User context",
    sql: "UPDATE users SET time_zone = 'invalid/private-context' WHERE id = ?",
  },
  {
    invalid: "original TrialPeriod",
    sql: "UPDATE trial_periods SET ends_at_ms = 2000 WHERE user_id = ?",
  },
  { invalid: "missing TrialPeriod", sql: "DELETE FROM trial_periods WHERE user_id = ?" },
])("fails closed for $invalid without substituting another User's valid state", ({ sql }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(sql).bind(userA),
          db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(userB),
        ])
      );
      assert.deepStrictEqual(
        yield* Effect.exit(readCurrentUser({ db, userId: userA })),
        Exit.fail(new IdentityUnavailable())
      );
      const currentB = yield* readCurrentUser({ db, userId: userB });
      expect(yield* Schema.encodeEffect(Schema.toCodecJson(User))(currentB.data)).toEqual({
        id: userB,
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: "America/New_York",
        createdAt: "1970-01-01T00:00:02.000Z",
        trialPeriod: {
          startedAt: "1970-01-01T00:00:02.000Z",
          endsAt: "1970-01-08T00:00:02.000Z",
        },
      });
    })
  )
);

it("closes inaccessible persistence into IdentityUnavailable without database diagnostics", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      assert.deepStrictEqual(
        yield* Effect.exit(readCurrentUser({ db, userId: userA })),
        Exit.fail(new IdentityUnavailable())
      );
    })
  ));

it("refuses another User's valid result at the prepared canonical read boundary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const readA = yield* prepareCurrentUser(userA);
      const readB = yield* prepareCurrentUser(userB);
      const rowB = {
        id: userB,
        service_market: "CO",
        locale: "es-CO",
        time_zone: "America/New_York",
        created_at_ms: 2000,
        started_at_ms: 2000,
        ends_at_ms: 604802000,
      };
      expect((yield* readB.decode([rowB])).data.id).toBe(userB);
      assert.deepStrictEqual(
        yield* Effect.exit(readA.decode([rowB])),
        Exit.fail(
          Unavailable.make({
            error: {
              code: "unavailable",
              message: "User data is temporarily unavailable. Retry later.",
            },
            next: [],
          })
        )
      );
      expect((yield* readA.decode([{ ...rowB, id: userA }])).data.id).toBe(userA);
    })
  ));
