import { Data, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installRetentionTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { measureErasureRecovery } from "./runtime";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
class ObservedNativeRefusal extends Data.TaggedError("ObservedNativeRefusal")<{ cause: unknown }> {}

it("measures the native recovery unit including private assertion SQL and keeps requests isolated", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
      const observed = new Proxy(db, {
        get: (target, property): unknown =>
          property === "batch"
            ? (statements: D1PreparedStatement[]) =>
                target.batch(statements).then((rows) =>
                  rows.map((row, index) => ({
                    ...row,
                    meta: { ...row.meta, timings: { sql_duration_ms: index === 0 ? 0.125 : 0.25 } },
                  }))
                )
            : Reflect.get(target, property, target),
      });
      const input = { DB: observed, ERASURE_REQUIRED: "true", ERASURE_BUCKET: bucket };
      const measured = measureErasureRecovery(input);
      const original = new Response("unchanged", {
        status: 202,
        headers: { "server-timing": "owner;dur=1", "cache-control": "no-store" },
      });
      expect(measured.respond(original)).toBe(original);
      const rows = yield* Effect.tryPromise(() =>
        measured.environment.DB.batch([measured.environment.DB.prepare("SELECT 7 AS value")])
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.results).toEqual([{ value: 7 }]);
      const response = measured.respond(original);
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("server-timing")).toMatch(
        /^owner;dur=1, recovery-r2;dur=[0-9.]+, recovery-d1;dur=[0-9.]+, recovery-sql;dur=0.375$/u
      );
      expect(response.headers.get("fidy-recovery-batches")).toBe("1");
      expect(yield* Effect.tryPromise(() => response.text())).toBe("unchanged");
      yield* Effect.tryPromise(() => measured.environment.DB.prepare("SELECT 8 AS value").first());
      expect(measured.respond(new Response()).headers.get("fidy-recovery-batches")).toBe("2");
      expect(measured.respond(new Response()).headers.get("server-timing")).toContain(
        "recovery-sql;dur=0.750"
      );
      const next = measureErasureRecovery(input);
      yield* Effect.tryPromise(() => next.environment.DB.prepare("SELECT 9 AS value").first());
      expect(next.respond(new Response()).headers.get("fidy-recovery-batches")).toBe("1");
      expect(next.respond(new Response()).headers.get("server-timing")).toContain(
        "recovery-sql;dur=0.375"
      );
    })
  ));

it.each([false, true])(
  "preserves a native D1 refusal without reporting missing SQL as zero (synchronous=%s)",
  (synchronous) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
        yield* Effect.tryPromise(() => installRetentionTestSchema(db));
        yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
        const refusal = new Error("synthetic native refusal");
        const observed = new Proxy(db, {
          get: (target, property): unknown =>
            property === "batch"
              ? () => {
                  if (synchronous) throw refusal;
                  return Promise.reject(refusal);
                }
              : Reflect.get(target, property, target),
        });
        const measured = measureErasureRecovery({
          DB: observed,
          ERASURE_REQUIRED: "true",
          ERASURE_BUCKET: bucket,
        });
        const failure = yield* Effect.flip(
          Effect.tryPromise({
            try: () => measured.environment.DB.prepare("SELECT 1").all(),
            catch: (cause) => new ObservedNativeRefusal({ cause }),
          })
        );
        expect(failure.cause).toBe(refusal);
        const response = measured.respond(new Response(null, { status: 503 }));
        expect(response.status).toBe(503);
        expect(response.headers.get("server-timing")).toMatch(/recovery-d1;dur=[0-9.]+/u);
        expect(response.headers.get("server-timing")).not.toContain("recovery-sql");
      })
    )
);

it("retains a fresh R2 fence after an earlier successful measured read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
      const measured = measureErasureRecovery({
        DB: db,
        ERASURE_REQUIRED: "true",
        ERASURE_BUCKET: bucket,
      });
      yield* Effect.tryPromise(() => measured.environment.DB.prepare("SELECT 1").all());
      expect(measured.respond(new Response()).headers.get("server-timing")).not.toContain(
        "recovery-sql"
      );
      yield* Effect.tryPromise(() =>
        bucket.put("recovery/generation", "12740000-0000-4000-8000-000000000088")
      );
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() =>
            measured.environment.DB.withSession("first-primary").prepare("SELECT 1").all()
          )
        ))._tag
      ).toBe("Failure");
      expect(measured.respond(new Response()).headers.get("fidy-recovery-batches")).toBe("2");
    })
  ));
