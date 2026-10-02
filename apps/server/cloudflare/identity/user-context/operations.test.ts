import { UserId } from "../../../src/core/identity/contract";
import { deepStrictEqual } from "node:assert";
import { Effect, Exit, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../../d1-test-fixture";
import { UserContextUnavailable } from "./contract";
import { prepareUserContext, readUserContext } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("20000000-0000-4000-8000-000000000002");
const missingUser = UserId.make("30000000-0000-4000-8000-000000000003");
const setup = (): Promise<D1Database> =>
  databases.acquire().then((db) =>
    installTestSchema({
      db,
      sources: ["0003_pending_consent", "0004_onboarding_email", "0005_verified_onboarding"].map(
        (name) => new URL(`../../migrations/${name}.sql`, import.meta.url)
      ),
    }).then(() => db)
  );

it("reads only the explicit User's independent context, without identity storage fields", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1)")
            .bind(userA),
          db.prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'Asia/Tokyo', 2)").bind(userB),
        ])
      );
      expect(yield* readUserContext({ db, userId: userA, authority: Option.none() })).toEqual(
        Option.some({ serviceMarket: "CO", locale: "es-CO", timeZone: "America/Bogota" })
      );
      expect(yield* readUserContext({ db, userId: userB, authority: Option.none() })).toEqual(
        Option.some({ serviceMarket: "CO", locale: "es-CO", timeZone: "Asia/Tokyo" })
      );
      expect(yield* readUserContext({ db, userId: missingUser, authority: Option.none() })).toEqual(
        Option.none()
      );
    })
  ));

it("snapshots current context inside the owner's atomic unit and rolls it back with a failed action", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1)")
            .bind(userA),
          db.prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'Asia/Tokyo', 2)").bind(userB),
          db.prepare(
            "CREATE TABLE snapshots (user_id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT"
          ),
        ])
      );
      const snapshot = prepareUserContext({
        db,
        userId: userA,
        statement: {
          sql: "INSERT INTO snapshots SELECT userId, timeZone FROM identity_user_context",
          params: [],
        },
      });
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("UPDATE users SET time_zone = 'Europe/London' WHERE id = ?").bind(userA),
          snapshot,
        ])
      );
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT user_id, time_zone FROM snapshots").all())
      ).toMatchObject({ results: [{ user_id: userA, time_zone: "Europe/London" }] });
      const crossUser = yield* Effect.tryPromise(() =>
        prepareUserContext({
          db,
          userId: userA,
          statement: {
            sql: "SELECT timeZone FROM identity_user_context WHERE userId = ?",
            params: [userB],
          },
        }).first()
      );
      expect(crossUser).toBeNull();
      const refused = yield* Effect.exit(
        Effect.tryPromise(() =>
          db.batch([
            db.prepare("UPDATE users SET time_zone = 'Pacific/Auckland' WHERE id = ?").bind(userA),
            snapshot,
          ])
        )
      );
      expect(Exit.isFailure(refused)).toBe(true);
      expect(yield* readUserContext({ db, userId: userA, authority: Option.none() })).toEqual(
        Option.some({ serviceMarket: "CO", locale: "es-CO", timeZone: "Europe/London" })
      );
    })
  ));

it("rechecks credential authority and refuses a different User's subject before returning context", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1)")
            .bind(userA),
          db.prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'Asia/Tokyo', 2)").bind(userB),
          db.prepare(
            "CREATE TABLE read_permits (credential TEXT PRIMARY KEY, subject TEXT, live INTEGER) STRICT"
          ),
          db.prepare("INSERT INTO read_permits VALUES ('proof-b', ?, 1)").bind(userB),
        ])
      );
      const authority = Option.some({
        sql: "SELECT subject AS userId FROM read_permits WHERE credential = ? AND live = 1",
        params: ["proof-b"],
      });
      expect(yield* readUserContext({ db, userId: userA, authority })).toEqual(Option.none());
      expect(yield* readUserContext({ db, userId: userB, authority })).toEqual(
        Option.some({ serviceMarket: "CO", locale: "es-CO", timeZone: "Asia/Tokyo" })
      );
      yield* Effect.tryPromise(() => db.prepare("UPDATE read_permits SET live = 0").run());
      expect(yield* readUserContext({ db, userId: userB, authority })).toEqual(Option.none());
    })
  ));

it("fails closed on invalid stored context or unreadable storage without leaking a row or query", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'invalid-zone', 1)")
          .bind(userA)
          .run()
      );
      const malformed = yield* Effect.exit(
        readUserContext({ db, userId: userA, authority: Option.none() })
      );
      deepStrictEqual(malformed, Exit.fail(new UserContextUnavailable()));
      const unavailableDb = yield* Effect.tryPromise(() => databases.acquire());
      const unavailable = yield* Effect.exit(
        readUserContext({ db: unavailableDb, userId: userA, authority: Option.none() })
      );
      deepStrictEqual(unavailable, Exit.fail(new UserContextUnavailable()));
    })
  ));
