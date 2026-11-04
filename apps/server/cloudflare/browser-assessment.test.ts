import { afterAll, expect, it } from "vitest";
import { DateTime, Effect, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "./d1-test-fixture";
import { seedAssessment } from "./browser-assessment.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const users = Array.from(
  { length: 8 },
  (_, index) => `98000000-0000-4000-8000-${String(index).padStart(12, "0")}`
);
const Counts = Schema.Array(Schema.Struct({ userId: Schema.String, count: Schema.Finite }));
it("prepares separate complete financial histories for every offered User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      for (const user of users) {
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(user)
            .run()
        );
      }
      yield* seedAssessment({
        db,
        dataset: "small",
        now: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-04T12:00:00Z")),
        users,
        history: "routine",
        layout: "default",
      });
      const facts = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT user_id AS userId, COUNT(*) AS count FROM transactions GROUP BY user_id ORDER BY user_id"
          )
          .all()
      );
      const actual = yield* Schema.decodeUnknownEffect(Counts)(facts.results);
      expect(actual).toEqual(users.map((userId) => ({ userId, count: 500 })));
    })
  ));
