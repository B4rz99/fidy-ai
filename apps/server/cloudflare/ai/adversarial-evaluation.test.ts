import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import {
  type WorkersAiRequest,
  approvedWorkersAiModel,
} from "../../src/shell/hosted-inference/contract";
import { makeHostedEvaluationHandler } from "./workers-ai-evaluation-worker";
import {
  type EvaluationBudget,
  type EvaluationEnvironment,
  evaluationLimits,
  makeEvaluationBudget,
} from "./internal/evaluation-budget";

const token = "a".repeat(64);
const environment = (
  run: EvaluationEnvironment["AI"]["run"],
  mode: "live" | "dry-run" = "live"
): EvaluationEnvironment => ({
  AI: { run },
  HOSTED_AI_MODEL: approvedWorkersAiModel,
  EVALUATION_TOKEN: token,
  EVALUATION_COMMIT: "b".repeat(40),
  EVALUATION_MODE: mode,
});
const request: WorkersAiRequest = {
  messages: [{ role: "user", content: "synthetic" }],
  max_tokens: 16_000,
  temperature: 0,
  stream: false,
  chat_template_kwargs: { enable_thinking: false },
};
const accepted = (): Response =>
  Response.json({
    choices: [
      { message: { role: "assistant", content: "synthetic response" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
const localRequest = (index: number, overrides: RequestInit = {}): Request =>
  new Request(`http://127.0.0.1:8798/evaluate/${index}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    ...overrides,
  });

it.effect(
  "reserves concurrent calls before hashing and refuses the first call beyond the hard run budget",
  () =>
    Effect.gen(function* () {
      const runExit = Effect.runPromiseExitWith(yield* Effect.context<never>());
      let actual = 0;
      const late: Array<Promise<Exit.Exit<unknown, unknown>>> = [];
      const budget: EvaluationBudget = makeEvaluationBudget(
        environment(() => {
          actual++;
          if (actual === 1) {
            late.push(runExit(budget.run(approvedWorkersAiModel, request)));
          }
          return Promise.resolve(accepted());
        })
      );
      const results = yield* Effect.forEach(
        Array.from({ length: evaluationLimits.providerCalls + 1 }),
        () => Effect.exit(budget.run(approvedWorkersAiModel, request)),
        { concurrency: "unbounded" }
      );
      const lateResults = yield* Effect.tryPromise(() => Promise.all(late));
      expect(lateResults).toHaveLength(1);
      expect(lateResults.every(Exit.isFailure)).toBe(true);
      expect(results.filter(Exit.isSuccess)).toHaveLength(evaluationLimits.providerCalls);
      expect(actual).toBe(evaluationLimits.providerCalls);
      expect(budget.snapshot().reservedCalls).toBe(evaluationLimits.providerCalls);
      expect(budget.snapshot().reservedOutputTokens).toBe(evaluationLimits.totalOutputTokens);
    })
);

it.effect(
  "refuses excess request bytes and changed output reserve before any provider egress",
  () =>
    Effect.gen(function* () {
      let actual = 0;
      const budget = makeEvaluationBudget(
        environment(() => {
          actual++;
          return Promise.resolve(accepted());
        })
      );
      const oversized: WorkersAiRequest = {
        ...request,
        messages: [{ role: "user", content: "x".repeat(evaluationLimits.requestBytes) }],
      };
      expect(
        Exit.isFailure(yield* Effect.exit(budget.run(approvedWorkersAiModel, oversized)))
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(budget.run(approvedWorkersAiModel, { ...request, max_tokens: 16_001 }))
        )
      ).toBe(true);
      expect(actual).toBe(0);
      expect(budget.snapshot().reservedCalls).toBe(0);
    })
);

it.effect("refuses another dispatch at the original elapsed budget without renewing it", () =>
  Effect.gen(function* () {
    let actual = 0;
    const budget = makeEvaluationBudget(
      environment(() => {
        actual++;
        return Promise.resolve(accepted());
      })
    );
    yield* budget.run(approvedWorkersAiModel, request);
    yield* TestClock.adjust(evaluationLimits.elapsedMillis);
    expect(Exit.isFailure(yield* Effect.exit(budget.run(approvedWorkersAiModel, request)))).toBe(
      true
    );
    expect(actual).toBe(1);
  })
);

it.live("stops after an ambiguous provider failure without exposing its payload or retrying", () =>
  Effect.gen(function* () {
    let actual = 0;
    const handler = makeHostedEvaluationHandler();
    const env = environment(() => {
      actual++;
      return Promise.reject(new Error("synthetic-private-provider-failure"));
    });
    const first = yield* Effect.tryPromise(() => handler.fetch(localRequest(0), env));
    expect(first.status).toBe(503);
    const text = yield* Effect.tryPromise(() => first.text());
    expect(text).not.toContain("synthetic-private-provider-failure");
    expect((yield* Effect.tryPromise(() => handler.fetch(localRequest(1), env))).status).toBe(409);
    expect((yield* Effect.tryPromise(() => handler.fetch(localRequest(0), env))).status).toBe(409);
    expect(actual).toBe(1);
  })
);

it.live(
  "rejects drive-by requests, missing configuration and arbitrary case inputs before inference",
  () =>
    Effect.gen(function* () {
      let actual = 0;
      const handler = makeHostedEvaluationHandler();
      const env = environment(() => {
        actual++;
        return Promise.resolve(accepted());
      });
      const requests = [
        localRequest(0, { headers: {} }),
        localRequest(0, {
          headers: { authorization: `Bearer ${token}`, origin: "https://attacker.invalid" },
        }),
        localRequest(0, { body: "arbitrary prompt" }),
        localRequest(1),
      ];
      for (const input of requests) {
        expect((yield* Effect.tryPromise(() => handler.fetch(input, env))).status).not.toBe(200);
      }
      expect(
        (yield* Effect.tryPromise(() =>
          handler.fetch(localRequest(0), { ...env, EVALUATION_TOKEN: "" })
        )).status
      ).toBe(503);
      expect(actual).toBe(0);
    })
);

it.live(
  "dry-runs every real projected corpus request with no provider calls and never claims a semantic pass",
  () =>
    Effect.gen(function* () {
      let actual = 0;
      const handler = makeHostedEvaluationHandler();
      const env = environment(() => {
        actual++;
        return Promise.resolve(accepted());
      }, "dry-run");
      for (let index = 0; index < evaluationLimits.providerCalls; index++) {
        const result = yield* Effect.tryPromise(() => handler.fetch(localRequest(index), env));
        expect(result.status).toBe(200);
        const text = yield* Effect.tryPromise(() => result.text());
        expect(text).toContain('"semanticGrade":"manual_review_required"');
        expect(text).toContain('"containment":"not_exercised_no_tool_executor"');
        expect(text).toContain('"mode":"dry-run"');
      }
      expect(actual).toBe(0);
      expect(
        (yield* Effect.tryPromise(() =>
          handler.fetch(localRequest(evaluationLimits.providerCalls), env)
        )).status
      ).toBe(409);
    })
);
