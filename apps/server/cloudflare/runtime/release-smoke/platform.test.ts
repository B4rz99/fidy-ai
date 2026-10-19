import { Effect, Result } from "effect";
import { expect, it } from "vitest";
import { platform } from "./internal/platform";

it("classifies only closed D1 quota failures at database stages", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const quota = "Your account has exceeded D1's free tier daily row write limit.";
      for (const [stage, cause, expected] of [
        ["admission", new Error(quota), "d1_quota"],
        [
          "admission",
          new Error(
            quota + " Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."
          ),
          "d1_quota",
        ],
        [
          "admission",
          new Error(
            "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."
          ),
          "d1_quota",
        ],
        [
          "admission",
          new Error(
            "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details."
          ),
          "d1_quota",
        ],
        [
          "claim",
          new Error(
            "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details."
          ),
          "d1_quota",
        ],
        ["probe_read", new Error("D1_ERROR: " + quota), "d1_quota"],
        ["claim", new Error("D1 batch failed", { cause: new Error(quota) }), "d1_quota"],
        ["admission", new Error("D1 unavailable"), "admission"],
        ["admission", new Error(quota + " unexpected detail"), "admission"],
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
