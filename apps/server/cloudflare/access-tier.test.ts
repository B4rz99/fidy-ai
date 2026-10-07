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
            "CREATE TABLE trial_periods (user_id TEXT, started_at_ms INTEGER, ends_at_ms INTEGER)"
          ),
          db.prepare(
            "CREATE TABLE subscriptions (user_id TEXT, attempt_id TEXT, paid_period_ends_at_ms INTEGER)"
          ),
          db.prepare(
            "CREATE TABLE billing_attempts (id TEXT, user_id TEXT, payment_source_id TEXT, billing_period TEXT)"
          ),
          db.prepare("CREATE TABLE card_payment_sources (id TEXT, user_id TEXT, method TEXT)"),
          db.prepare("CREATE TABLE subscription_renewal_stops (user_id TEXT)"),
          db.prepare(
            "CREATE VIEW subscription_renewal_fences AS SELECT * FROM subscription_renewal_stops"
          ),
          db.prepare(
            "CREATE TABLE billing_paid_periods (attempt_id TEXT, starts_at_ms INTEGER, ends_at_ms INTEGER)"
          ),
          db.prepare(
            "CREATE TABLE billing_access_adjustments (attempt_id TEXT, ends_at_ms INTEGER)"
          ),
          db.prepare("INSERT INTO trial_periods VALUES (?, 200, 300)").bind(userId),
          db
            .prepare("INSERT INTO trial_periods VALUES (?, 100, 350)")
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
          db.prepare("INSERT INTO subscriptions VALUES (?, 'attempt', 500)").bind(userId),
          db.prepare("INSERT INTO billing_paid_periods VALUES ('attempt', 400, 500)"),
          db
            .prepare("INSERT INTO billing_attempts VALUES ('attempt', ?, 'source', 'weekly')")
            .bind(userId),
          db.prepare("INSERT INTO card_payment_sources VALUES ('source', ?, 'nequi')").bind(userId),
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
        db.prepare("INSERT INTO billing_access_adjustments VALUES ('attempt',450)").run()
      );
      expect(yield* Effect.tryPromise(() => tier(449))).toBe(1);
      expect(yield* Effect.tryPromise(() => tier(450))).toBe(0);
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("INSERT INTO billing_paid_periods VALUES ('newer-attempt',425,550)"),
          db
            .prepare("INSERT INTO billing_attempts VALUES ('newer-attempt', ?, 'source', 'weekly')")
            .bind(userId),
          db
            .prepare(
              "UPDATE subscriptions SET attempt_id='newer-attempt',paid_period_ends_at_ms=550 WHERE user_id=?"
            )
            .bind(userId),
        ])
      );
      expect(yield* Effect.tryPromise(() => tier(450))).toBe(1);
    } finally {
      yield* Effect.tryPromise(() => mf.dispose());
    }
  }).pipe(Effect.runPromise));
