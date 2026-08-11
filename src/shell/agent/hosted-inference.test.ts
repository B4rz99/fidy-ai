import { expect, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";
import type { Prompt } from "effect/unstable/ai";
import {
  type HostedInferenceAdapter,
  HostedInferenceError,
  type HostedTextContext,
  type HostedTextRequest,
  type HostedTextResult,
  HostedToolCallMaximum,
  makeHostedInference,
  makeHostedTextContext,
} from "./hosted-inference";

type TestRequest = Readonly<{
  messages: ReadonlyArray<Prompt.MessageEncoded>;
  tools: ReadonlyArray<string>;
}>;

type TestContinuation = ReadonlyArray<Prompt.MessageEncoded>;

const makeTestInference = Effect.fn("Test.makeTestInference")(function* (capacity: number = 100) {
  const executions = yield* Ref.make<ReadonlyArray<TestRequest>>([]);
  const adapter: HostedInferenceAdapter<TestRequest, TestContinuation> = {
    prepare: ({ continuation, projection }) => {
      const messages = [
        ...projection.prefix,
        ...Option.getOrElse(continuation, () => []),
        ...projection.continuationTail,
        ...projection.suffix,
      ];
      const request = { messages, tools: ["complete-canonical-tool"] } as const;
      const completeTokens = messages.length + request.tools.length + 16;
      return completeTokens > capacity
        ? Effect.fail(
            new HostedInferenceError({
              reason: { _tag: "CapacityExceeded", inputTokens: completeTokens - 16 },
              retryable: false,
              retryAfter: Option.none(),
            })
          )
        : Effect.succeed(request);
    },
    execute: (request) =>
      Ref.update(executions, (captured) => [...captured, request]).pipe(
        Effect.as({
          result: {
            text: "done",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 3, outputTokens: 1, cachedInputTokens: 0 },
          },
          continuation: request.messages,
        } satisfies Readonly<{
          result: Omit<HostedTextResult, "continuation">;
          continuation: TestContinuation;
        }>)
      ),
  };
  return { inference: makeHostedInference(adapter), executions } as const;
});

const context = (text: string): HostedTextContext =>
  makeHostedTextContext({
    prefix: [{ role: "system", content: text }],
    continuationTail: [],
    suffix: [{ role: "system", content: "turn framing" }],
  });

const request = (hostedContext: HostedTextContext): HostedTextRequest => ({
  context: hostedContext,
  continuation: Option.none(),
  toolChoice: "auto",
  maximumToolCalls: HostedToolCallMaximum.make(2),
});

it.effect("executes only the exact complete request stored by preparation", () =>
  Effect.gen(function* () {
    const { executions, inference } = yield* makeTestInference();
    const prepared = yield* inference.prepareText(request(context("hello")));

    const generated = yield* inference.executeText(prepared);

    expect(generated.text).toBe("done");
    expect(yield* Ref.get(executions)).toEqual([
      {
        messages: [
          { role: "system", content: "hello" },
          { role: "system", content: "turn framing" },
        ],
        tools: ["complete-canonical-tool"],
      },
    ]);
  })
);

it.effect("rejects forged, foreign, replayed, and second-projection authorities", () =>
  Effect.gen(function* () {
    const first = yield* makeTestInference();
    const second = yield* makeTestInference();
    const sharedContext = context("one projection");
    const prepared = yield* first.inference.prepareText(request(sharedContext));

    const foreignPrepared = yield* Effect.exit(second.inference.executeText(prepared));
    const secondProjection = yield* Effect.exit(
      second.inference.prepareText(request(sharedContext))
    );
    const forged = yield* Effect.exit(first.inference.executeText(structuredClone(prepared)));
    yield* first.inference.executeText(prepared);
    const replayed = yield* Effect.exit(first.inference.executeText(prepared));

    expect(foreignPrepared._tag).toBe("Failure");
    expect(secondProjection._tag).toBe("Failure");
    expect(forged._tag).toBe("Failure");
    expect(replayed._tag).toBe("Failure");
    expect(yield* Ref.get(second.executions)).toEqual([]);
  })
);

it.effect("continues only through an opaque one-shot adapter continuation", () =>
  Effect.gen(function* () {
    const { executions, inference } = yield* makeTestInference();
    const foreign = yield* makeTestInference();
    const first = yield* inference.prepareText(request(context("first")));
    const generated = yield* inference.executeText(first);
    const foreignPrepared = yield* foreign.inference.prepareText(request(context("foreign")));
    const foreignGenerated = yield* foreign.inference.executeText(foreignPrepared);
    const forgedContinuation = structuredClone(generated.continuation);
    const forged = yield* Effect.exit(
      inference.prepareText({
        context: context("forged continuation"),
        continuation: Option.some(forgedContinuation),
        toolChoice: "none",
      })
    );
    const moved = yield* Effect.exit(
      inference.prepareText({
        context: context("foreign continuation"),
        continuation: Option.some(foreignGenerated.continuation),
        toolChoice: "none",
      })
    );
    const continuedContext = makeHostedTextContext({
      prefix: [{ role: "system", content: "stable prefix" }],
      continuationTail: [{ role: "tool", content: [] }],
      suffix: [{ role: "system", content: "next suffix" }],
    });

    const second = yield* inference.prepareText({
      context: continuedContext,
      continuation: Option.some(generated.continuation),
      toolChoice: "none",
    });
    yield* inference.executeText(second);
    const replay = yield* Effect.exit(
      inference.prepareText({
        context: context("replay"),
        continuation: Option.some(generated.continuation),
        toolChoice: "none",
      })
    );

    expect(forged._tag).toBe("Failure");
    expect(moved._tag).toBe("Failure");
    expect(replay._tag).toBe("Failure");
    expect((yield* Ref.get(executions))[1]?.messages).toEqual([
      { role: "system", content: "stable prefix" },
      { role: "system", content: "first" },
      { role: "system", content: "turn framing" },
      { role: "tool", content: [] },
      { role: "system", content: "next suffix" },
    ]);
  })
);

it.effect("rejects a request that fits before complete tools, framing, and output reserve", () =>
  Effect.gen(function* () {
    const { inference } = yield* makeTestInference(18);

    const exit = yield* Effect.exit(inference.prepareText(request(context("fits alone"))));

    expect(exit._tag).toBe("Failure");
  })
);

it.effect(
  "uses complete preparation for startup validation without creating an executable authority",
  () =>
    Effect.gen(function* () {
      const { executions, inference } = yield* makeTestInference();
      const startupContext = context("startup maximum");

      yield* inference.validateText(request(startupContext));
      const secondProjection = yield* Effect.exit(inference.prepareText(request(startupContext)));

      expect(secondProjection._tag).toBe("Failure");
      expect(yield* Ref.get(executions)).toEqual([]);
    })
);
