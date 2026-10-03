import { UserId } from "../../src/core/identity/contract";
import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { userTrialPeriodQuery } from "../../src/shell/identity/operations";
import { isolatedTestDatabases } from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("20000000-0000-4000-8000-000000000002");

it("selects only the explicit User's original trial for a caller-owned statement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY, started_at_ms INTEGER, ends_at_ms INTEGER)"
          ),
          db.prepare("INSERT INTO trial_periods VALUES (?, 100, 200)").bind(userA),
          db.prepare("INSERT INTO trial_periods VALUES (?, 300, 400)").bind(userB),
        ])
      );
      const query = userTrialPeriodQuery(userB);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(query.sql)
            .bind(...query.params)
            .first()
        )
      ).toEqual({ startedAtMs: 300, endsAtMs: 400 });
      const missing = userTrialPeriodQuery(UserId.make("30000000-0000-4000-8000-000000000003"));
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(missing.sql)
            .bind(...missing.params)
            .first()
        )
      ).toBeNull();
    })
  ));
