import { Data, DateTime, Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { applyTestMigration, isolatedTestDatabases } from "../d1-test-fixture";
import { prepareConsumption, quotaFailure, readQuotaStatus } from "./operations";

const pool = isolatedTestDatabases();
afterAll(() => pool.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const otherUser = "10000000-0000-4000-8000-000000000002";
const current = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-15T12:00:00Z"));
class TestFailure extends Data.TaggedError("TestFailure")<{ readonly cause: unknown }> {}
const io = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: work, catch: (cause) => new TestFailure({ cause }) }).pipe(Effect.orDie);
const database = Effect.gen(function* () {
  const db = yield* io(() => pool.acquire());
  yield* io(() =>
    db.batch([
      db.prepare("CREATE TABLE users (id TEXT PRIMARY KEY)"),
      db.prepare(
        "CREATE TABLE trial_periods (user_id TEXT, started_at_ms INTEGER, ends_at_ms INTEGER)"
      ),
      db.prepare(
        "CREATE TABLE subscriptions (user_id TEXT, paid_period_ends_at_ms INTEGER, attempt_id TEXT)"
      ),
      db.prepare("CREATE TABLE billing_paid_periods (attempt_id TEXT, starts_at_ms INTEGER)"),
      db.prepare("CREATE TABLE billing_access_adjustments (attempt_id TEXT, ends_at_ms INTEGER)"),
      db.prepare("CREATE TABLE authority (userId TEXT PRIMARY KEY, live INTEGER)"),
      db.prepare("CREATE TABLE publication (id TEXT PRIMARY KEY)"),
      db.prepare("INSERT INTO users VALUES (?),(?)").bind(userId, otherUser),
      db.prepare("INSERT INTO authority VALUES (?,1),(?,1)").bind(userId, otherUser),
    ])
  );
  yield* io(() =>
    applyTestMigration({
      db,
      source: new URL("../migrations/0032_commercial_allowances.sql", import.meta.url),
    })
  );
  return db;
});
const consume = (
  db: D1Database,
  identity: string,
  subject = userId
): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...prepareConsumption({
      db,
      userId,
      allowance: "media_submission",
      identity,
      current,
      authority: {
        sql: "SELECT userId FROM authority WHERE userId = ? AND live = 1",
        params: [subject],
      },
    }),
    db.prepare("INSERT INTO publication VALUES (?)").bind(identity),
  ]);

it("publishes only one of two concurrent submissions competing for the last media unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database;
      yield* io(() => consume(db, "first"));
      const results = yield* io(() =>
        Promise.allSettled([consume(db, "second"), consume(db, "third")])
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((result) => result.status === "rejected");
      expect(failed?.status === "rejected" && quotaFailure(failed.reason)).toBe("exhausted");
      const standing = yield* readQuotaStatus({ db, userId, current });
      expect(Option.getOrThrow(standing).mediaSubmissions).toMatchObject({
        _tag: "Limited",
        consumed: 2,
        remaining: 0,
      });
      const published = yield* io(() =>
        db.prepare("SELECT count(*) AS count FROM publication").first()
      );
      expect(published?.count).toBe(2);
    })
  ));

it("rejects another User's live proof without consumption or publication", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database;
      const result = yield* io(() =>
        consume(db, "foreign", otherUser).then(
          () => "accepted",
          (failure: unknown) => quotaFailure(failure)
        )
      );
      expect(result).toBe("authority");
      const standing = yield* readQuotaStatus({ db, userId, current });
      expect(Option.getOrThrow(standing).mediaSubmissions).toMatchObject({ consumed: 0 });
      expect(
        yield* io(() => db.prepare("SELECT count(*) AS count FROM publication").first())
      ).toEqual({ count: 0 });
    })
  ));

it("keeps exact replay uncharged and rolls consumption back with a failed publication", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database;
      yield* io(() => consume(db, "same"));
      yield* io(() => consume(db, "same").catch(() => undefined));
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current })).mediaSubmissions
      ).toMatchObject({ consumed: 1 });
      yield* io(() =>
        db
          .batch([
            ...prepareConsumption({
              db,
              userId,
              allowance: "media_submission",
              identity: "rollback",
              current,
              authority: { sql: "SELECT userId FROM authority WHERE userId = ?", params: [userId] },
            }),
            db.prepare("INSERT INTO publication VALUES ('same')"),
          ])
          .catch(() => undefined)
      );
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current })).mediaSubmissions
      ).toMatchObject({ consumed: 1 });
    })
  ));

it("uses corrected paid standing at publication without retroactively charging Pro acceptance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database;
      yield* io(() =>
        db.batch([
          db
            .prepare("INSERT INTO subscriptions VALUES (?,?,?)")
            .bind(userId, current + 1, "paid-attempt"),
          db
            .prepare("INSERT INTO billing_paid_periods VALUES (?,?)")
            .bind("paid-attempt", current - 1),
        ])
      );
      yield* io(() => consume(db, "paid"));
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current })).mediaSubmissions
      ).toEqual({ _tag: "Uncapped" });
      yield* io(() =>
        db
          .prepare("INSERT INTO billing_access_adjustments VALUES (?,?)")
          .bind("paid-attempt", current)
          .run()
      );
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current })).mediaSubmissions
      ).toMatchObject({ _tag: "Limited", consumed: 0, remaining: 2 });
      yield* io(() => consume(db, "free-after-correction"));
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current })).mediaSubmissions
      ).toMatchObject({ _tag: "Limited", consumed: 1, remaining: 1 });
    })
  ));

it("leaves Trial use unmetered and begins a fresh Free meter at exclusive expiry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database;
      yield* io(() =>
        db
          .prepare("INSERT INTO trial_periods VALUES (?,?,?)")
          .bind(userId, current - 1, current + 1)
          .run()
      );
      yield* io(() => consume(db, "trial"));
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current })).mediaSubmissions
      ).toEqual({ _tag: "Uncapped" });
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current: current + 1 }))
          .mediaSubmissions
      ).toMatchObject({ _tag: "Limited", consumed: 0, remaining: 2 });
    })
  ));
