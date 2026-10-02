import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { Effect } from "effect";
import { activePaidSubscriptionCondition } from "~/shell/subscription/operations";
import { UserId } from "@fidy/server/identity-reference";
import { activeProUserCondition } from "./access-tier";

const userId = "10000000-0000-4000-8000-000000000001";

it("does not grant Pro before either the original TrialPeriod or the paid period starts", () =>
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
          db.prepare("CREATE TABLE billing_paid_periods (attempt_id TEXT, starts_at_ms INTEGER)"),
          db.prepare("INSERT INTO trial_periods VALUES (?, 200, 300)").bind(userId),
          db
            .prepare("INSERT INTO trial_periods VALUES (?, 100, 600)")
            .bind("20000000-0000-4000-8000-000000000002"),
          db.prepare("INSERT INTO subscriptions VALUES (?, 'attempt', 500)").bind(userId),
          db.prepare("INSERT INTO billing_paid_periods VALUES ('attempt', 400)"),
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
      expect(yield* Effect.tryPromise(() => tier(400))).toBe(1);
      expect(yield* Effect.tryPromise(() => tier(500))).toBe(0);
      const paid = activePaidSubscriptionCondition({
        userId: UserId.make("20000000-0000-4000-8000-000000000002"),
        nowEpochMs: 450,
      });
      const otherUser = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT ${paid.sql} AS active`)
          .bind(...paid.params)
          .first<{ active: number }>()
      );
      expect(otherUser?.active).toBe(0);
    } finally {
      yield* Effect.tryPromise(() => mf.dispose());
    }
  }).pipe(Effect.runPromise));
