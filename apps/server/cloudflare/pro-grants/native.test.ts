import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { installTestSchema } from "../d1-test-fixture";
import { retireErasureSource } from "../erasure/operations";
import { nativeProOperator } from "./native.test-fixture";

const io = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const request = (action: "grant" | "revoke", userId: string): unknown => ({
  command: { action, selector: { userId } },
  operator: "operator@example.com",
});
const list = { command: { action: "list" }, operator: "operator@example.com" };
const unavailable = { kind: "refused", reason: "unavailable", candidates: [] };
const install = (db: D1Database): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* io(() => installTestSchema({ db }));
    for (const id of [userA, userB]) {
      yield* io(() =>
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
          )
          .bind(id)
          .run()
      );
    }
  });
it.live(
  "private Pro commands use only Core's selected D1 or Store and refuse mixed, retired and closed targets",
  () =>
    Effect.gen(function* () {
      const native = yield* nativeProOperator;
      yield* install(native.db);
      yield* install(native.store);
      yield* io(() => native.bucket.put("recovery/generation", "initial"));
      expect(yield* io(() => native.execute("d1", request("grant", userA)))).toEqual({
        kind: "success",
        entries: [{ userId: userA, action: "grant" }],
      });
      expect(yield* io(() => native.execute("store", list))).toEqual({
        kind: "success",
        entries: [],
      });
      expect(yield* io(() => native.execute("store", request("grant", userB)))).toEqual({
        kind: "success",
        entries: [{ userId: userB, action: "grant" }],
      });
      expect(yield* io(() => native.execute("d1", list))).toEqual({
        kind: "success",
        entries: [{ userId: userA, action: "grant" }],
      });
      for (const mode of ["both", "missing", "isolated", "stale", "no-recovery"] as const) {
        expect(yield* io(() => native.execute(mode, request("grant", userA)))).toEqual(unavailable);
      }
      expect(
        yield* io(() => native.execute("store", { ...list, sql: "DELETE FROM users" }))
      ).toEqual({ kind: "refused", reason: "invalid-input", candidates: [] });
      expect(yield* io(native.gate)).toMatchObject({ closed: false, leases: 0 });
      yield* retireErasureSource({
        db: native.db,
        fence: { from: "initial", retired: "18460000-0000-4000-8000-000000000007" },
      });
      expect(yield* io(() => native.execute("d1", list))).toEqual(unavailable);
      expect(yield* io(() => native.execute("d1", request("revoke", userA)))).toEqual(unavailable);
      expect(yield* io(() => native.execute("store", list))).toEqual({
        kind: "success",
        entries: [{ userId: userB, action: "grant" }],
      });
      yield* io(native.closeStore);
      expect(yield* io(() => native.execute("store", list))).toEqual(unavailable);
      yield* io(native.close);
      expect(yield* io(() => native.execute("store", list))).toEqual(unavailable);
      // Deliberately induced native D1 errors retain unknown leases; refusal is not proof of drain.
      expect(yield* io(native.gate)).toMatchObject({ closed: true, leases: 2 });
    }).pipe(Effect.scoped)
);
it.live(
  "new private operator grants respect the User erasure admission fence without withholding another User",
  () =>
    Effect.gen(function* () {
      const native = yield* nativeProOperator;
      yield* install(native.db);
      yield* io(() => native.bucket.put("recovery/generation", "initial"));
      expect(yield* io(() => native.execute("d1", request("grant", userA)))).toMatchObject({
        kind: "success",
      });
      yield* io(() =>
        native.db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('18460000-0000-4000-8000-000000000008',?,0,'Draining')"
          )
          .bind(userA)
          .run()
      );
      expect(yield* io(() => native.execute("d1", request("grant", userA)))).toEqual(unavailable);
      expect(yield* io(() => native.execute("d1", request("grant", userB)))).toEqual({
        kind: "success",
        entries: [{ userId: userB, action: "grant" }],
      });
      expect(yield* io(() => native.execute("d1", list))).toEqual({
        kind: "success",
        entries: [{ userId: userB, action: "grant" }],
      });
    }).pipe(Effect.scoped)
);
