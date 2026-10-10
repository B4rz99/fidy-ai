import { Data, Effect, Result } from "effect";
import { afterAll, expect, it } from "vitest";
import { UserId } from "../../src/core/identity/contract";
import {
  installRetentionTestSchema,
  isolatedTestDatabases,
  observeRetentionCost,
} from "../d1-test-fixture";
import {
  expireInsightChannelEvidence,
  expireWeeklyQuestions,
  sweepInsightChannelEvidence,
  sweepProactivityChannelEvidence,
} from "./operations";

class RetentionTestFailure extends Data.TaggedError("RetentionTestFailure")<{ cause: unknown }> {}
const io = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: (cause) => new RetentionTestFailure({ cause }) }).pipe(
    Effect.orDie
  );

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const user = UserId.make("00000000-0000-4000-8000-000000000001");
const other = UserId.make("00000000-0000-4000-8000-000000000002");
const now = 5_000_000_000;
const lifetime = 2_592_000_000;
const owners = [
  { kind: "weekly", table: "weekly_governor_questions", sweep: expireWeeklyQuestions },
  { kind: "insight", table: "insight_whatsapp_claims", sweep: sweepInsightChannelEvidence },
  {
    kind: "proactivity",
    table: "proactivity_whatsapp_claims",
    sweep: sweepProactivityChannelEvidence,
  },
] as const;
type Owner = (typeof owners)[number];
const prepare = (): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* io(() => databases.acquire());
      yield* io(() => installRetentionTestSchema(db));
      yield* io(() =>
        db
          .prepare("INSERT INTO users VALUES (?,'CO','es-CO','UTC',0),(?,'CO','es-CO','UTC',0)")
          .bind(user, other)
          .run()
      );
      return db;
    })
  );
const seed = (
  db: D1Database,
  kind: Owner["kind"],
  input: Readonly<{
    prefix: string;
    count: number;
    userId: UserId;
    content: boolean;
    sent: boolean;
    due: number;
  }>
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const owner = input.userId;
      const cte = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) ";
      const created = input.sent ? input.due - lifetime : input.due - 1;
      const expires = input.sent ? created + 1 : input.due;
      const text = input.content ? "retained body" : null;
      if (kind === "weekly") {
        yield* io(() =>
          db.batch([
            db
              .prepare(`${cte}INSERT INTO weekly_consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms)
        SELECT ?||i,?,'p','b','{}',?,? FROM n`)
              .bind(input.count, input.prefix, owner, created, expires),
            db
              .prepare(`${cte}INSERT INTO weekly_governor_questions
        (id,user_id,offer_id,created_at_ms,expires_at_ms,state,correlation_token,portfolio_id,bsuid,business_phone_number_id,text,offer_json,time_zone)
        SELECT ?||i,?,?||i,?,?,?,?||i,'p','b','phone',?,NULL,'UTC' FROM n`)
              .bind(
                input.count,
                input.prefix,
                owner,
                input.prefix,
                created,
                expires,
                input.sent ? "accepted" : "ready",
                input.prefix,
                text
              ),
          ])
        );
      } else if (kind === "insight") {
        yield* io(() =>
          db.batch([
            db
              .prepare(`${cte}INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json)
        SELECT ?||i,?,'weekly-summary',?,1,'CO','es-CO','UTC',cast(i AS text),'[]' FROM n`)
              .bind(input.count, input.prefix, owner, input.prefix),
            db
              .prepare(`${cte}INSERT INTO insight_whatsapp_claims
        (user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,text)
        SELECT ?,?||i,?||i,'p','b','phone',?,?,'UTC',?,?,? FROM n`)
              .bind(
                input.count,
                owner,
                input.prefix,
                input.prefix,
                created,
                expires,
                input.sent ? "accepted" : "staged",
                input.sent ? created : null,
                text
              ),
          ])
        );
      } else {
        yield* io(() =>
          db
            .prepare(`${cte}INSERT INTO proactivity_whatsapp_claims
      (user_id,delivery_id,role,correlation_token,portfolio_id,bsuid,business_phone_number_id,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,text)
      SELECT ?,?||i,'budget-offer',?||i,'p','b','phone',?,?,'UTC',?,?,? FROM n`)
            .bind(
              input.count,
              owner,
              input.prefix,
              input.prefix,
              created,
              expires,
              input.sent ? "accepted" : "staged",
              input.sent ? created : null,
              text
            )
            .run()
        );
      }
    })
  );
