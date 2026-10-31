import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { activeProUserCondition } from "../../src/shell/access-tier/operations";
import { seedRefundCharge } from "./refund-charge.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const foreign = "10000000-0000-4000-8000-000000000002";
const priceId = "22700000-0000-4000-8000-000000000001";
const paidThrough = 9999999999999;
const setup = Effect.fn(function* () {
  const db = yield* Effect.tryPromise(() => databases.acquire());
  yield* Effect.tryPromise(() => installTestSchema({ db }));
  yield* seedRefundCharge(db);
  yield* Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
        )
        .bind(foreign),
      db.prepare("INSERT INTO subscriptions(id,user_id) VALUES(?,?)").bind(foreign, foreign),
    ])
  );
  return db;
});

it("preserves the paid period after cancellation and refuses deletion, regressed verification and a foreign owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO subscription_cancellations(subscription_id,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,verification_count) VALUES(?,'40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',2,?,'detached',3)"
          )
          .bind(userId, paidThrough)
          .run()
      );
      for (const sql of [
        "DELETE FROM subscription_cancellations",
        "UPDATE subscription_cancellations SET verification_count=2",
      ]) {
        yield* Effect.tryPromise(() =>
          expect(db.prepare(sql).run()).rejects.toThrow("subscription_cancellation_immutable")
        );
      }
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "INSERT INTO subscription_cancellations(subscription_id,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,verification_count) SELECT ?,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,'detached',0 FROM subscription_cancellations"
            )
            .bind(foreign)
            .run()
        ).rejects.toThrow("subscription_cancellation_invalid")
      );
      const standing = activeProUserCondition({ userId, nowEpochMs: 3 });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT ${standing.sql} AS active`)
            .bind(...standing.params)
            .first("active")
        )
      ).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT subscription_id,verification_count FROM subscription_cancellations")
            .all()
        )
      ).toMatchObject({ results: [{ subscription_id: userId, verification_count: 3 }] });
    })
  ));

it("refuses reassignment of an existing Price notice without changing its original owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO billing_price_notices(subscription_id,price_id,created_at_ms) VALUES(?,?,1)"
          )
          .bind(userId, priceId)
          .run()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db.prepare("UPDATE billing_price_notices SET subscription_id=?").bind(foreign).run()
        ).rejects.toThrow("billing_price_notice_identity")
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT subscription_id,price_id,created_at_ms FROM billing_price_notices")
            .all()
        )).results
      ).toEqual([{ subscription_id: userId, price_id: priceId, created_at_ms: 1 }]);
    })
  ));

it("refuses clearing a settled paid attempt without losing Pro standing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare("UPDATE subscriptions SET current_paid_attempt_id=NULL WHERE user_id=?")
            .bind(userId)
            .run()
        ).rejects.toThrow("subscription_paid_attempt_immutable")
      );
      const standing = activeProUserCondition({ userId, nowEpochMs: 3 });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT ${standing.sql} AS active`)
            .bind(...standing.params)
            .first("active")
        )
      ).toBe(1);
    })
  ));
