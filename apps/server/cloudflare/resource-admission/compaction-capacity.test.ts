import { Data, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { prepareResourceCounter, sweepCompactionCounters } from "./operations";

class NativeFailure extends Data.TaggedError("NativeFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, NativeFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new NativeFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = "14350000-0000-4000-8000-000000000011";
const foreign = "14350000-0000-4000-8000-000000000012";
it("renews compaction capacity at exact UTC day boundaries", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','UTC',1)"
            )
            .bind(owner),
          db
            .prepare(
              "INSERT INTO resource_admission_counters(policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,owner_user_id) VALUES('hosted.compaction.user.v1',?,'calendar',0,86400000,3,?),('hosted.compaction.user.v1',?,'calendar',86400000,172800000,2,?)"
            )
            .bind(owner, owner, owner, owner),
        ])
      );
      const admit = (current: number): Promise<D1Result> =>
        prepareResourceCounter({
          db,
          kind: "hosted_compaction",
          current,
          subject: { sql: "SELECT ? AS user_id", params: [owner] },
        }).run();
      expect((yield* native(() => admit(86399999))).meta.changes).toBe(0);
      expect((yield* native(() => admit(86400000))).meta.changes).toBe(1);
      expect((yield* native(() => admit(86400001))).meta.changes).toBe(0);
      expect((yield* native(() => admit(172800000))).meta.changes).toBe(1);
    })
  ));
it("bounds compaction cleanup at the original retention boundary without deleting another scope", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() =>
        db.batch([
          ...[owner, foreign].map((id) =>
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','UTC',1)"
              )
              .bind(id)
          ),
          ...[
            { userId: owner, day: 0 },
            { userId: owner, day: 86400000 },
            { userId: foreign, day: 0 },
          ].map(({ userId, day }) =>
            prepareResourceCounter({
              db,
              kind: "hosted_compaction",
              current: day,
              subject: { sql: "SELECT ? AS user_id", params: [userId] },
            })
          ),
          prepareResourceCounter({
            db,
            kind: "email_pairing_global",
            current: 1,
            subject: { sql: "SELECT 1", params: [] },
          }),
        ])
      );
      const costs: Array<unknown> = [];
      for (const cutoff of [0, 1]) {
        const sweep = sweepCompactionCounters({ userId: owner, cutoff, limit: 1 });
        const shared = yield* native(() =>
          db
            .prepare(sweep.sql)
            .bind(...sweep.params)
            .run()
        );
        costs.push({
          cutoff,
          shared: { read: shared.meta.rows_read, written: shared.meta.rows_written },
        });
        expect(shared.meta.changes).toBe(cutoff === 0 ? 0 : 1);
      }
      expect(costs).toEqual([
        { cutoff: 0, shared: { read: 2, written: 0 } },
        { cutoff: 1, shared: { read: 5, written: 1 } },
      ]);
      expect(
        (yield* native(() =>
          db
            .prepare(
              "SELECT policy_key,scope_key,window_start_ms FROM resource_admission_counters ORDER BY policy_key,scope_key,window_start_ms"
            )
            .all()
        )).results
      ).toEqual([
        { policy_key: "email.pairing.global.v1", scope_key: "global", window_start_ms: 1 },
        { policy_key: "hosted.compaction.user.v1", scope_key: owner, window_start_ms: 86400000 },
        { policy_key: "hosted.compaction.user.v1", scope_key: foreign, window_start_ms: 0 },
      ]);
    })
  ));