const contentCount = (
  db: D1Database,
  table: Owner["table"],
  owner: UserId = user
): Promise<unknown> =>
  db
    .prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id=? AND text IS NOT NULL`)
    .bind(owner)
    .first("count");

it.each(owners)(
  "$kind idle retention skips cleared history and future content on every tick",
  ({ kind, table, sweep }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* io(() => prepare());
        yield* io(() =>
          seed(db, kind, {
            userId: user,
            prefix: "cleared-",
            count: 4_000,
            content: false,
            sent: true,
            due: now - 1,
          })
        );
        yield* io(() =>
          seed(db, kind, {
            userId: user,
            prefix: "active-sent-",
            count: 4_000,
            content: true,
            sent: true,
            due: now + 1,
          })
        );
        yield* io(() =>
          seed(db, kind, {
            userId: user,
            prefix: "active-staged-",
            count: 4_000,
            content: true,
            sent: false,
            due: now + 1,
          })
        );
        for (let tick = 0; tick < 3; tick += 1) {
          if (tick === 1) yield* io(() => db.prepare("ANALYZE").run());
          const observed = observeRetentionCost(db);
          yield* sweep({ db: observed.database, now });
          expect(observed.cost().rowsWritten).toBe(0);
          expect(observed.cost().rowsRead).toBeLessThanOrEqual(16);
          const plans = yield* io(() => observed.plans());
          expect(
            plans.some((plan) => plan.includes("SEARCH") && plan.includes("content_retention"))
          ).toBe(true);
        }
        expect(yield* io(() => contentCount(db, table))).toBe(8_000);
      })
    )
);

it.each(owners)(
  "$kind drains both deadline branches in bounded batches without rewriting correlation evidence",
  ({ kind, table, sweep }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* io(() => prepare());
        yield* io(() =>
          seed(db, kind, {
            userId: user,
            prefix: "due-sent-",
            count: 300,
            content: true,
            sent: true,
            due: now,
          })
        );
        yield* io(() =>
          seed(db, kind, {
            userId: user,
            prefix: "due-staged-",
            count: 300,
            content: true,
            sent: false,
            due: now,
          })
        );
        yield* io(() =>
          seed(db, kind, {
            prefix: "foreign-live-",
            count: 1,
            userId: other,
            content: true,
            sent: true,
            due: now + 1,
          })
        );
        yield* sweep({ db, now: now - 1 });
        expect(yield* io(() => contentCount(db, table))).toBe(600);
        for (let tick = 0; tick < 5; tick += 1) {
          const observed = observeRetentionCost(db);
          yield* sweep({ db: observed.database, now });
          expect(observed.cost().rowsRead).toBeLessThanOrEqual(2_000);
          expect(observed.cost().rowsWritten).toBeLessThanOrEqual(1_000);
          expect(yield* io(() => contentCount(db, table))).toBe(
            Math.max(0, 600 - 128 * (tick + 1))
          );
          expect(yield* io(() => contentCount(db, table, other))).toBe(1);
        }
        expect(
          yield* io(() => db.prepare(`SELECT count(*) AS count FROM ${table}`).first("count"))
        ).toBe(601);
        const repeated = observeRetentionCost(db);
        yield* sweep({ db: repeated.database, now });
        expect(repeated.cost().rowsWritten).toBe(0);
        expect(repeated.cost().rowsRead).toBeLessThanOrEqual(16);
      })
    )
);

it("User-scoped insight expiry bounds a single User backlog and cannot clear another User's expired body", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* io(() => prepare());
      yield* io(() =>
        seed(db, "insight", {
          userId: user,
          prefix: "owned-",
          count: 300,
          content: true,
          sent: true,
          due: now,
        })
      );
      yield* io(() =>
        seed(db, "insight", {
          prefix: "foreign-",
          count: 4_000,
          userId: other,
          content: true,
          sent: true,
          due: now,
        })
      );
      for (let tick = 0; tick < 5; tick += 1) {
        const observed = observeRetentionCost(db);
        yield* expireInsightChannelEvidence({ db: observed.database, userId: user, now });
        expect(observed.cost().rowsRead).toBeLessThanOrEqual(1_000);
        expect(yield* io(() => contentCount(db, "insight_whatsapp_claims"))).toBe(
          Math.max(0, 300 - 64 * (tick + 1))
        );
        expect(yield* io(() => contentCount(db, "insight_whatsapp_claims", other))).toBe(4_000);
      }
      const repeated = observeRetentionCost(db);
      yield* expireInsightChannelEvidence({ db: repeated.database, userId: user, now });
      expect(repeated.cost().rowsRead).toBeLessThanOrEqual(16);
      expect(repeated.cost().rowsWritten).toBe(0);
    })
  ));

it.each(owners)(
  "$kind rolls back sent-content erasure if the staged-content branch fails",
  ({ kind, table, sweep }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* io(() => prepare());
        yield* io(() =>
          seed(db, kind, {
            userId: user,
            prefix: "sent-",
            count: 1,
            content: true,
            sent: true,
            due: now,
          })
        );
        yield* io(() =>
          seed(db, kind, {
            userId: user,
            prefix: "staged-",
            count: 1,
            content: true,
            sent: false,
            due: now,
          })
        );
        yield* io(() =>
          db
            .prepare(`CREATE TRIGGER refuse_content_retention BEFORE UPDATE ON ${table}
      WHEN OLD.state IN ('ready','staged') BEGIN SELECT RAISE(ABORT,'test_retention_failure'); END`)
            .run()
        );
        const result = yield* Effect.result(sweep({ db, now }));
        expect(Result.isFailure(result)).toBe(true);
        expect(yield* io(() => contentCount(db, table))).toBe(2);
      })
    )
);
