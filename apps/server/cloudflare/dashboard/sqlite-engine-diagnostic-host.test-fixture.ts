import { Effect, Result, Schema } from "effect";
import type { Miniflare } from "miniflare";

const phases = ["count", "plain", "effective", "decode", "fold"] as const;
const attemptsPerPhase = 2;
const encodeDefect = Schema.encodeSync(Schema.Defect());
/** Preserve subsequent observations after the original read failure, including transport failures. */
export const diagnoseEngineFailure = Effect.fn(function* (runtime: Miniflare, body: string) {
  const observations: Array<Schema.Json> = [];
  if (Bun.env.DASHBOARD_ENGINE_DIAGNOSTIC !== "true") return observations;
  for (const phase of phases) {
    for (let attempt = 0; attempt < attemptsPerPhase; attempt++) {
      const started = performance.now();
      const outcome = yield* Effect.result(
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise(() =>
            runtime.dispatchFetch(
              `https://proof.internal/${phase === "fold" ? "read" : `diagnostic/${phase}`}`,
              { method: "POST", body }
            )
          );
          const result = yield* Effect.tryPromise(() => response.text());
          return { status: response.status, body: result };
        })
      );
      observations.push(
        Result.isSuccess(outcome)
          ? {
              phase,
              attempt,
              elapsed: performance.now() - started,
              outcome: "response",
              status: outcome.success.status,
              body: outcome.success.body,
            }
          : {
              phase,
              attempt,
              elapsed: performance.now() - started,
              outcome: "transport_failed",
              cause: encodeDefect(outcome.failure),
            }
      );
    }
  }
  return observations;
});
