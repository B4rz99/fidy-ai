import { Data, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { prepareResourceCounter, resourceCounterQuery } from "./operations";

class NativeFailure extends Data.TaggedError("NativeFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, NativeFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new NativeFailure({ cause }),
  });

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "14320000-0000-4000-8000-000000000001";
const foreignUser = "14320000-0000-4000-8000-000000000002";
const originalWork = "14320000-0000-4000-8000-000000000003";
const nextWork = "14320000-0000-4000-8000-000000000004";
it("retains anchored email windows and refuses replacement replay at capacity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() =>
        db.batch([
          ...[userId, foreignUser].map((id) =>
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
              )
              .bind(id)
          ),
          db
            .prepare(
              "INSERT INTO resource_admission_counters(policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,owner_user_id) VALUES('email.pairing.user.v1',?,'anchored',1000,3601000,5,?)"
            )
            .bind(userId, userId),
          db
            .prepare(
              "INSERT INTO resource_admission_counters(policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id) VALUES('email.replacement.user.v1',?,'anchored',2000,86402000,4,?,?)"
            )
            .bind(userId, originalWork, userId),
        ])
      );
      const subject = { sql: "SELECT ? AS user_id", params: [userId] };
      yield* native(() =>
        expect(
          prepareResourceCounter({
            db,
            kind: "email_pairing_user",
            subject,
            current: 3600999,
          }).run()
        ).rejects.toThrow()
      );
      yield* native(() =>
        prepareResourceCounter({
          db,
          kind: "email_pairing_user",
          subject,
          current: 3601000,
        }).run()
      );
      const query = resourceCounterQuery({ kind: "email_pairing_user", subject });
      expect(
        yield* native(() =>
          db
            .prepare(query.sql)
            .bind(...query.params)
            .first()
        )
      ).toEqual({
        used: 1,
        window_start_ms: 3601000,
        window_ends_ms: 7201000,
        last_work_id: null,
      });
      yield* native(() =>
        prepareResourceCounter({
          db,
          kind: "email_replacement",
          subject,
          current: 2001,
          workId: nextWork,
        }).run()
      );
      const refused = yield* native(() =>
        prepareResourceCounter({
          db,
          kind: "email_replacement",
          subject,
          current: 2002,
          workId: originalWork,
        }).run()
      );
      expect(refused.meta.changes).toBe(0);
      const replacement = resourceCounterQuery({ kind: "email_replacement", subject });
      expect(
        yield* native(() =>
          db
            .prepare(replacement.sql)
            .bind(...replacement.params)
            .first()
        )
      ).toEqual({
        used: 5,
        window_start_ms: 2000,
        window_ends_ms: 86402000,
        last_work_id: nextWork,
      });
      expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
        []
      );
    })
  ));
