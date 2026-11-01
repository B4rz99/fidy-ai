import { Effect, Result } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  installTestSchema,
  isolatedTestDatabases,
  observeRetentionCost,
} from "../../d1-test-fixture";
import { verifySmokeDatabase } from "./internal/database";
import { platform } from "./internal/platform";

it("classifies only closed D1 quota failures at database stages", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const quota = "Your account has exceeded D1's free tier daily row write limit.";
      for (const [stage, cause, expected] of [
        ["schema", new Error(quota), "d1_quota"],
        [
          "schema",
          new Error(
            quota + " Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."
          ),
          "d1_quota",
        ],
        [
          "schema",
          new Error(
            "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."
          ),
          "d1_quota",
        ],
        [
          "schema",
          new Error(
            "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details."
          ),
          "d1_quota",
        ],
        [
          "schema",
          new Error(
            "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details."
          ),
          "d1_quota",
        ],
        ["probe_read", new Error("D1_ERROR: " + quota), "probe_read"],
        ["schema", new Error("D1 batch failed", { cause: new Error(quota) }), "d1_quota"],
        ["schema", new Error("D1 unavailable"), "schema"],
        ["schema", new Error(quota + " unexpected detail"), "schema"],
        ["storage", new Error(quota), "storage"],
      ] as const) {
        const result = yield* platform({ stage, tryWork: () => Promise.reject(cause) }).pipe(
          Effect.result
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.stage).toBe(expected);
      }
    })
  ));

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

it("proves native rollback with a bounded absence check and refuses a preexisting scratch table", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const observed = observeRetentionCost(db);
      yield* verifySmokeDatabase(observed.database);
      // Failed-batch metadata is unavailable: this bounds the successful absence query only.
      expect(observed.cost().rowsRead).toBeLessThanOrEqual(4);
      expect(observed.cost().rowsWritten).toBe(0);
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("CREATE TABLE fidy_release_verification(value INTEGER NOT NULL) STRICT"),
          db.prepare("INSERT INTO fidy_release_verification VALUES(7)"),
        ])
      );
      const collision = yield* verifySmokeDatabase(db).pipe(Effect.result);
      expect(Result.isFailure(collision)).toBe(true);
      if (Result.isFailure(collision)) expect(collision.failure.stage).toBe("schema");
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT value FROM fidy_release_verification").first("value")
        )
      ).toBe(7);
    })
  ));
