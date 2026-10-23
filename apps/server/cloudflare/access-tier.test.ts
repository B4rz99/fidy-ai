import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { Effect } from "effect";
import { activeProUserCondition } from "../src/shell/access-tier/operations";

const userId = "10000000-0000-4000-8000-000000000001";

it("derives each decision from one User's original trial and current settled paid interval", () =>
  Effect.gen(function* () {
    const mf = new Miniflare({
      workers: [
        {
          config: {
            name: "access-tier-window",
            type: "worker",
            compatibilityDate: "2026-09-08",
            env: { DB: { id: "access-tier-window", type: "d1" } },
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
    try {
      yield* Effect.tryPromise(() => mf.ready);
      const db = yield* Effect.tryPromise(() => mf.getD1Database("DB"));
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE users (paid_attempt_id TEXT,paid_price_id TEXT,paid_period_ends_at_ms INTEGER,paid_renewal_anchor_ms INTEGER,id TEXT PRIMARY KEY, trial_started_at_ms INTEGER, trial_ends_at_ms INTEGER ,service_market TEXT,locale TEXT,time_zone TEXT,created_at_ms INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER)"
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
          db.prepare(
            "CREATE TABLE refund_attempts(id TEXT,billing_attempt_id TEXT,access_ends_at_ms INTEGER,renewal_stopped_user_id TEXT)"
          ),
          db
            .prepare(
              "WITH fixture_user(id,trial_started_at_ms,trial_ends_at_ms) AS (VALUES (?1,200,300)) INSERT INTO users(id,trial_started_at_ms,trial_ends_at_ms,service_market,locale,time_zone,created_at_ms) SELECT id,trial_started_at_ms,trial_ends_at_ms,'CO','es-CO','America/Bogota',0 FROM fixture_user"
            )
            .bind(userId),
          db
            .prepare(
              "WITH fixture_user(id,trial_started_at_ms,trial_ends_at_ms) AS (VALUES (?1,100,350)) INSERT INTO users(id,trial_started_at_ms,trial_ends_at_ms,service_market,locale,time_zone,created_at_ms) SELECT id,trial_started_at_ms,trial_ends_at_ms,'CO','es-CO','America/Bogota',0 FROM fixture_user"
            )
            .bind("20000000-0000-4000-8000-000000000002"),
        ])
      );
      const tier = (at: number, subject: string = userId): Promise<number> => {
        const pro = activeProUserCondition({ userId: subject, nowEpochMs: at });
        return db
          .prepare(`SELECT ${pro.sql} AS active`)
          .bind(...pro.params)
          .first<{ active: number }>()
          .then((row) => row?.active ?? -1);
      };
      expect(yield* Effect.tryPromise(() => tier(250, "contact-123"))).toBe(0);
      expect(yield* Effect.tryPromise(() => tier(199))).toBe(0);
      expect(yield* Effect.tryPromise(() => tier(200))).toBe(1);
      expect(yield* Effect.tryPromise(() => tier(300))).toBe(0);
      expect(yield* Effect.tryPromise(() => tier(400))).toBe(0);
      const currentPaidAccess = activeProUserCondition({ userId, nowEpochMs: 450 });
      const observePaidAccess = (): Promise<number> =>
        db
          .prepare(`SELECT ${currentPaidAccess.sql} AS active`)
          .bind(...currentPaidAccess.params)
          .first<{ active: number }>()
          .then((row) => row?.active ?? -1);
      expect(yield* Effect.tryPromise(observePaidAccess)).toBe(0);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO subscriptions(user_id,current_paid_attempt_id) VALUES(?,'attempt')"
            )
            .bind(userId),
          db
            .prepare(
              "INSERT INTO billing_attempts(id,user_id,payment_source_id,billing_period) VALUES ('attempt', ?, 'source', 'weekly')"
            )
            .bind(userId),
          db.prepare(
            "UPDATE billing_attempts SET paid_starts_at_ms=incoming.starts_at_ms,paid_ends_at_ms=incoming.ends_at_ms FROM (SELECT 'attempt' AS attempt_id,400 AS starts_at_ms,500 AS ends_at_ms) AS incoming WHERE billing_attempts.id=incoming.attempt_id AND billing_attempts.paid_starts_at_ms IS NULL"
          ),
          db
            .prepare("INSERT INTO payment_source_context VALUES ('source', ?, 'nequi')")
            .bind(userId),
        ])
      );
      expect(yield* Effect.tryPromise(observePaidAccess)).toBe(1);
      expect(yield* Effect.tryPromise(() => tier(399))).toBe(0);
      expect(yield* Effect.tryPromise(() => tier(400))).toBe(1);
      expect(yield* Effect.tryPromise(() => tier(500))).toBe(1);
      expect(yield* Effect.tryPromise(() => tier(500 + 259200000))).toBe(0);
      expect(yield* Effect.tryPromise(() => tier(99, "20000000-0000-4000-8000-000000000002"))).toBe(
        0
      );
      expect(
        yield* Effect.tryPromise(() => tier(300, "20000000-0000-4000-8000-000000000002"))
      ).toBe(1);
      expect(
        yield* Effect.tryPromise(() => tier(450, "30000000-0000-4000-8000-000000000003"))
      ).toBe(0);
      expect(
        yield* Effect.tryPromise(() => tier(450, "20000000-0000-4000-8000-000000000002"))
      ).toBe(0);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO refund_attempts(billing_attempt_id,access_ends_at_ms) VALUES ('attempt',450)"
          )
          .run()
      );
      expect(yield* Effect.tryPromise(() => tier(449))).toBe(1);
      expect(yield* Effect.tryPromise(() => tier(450))).toBe(0);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO billing_attempts(id,user_id,payment_source_id,billing_period) VALUES ('newer-attempt', ?, 'source', 'weekly')"
            )
            .bind(userId),
          db.prepare(
            "UPDATE billing_attempts SET paid_starts_at_ms=incoming.starts_at_ms,paid_ends_at_ms=incoming.ends_at_ms FROM (SELECT 'newer-attempt' AS attempt_id,425 AS starts_at_ms,550 AS ends_at_ms) AS incoming WHERE billing_attempts.id=incoming.attempt_id AND billing_attempts.paid_starts_at_ms IS NULL"
          ),
          db
            .prepare(
              "UPDATE subscriptions SET current_paid_attempt_id='newer-attempt' WHERE user_id=?"
            )
            .bind(userId),
        ])
      );
      expect(yield* Effect.tryPromise(() => tier(450))).toBe(1);
    } finally {
      yield* Effect.tryPromise(() => mf.dispose());
    }
  }).pipe(Effect.runPromise));
