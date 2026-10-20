import { prepareCurrentUser } from "../../src/shell/identity/operations";
import { Unavailable } from "../../src/shell/public-http/contract";
import { User, UserId } from "../../src/core/identity/contract";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import assert from "node:assert/strict";
import { afterAll, expect, it } from "vitest";
import {
  consentHistoryTestSchema,
  installCurrentTestObjects,
  isolatedTestDatabases,
} from "../d1-test-fixture";
import { IdentityUnavailable } from "./contract";
import { readCurrentUser } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("10000000-0000-4000-8000-000000000002");

const setup = (): Effect.Effect<D1Database, never> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() => installCurrentTestObjects({ db, tables: [] }));
    yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare(
          "CREATE TABLE users (paid_attempt_id TEXT,paid_price_id TEXT,paid_period_ends_at_ms INTEGER,paid_renewal_anchor_ms INTEGER,audit_retention_cutoff_ms INTEGER,id TEXT PRIMARY KEY, service_market TEXT, locale TEXT, time_zone TEXT, created_at_ms INTEGER, trial_started_at_ms INTEGER, trial_ends_at_ms INTEGER ,verified_email_address TEXT,email_verified_at_ms INTEGER,recovery_code_digest BLOB,recovery_created_at_ms INTEGER,recovery_consumed_at_ms INTEGER,recovery_revision INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER,route_portfolio_id TEXT,route_bsuid TEXT,route_phone_number_id TEXT,route_verified_at_ms INTEGER)"
        ),
        db.prepare(consentHistoryTestSchema),
        db
          .prepare(
            "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1000)"
          )
          .bind(userA),
        db
          .prepare(
            "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/New_York', 2000)"
          )
          .bind(userB),
        db
          .prepare(
            "UPDATE users SET trial_started_at_ms=1000,trial_ends_at_ms=604801000 WHERE id=?1"
          )
          .bind(userA),
        db
          .prepare(
            "UPDATE users SET trial_started_at_ms=2000,trial_ends_at_ms=604802000 WHERE id=?1"
          )
          .bind(userB),
        db
          .prepare(
            "INSERT INTO consent_history (record_type,user_id) VALUES ('processing_grant',?)"
          )
          .bind(userA),
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
        db
          .prepare(
            "INSERT INTO consent_history (record_type,user_id) VALUES ('processing_grant',?)"
          )
          .bind(userB)
          .run()
      );
      expect((yield* currentB).data.id).toBe(userB);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "DELETE FROM consent_history AS onboarding_consent_records WHERE onboarding_consent_records.record_type='processing_grant' AND user_id = ?"
          )
          .bind(userB)
          .run()
      );
      assert.deepStrictEqual(yield* Effect.exit(currentB), Exit.fail(new IdentityUnavailable()));
      expect((yield* readCurrentUser({ db, userId: userA })).data.id).toBe(userA);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id AS user_id,trial_started_at_ms AS started_at_ms,trial_ends_at_ms AS ends_at_ms FROM users ORDER BY id"
            )
            .all()
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
    sql: "UPDATE users SET trial_ends_at_ms = 2000 WHERE id = ?",
  },
  {
    invalid: "missing TrialPeriod",
    sql: "UPDATE users SET trial_started_at_ms = NULL,trial_ends_at_ms = NULL WHERE id = ?",
  },
])("fails closed for $invalid without substituting another User's valid state", ({ sql }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(sql).bind(userA),
          db
            .prepare(
              "INSERT INTO consent_history (record_type,user_id) VALUES ('processing_grant',?)"
            )
            .bind(userB),
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

it.each(["created_at_ms", "started_at_ms", "ends_at_ms"])(
  "closes an out-of-range retained %s into a typed unavailable result",
  (field) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const read = yield* prepareCurrentUser(userA);
        const row = {
          id: userA,
          service_market: "CO",
          locale: "es-CO",
          time_zone: "America/Bogota",
          created_at_ms: 1000,
          started_at_ms: 1000,
          ends_at_ms: 604801000,
        };
        expect((yield* read.decode([row])).data.id).toBe(userA);
        const exit = yield* read.decode([{ ...row, [field]: 1e20 }]).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(false);
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(Unavailable);
        }
      })
    )
);

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
