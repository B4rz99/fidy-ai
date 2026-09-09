import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { EvaluationRequestBudget, requestBudgetLayer } from "./request-budget";

it.effect("rejects an OpenAI request before network I/O once its finite budget is exhausted", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(requestBudgetLayer(0));
    yield* Effect.gen(function* () {
      const fetch = yield* FetchHttpClient.Fetch;
      const attempted = yield* Effect.result(
        Effect.tryPromise(() => fetch("https://api.openai.com/v1/responses"))
      );
      const budget = yield* EvaluationRequestBudget;
      expect(Result.isFailure(attempted)).toBe(true);
      expect(yield* budget.count).toBe(1);
      expect(yield* budget.rejected).toBe(1);
      expect(yield* budget.exhausted).toBe(true);
    }).pipe(Effect.provide(context));
  })
);
