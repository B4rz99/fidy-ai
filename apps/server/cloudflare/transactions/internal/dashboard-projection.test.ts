import { Effect, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  installTestSchema,
  isolatedTestDatabases,
  observeRetentionCost,
} from "../../d1-test-fixture";
import { projectionQueries, projectionRange } from "./dashboard-projection";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const categoryId = "10000000-0000-4000-8000-000000000016";

it(
  "reads only full days and minute fringes for a dense monthly aggregate",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* Effect.tryPromise(() => installTestSchema({ db }));
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
              )
              .bind(userId),
            db
              .prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<49999)
        INSERT INTO transaction_projection_bucket SELECT ?,60,x,'COP','outflow',?,1,'10000' FROM n`)
              .bind(userId, categoryId),
            db
              .prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<34)
        INSERT INTO transaction_projection_bucket SELECT ?,86400,x,'COP','outflow',?,1440,'10000' FROM n`)
              .bind(userId, categoryId),
            db
              .prepare(
                `INSERT INTO transaction_projection_digit SELECT user_id,size_seconds,bucket,currency,direction,category_id,4,count FROM transaction_projection_bucket WHERE user_id=?`
              )
              .bind(userId),
          ])
        );
        const range = Option.getOrThrow(
          projectionRange({ from: 18000000, toExclusive: 2610000000 })
        );
        const observed = observeRetentionCost(db);
        const rows = yield* Effect.tryPromise(() =>
          observed.database.batch(projectionQueries({ db: observed.database, userId, range }))
        );
        expect(rows[0]?.results).toEqual([
          {
            currency: "COP",
            direction: "outflow",
            category_id: categoryId,
            count: 43200,
            max_minor: "10000",
          },
        ]);
        expect(rows[1]?.results).toEqual([
          {
            currency: "COP",
            direction: "outflow",
            category_id: categoryId,
            position: 4,
            digit_sum: 43200,
          },
        ]);
        expect(observed.cost().rowsRead).toBeLessThan(12000);
      })
    ),
  30000
);
