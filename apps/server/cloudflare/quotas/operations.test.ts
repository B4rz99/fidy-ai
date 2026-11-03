import { Data, DateTime, Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { installCurrentTestObjects, isolatedTestDatabases } from "../d1-test-fixture";
import {
  decodeQuotaStatus,
  prepareConsumption,
  quotaFailure,
  quotaStatusStatement,
  readQuotaStatus,
} from "./operations";

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
      db.prepare(
        "CREATE TABLE users (id TEXT PRIMARY KEY, trial_started_at_ms INTEGER, trial_ends_at_ms INTEGER ,service_market TEXT,locale TEXT,time_zone TEXT,created_at_ms INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER)"
      ),
      db.prepare(
        "CREATE TABLE subscriptions (user_id TEXT PRIMARY KEY,current_paid_attempt_id TEXT)"
      ),
      db.prepare("CREATE VIEW billing_attempt_context AS SELECT * FROM billing_attempts"),
      db.prepare(
        "CREATE VIEW subscription_standing AS SELECT s.user_id,a.id AS attempt_id,a.paid_ends_at_ms AS paid_period_ends_at_ms,a.paid_renewal_anchor_ms AS renewal_anchor_ms FROM subscriptions s JOIN billing_attempts a ON a.id=s.current_paid_attempt_id AND a.user_id=s.user_id"
      ),
      db.prepare(
        "CREATE TABLE billing_attempts (id TEXT, user_id TEXT, payment_source_id TEXT, billing_period TEXT, paid_starts_at_ms INTEGER,paid_ends_at_ms INTEGER,paid_renewal_anchor_ms INTEGER)"
      ),
      db.prepare("CREATE TABLE payment_source_context (id TEXT, user_id TEXT, method TEXT)"),
      db.prepare("CREATE TABLE subscription_renewal_stops (user_id TEXT)"),
      db.prepare(
        "CREATE VIEW subscription_renewal_fences AS SELECT * FROM subscription_renewal_stops"
      ),
      db.prepare("CREATE TABLE refund_attempts(billing_attempt_id TEXT,access_ends_at_ms INTEGER)"),
      db.prepare("CREATE TABLE authority (userId TEXT PRIMARY KEY, live INTEGER)"),
      db.prepare("CREATE TABLE publication (id TEXT PRIMARY KEY)"),
      db
        .prepare(
          "WITH fixture_user(id) AS (VALUES (?),(?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) SELECT id,'CO','es-CO','America/Bogota',0 FROM fixture_user"
        )
        .bind(userId, otherUser),
      db.prepare("INSERT INTO authority VALUES (?,1),(?,1)").bind(userId, otherUser),
    ])
  );
  yield* io(() =>
    installCurrentTestObjects({
      db,
      tables: ["commercial_allowance_consumptions", "canonical_request_replays"],
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

it("reads current allowance standing without scanning earlier months or another User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* database;
      const period = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-01T05:00:00Z"));
      const earlier = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-06-01T05:00:00Z"));
      yield* io(() =>
        db
          .prepare(`WITH allowances(kind) AS (
          VALUES ('forwarded_email'),('media_submission'),('hosted_history_turn'),('canonical_call')
        ), subjects(id, charged) AS (VALUES (?,0),(?,1)), units(n) AS (VALUES (0),(1))
        INSERT INTO commercial_allowance_consumptions(user_id,allowance,identity,period_start_ms,accepted_at_ms,units)
        SELECT id,kind,'current-' || n,?,?,CASE WHEN charged=0 THEN n ELSE 1 END
        FROM allowances CROSS JOIN subjects CROSS JOIN units`)
          .bind(userId, otherUser, period, current)
          .run()
      );
      const before = yield* io(() => quotaStatusStatement({ db, userId, current }).all());
      expect(before.results).toEqual([
        {
          pro: 0,
          forwarded_email: 1,
          media_submission: 1,
          hosted_history_turn: 1,
          canonical_call: 1,
        },
      ]);
      yield* io(() =>
        db
          .prepare(`WITH RECURSIVE entries(n) AS (
          SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n < 120
        ), allowances(kind) AS (
          VALUES ('forwarded_email'),('media_submission'),('hosted_history_turn'),('canonical_call')
        ), subjects(id) AS (VALUES (?),(?))
        INSERT INTO commercial_allowance_consumptions(user_id,allowance,identity,period_start_ms,accepted_at_ms,units)
        SELECT id,kind,'earlier-' || n,?,?,CASE WHEN n<=2 THEN 1 ELSE 0 END FROM entries CROSS JOIN allowances CROSS JOIN subjects`)
          .bind(userId, otherUser, earlier, earlier)
          .run()
      );
      const after = yield* io(() => quotaStatusStatement({ db, userId, current }).all());
      expect(after.results).toEqual(before.results);
      expect(after.meta.rows_written).toBe(0);
      expect(
        Option.getOrThrow(decodeQuotaStatus({ row: after.results[0], current }))
      ).toMatchObject({
        accessTier: "free",
        forwardedEmails: { consumed: 1, remaining: 29 },
        mediaSubmissions: { consumed: 1, remaining: 1 },
        hostedHistoryTurns: { consumed: 1, remaining: 1 },
        canonicalCalls: { consumed: 1, remaining: 49 },
      });
      const previousMonth = yield* io(() =>
        quotaStatusStatement({ db, userId, current: period - 1 }).first()
      );
      expect(previousMonth).toEqual({
        pro: 0,
        forwarded_email: 2,
        media_submission: 2,
        hosted_history_turn: 2,
        canonical_call: 2,
      });
      const emptyMonth = yield* io(() =>
        quotaStatusStatement({
          db,
          userId,
          current: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-08-01T05:00:00Z")),
        }).first()
      );
      expect(emptyMonth).toEqual({
        pro: 0,
        forwarded_email: 0,
        media_submission: 0,
        hosted_history_turn: 0,
        canonical_call: 0,
      });
      const trialStarts = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-29T05:00:00Z"));
      const trialEnds = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-08-05T05:00:00Z"));
      yield* io(() =>
        db
          .prepare("UPDATE users SET trial_started_at_ms = ?, trial_ends_at_ms = ? WHERE id = ?")
          .bind(trialStarts, trialEnds, userId)
          .run()
      );
      expect(
        yield* io(() =>
          quotaStatusStatement({
            db,
            userId,
            current: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-08-01T05:00:00Z")),
          }).first()
        )
      ).toEqual({
        ...emptyMonth,
        pro: 1,
      });
      expect(
        yield* io(() => quotaStatusStatement({ db, userId, current: trialEnds }).first())
      ).toEqual(emptyMonth);
      expect(after.meta.rows_read).toBeLessThanOrEqual(before.meta.rows_read + 16);
    })
  ));
