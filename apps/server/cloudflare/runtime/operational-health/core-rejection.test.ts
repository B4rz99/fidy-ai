import { it } from "@effect/vitest";
import { afterAll, expect } from "vitest";
import { type Cause, Effect, Schema } from "effect";
import { applyTestMigration, isolatedTestDatabases } from "../../d1-test-fixture";
import { makeCoreRejectionObserver } from "./runtime";
import { decideOperationalAlerts, observeCoreRejections, sweepCoreRejections } from "./operations";
import { OperationalAlert } from "./contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const database = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() =>
      applyTestMigration({
        db,
        source: new URL("../../migrations/0088_core_rejection_burst.sql", import.meta.url),
      })
    );
    return db;
  });
const burst = (
  observe: ReturnType<typeof makeCoreRejectionObserver>,
  db: D1Database,
  { now, count }: Readonly<{ now: number; count: number }>
): Effect.Effect<void> =>
  Effect.forEach(Array.from({ length: count }), () => observe({ db, now, status: 401 }), {
    discard: true,
  });

it.effect(
  "records only concentrated Core refusal bursts and expires their single metadata row",
  () =>
    Effect.gen(function* () {
      const db = yield* database();
      const observe = makeCoreRejectionObserver();
      const now = 1_800_000;
      yield* burst(observe, db, { now, count: 99 });
      yield* Effect.forEach([200, 400, 404, 422, 429, 500], (status) =>
        observe({ db, now, status })
      );
      expect(yield* observeCoreRejections({ db, now })).toEqual({
        component: "core-rejections",
        operation: "coreRejectionBursts",
        state: "healthy",
      });
      yield* observe({ db, now, status: 403 });
      const signal = yield* observeCoreRejections({ db, now });
      expect(decideOperationalAlerts([signal])).toEqual([
        { kind: "core_rejection_burst", owner: "coreRejectionBursts", severity: "warning" },
      ]);
      expect(Schema.is(OperationalAlert)(decideOperationalAlerts([signal])[0])).toBe(true);
      expect(
        Schema.is(OperationalAlert)({
          kind: "core_rejection_burst",
          owner: "billing",
          severity: "warning",
        })
      ).toBe(false);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM operational_core_rejection_burst").all()
        )
      ).toMatchObject({
        results: [{ id: 1, observed_at_ms: now }],
      });
      // A fresh isolate cannot let an older delayed observation overwrite newer evidence.
      yield* burst(makeCoreRejectionObserver(), db, { now: now - 60_000, count: 100 });
      expect((yield* observeCoreRejections({ db, now: now - 1 })).state).toBe("unavailable");
      expect((yield* observeCoreRejections({ db, now: now + 299_999 })).state).toBe("attention");
      expect((yield* observeCoreRejections({ db, now: now + 300_000 })).state).toBe("healthy");
      yield* sweepCoreRejections({ db, now: now + 86_399_999 });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM operational_core_rejection_burst").all()
        )).results
      ).toHaveLength(1);
      yield* sweepCoreRejections({ db, now: now + 86_400_000 });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM operational_core_rejection_burst").all()
        )).results
      ).toEqual([]);
    })
);

it.effect(
  "bounds attempted D1 writes during bursts, failure, clock rollback and isolate restart",
  () =>
    Effect.gen(function* () {
      const db = yield* database();
      let attempts = 0;
      const failed = new Proxy(db, {
        get(target, key, receiver): unknown {
          if (key !== "prepare") return Reflect.get(target, key, receiver);
          return () => {
            attempts += 1;
            throw new Error("private database diagnostic");
          };
        },
      });
      const observe = makeCoreRejectionObserver();
      yield* burst(observe, failed, { now: 1_800_000, count: 1_000 });
      expect(attempts).toBe(1);
      yield* burst(observe, failed, { now: 1_740_000, count: 100 });
      expect(attempts).toBe(1);
      yield* burst(observe, failed, { now: 1_860_000, count: 100 });
      expect(attempts).toBe(2);
      // Restart explicitly loses the partial local sample; neither observer invents a global total.
      yield* burst(makeCoreRejectionObserver(), db, { now: 1_920_000, count: 99 });
      yield* burst(makeCoreRejectionObserver(), db, { now: 1_920_000, count: 99 });
      expect((yield* observeCoreRejections({ db, now: 1_920_000 })).state).toBe("healthy");
      const unavailable = yield* observeCoreRejections({ db: failed, now: 1_920_000 });
      expect(decideOperationalAlerts([unavailable])).toEqual([
        { kind: "inspection_unavailable", owner: "coreRejectionBursts", severity: "warning" },
      ]);
    })
);

it.live(
  "stops waiting for stalled evidence without admitting another outstanding native write",
  () =>
    Effect.gen(function* () {
      const db = yield* database();
      let attempts = 0;
      const pending = Promise.withResolvers<D1Result>();
      const stalled = new Proxy(db, {
        get(target, key, receiver): unknown {
          if (key !== "prepare") return Reflect.get(target, key, receiver);
          return (sql: string): D1PreparedStatement =>
            new Proxy(db.prepare(sql), {
              get(statement, method, context): unknown {
                if (method !== "bind") return Reflect.get(statement, method, context);
                return (...args: Parameters<D1PreparedStatement["bind"]>): D1PreparedStatement =>
                  new Proxy(statement.bind(...args), {
                    get(bound, operation, boundContext): unknown {
                      return operation === "run"
                        ? () => {
                            attempts += 1;
                            return pending.promise;
                          }
                        : Reflect.get(bound, operation, boundContext);
                    },
                  });
              },
            });
        },
      });
      const observe = makeCoreRejectionObserver();
      yield* burst(observe, stalled, { now: 1_800_000, count: 100 });
      yield* burst(observe, stalled, { now: 1_860_000, count: 100 });
      expect(attempts).toBe(1);
      pending.reject(new Error("late private failure"));
      yield* Effect.yieldNow;
      yield* burst(observe, db, { now: 1_920_000, count: 100 });
      expect((yield* observeCoreRejections({ db, now: 1_920_000 })).state).toBe("attention");
    })
);
