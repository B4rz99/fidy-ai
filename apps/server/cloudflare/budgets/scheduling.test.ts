import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { UserId } from "../../src/core/identity/contract";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { discoverBudgetCrossingUsers, noteBudgetCrossingEvaluation } from "./operations";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const user = (ordinal: number): UserId =>
  UserId.make(`14690000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`);
const scopeSql = (ordinal: number): string => {
  if (ordinal % 3 === 0) {
    return "INSERT INTO budget_evaluation_work(user_id,occurred_at_ms) VALUES(?,1767225600001)";
  }
  if (ordinal % 3 === 1) {
    return "INSERT INTO budget_publications(user_id,delivery_group_id,detected_at_ms) VALUES(?,'original',1)";
  }
  return "INSERT INTO budget_user_state(user_id,first_budget_id,first_created_at_ms) VALUES(?,'original-first',1)";
};
it("rotates unavailable Users across Budget scopes and rediscovers newly pending work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      yield* Effect.tryPromise(() =>
        db.batch(
          Array.from({ length: 33 }, (_, ordinal) => [
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
              )
              .bind(user(ordinal)),
            db.prepare(scopeSql(ordinal)).bind(user(ordinal)),
          ]).flat()
        )
      );
      const seen = new Set<UserId>();
      for (let tick = 1; tick <= 3; tick++) {
        const selected = yield* discoverBudgetCrossingUsers({ db });
        expect(selected).toHaveLength(16);
        for (const userId of selected) {
          seen.add(userId);
          yield* noteBudgetCrossingEvaluation({ db, userId, now: tick * 1000 });
        }
      }
      expect(seen.size).toBe(33);
      const changed = user(0);
      yield* noteBudgetCrossingEvaluation({ db, userId: changed, now: 10000 });
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE budget_evaluation_work SET version=version+1 WHERE user_id=?")
          .bind(changed)
          .run()
      );
      expect((yield* discoverBudgetCrossingUsers({ db }))[0]).toBe(changed);
      yield* noteBudgetCrossingEvaluation({ db, userId: changed, now: 11000 });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO budget_publications(user_id,delivery_group_id,detected_at_ms) VALUES(?,'new-during-evaluation',11001)"
          )
          .bind(changed)
          .run()
      );
      expect((yield* discoverBudgetCrossingUsers({ db }))[0]).toBe(changed);
    })
  ));
