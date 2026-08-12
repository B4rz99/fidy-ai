import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option, Ref, Schema } from "effect";
import type { Prompt } from "effect/unstable/ai";
import {
  type HostedInferenceAdapter,
  HostedInferenceError,
  type HostedStructuredAdapter,
  HostedStructuredObjectName,
  type HostedTextContext,
  type HostedTextRequest,
  type HostedTextResult,
  HostedToolCallMaximum,
  type PreparedHostedStructured,
  makeHostedInference,
  makeHostedStructuredContext,
  makeHostedTextContext,
} from "./hosted-inference";

type TestRequest = Readonly<{
  messages: ReadonlyArray<Prompt.MessageEncoded>;
  tools: ReadonlyArray<string>;
}>;

type TestContinuation = ReadonlyArray<Prompt.MessageEncoded>;

const unavailableStructuredAdapter: HostedStructuredAdapter = {
  prepare: () =>
    Effect.fail(
      new HostedInferenceError({
        reason: { _tag: "ProviderUnavailable" },
        retryable: false,
        retryAfter: Option.none(),
      })
    ),
};

const makeTestInference = Effect.fn("Test.makeTestInference")(function* (capacity: number = 100) {
  const executions = yield* Ref.make<ReadonlyArray<TestRequest>>([]);
  const adapter: HostedInferenceAdapter<TestRequest, TestContinuation> = {
    countMemoryText: (text) => Effect.succeed(text.length),
    structured: unavailableStructuredAdapter,
    prepare: ({ basePrefix, continuation, projection }) => {
      const messages = [
        ...basePrefix,
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
  return {
    inference: makeHostedInference(adapter),
    inferenceAdapter: adapter,
    executions,
  } as const;
});

const ForgedPreparedStructured = Schema.declare(
  (input): input is PreparedHostedStructured<unknown> => typeof input === "object" && input !== null
);
const ForgedHostedTextContext = Schema.declare(
  (input): input is HostedTextContext => typeof input === "object" && input !== null
);

const context = (text: string): HostedTextContext =>
  makeHostedTextContext({
    prefix: [{ role: "system", content: text }],
    continuationTail: [],
    suffix: [{ role: "system", content: "turn framing" }],
  });

const request = (hostedContext: HostedTextContext): HostedTextRequest => ({
  _tag: "Initial",
  context: hostedContext,
  toolChoice: "auto",
  maximumToolCalls: HostedToolCallMaximum.make(2),
});

it.effect(
  "rejects wrong-kind, forged, cloned, foreign, discarded, and replayed structured authorities",
  () =>
    Effect.gen(function* () {
      const executions = yield* Ref.make(0);
      const structuredAdapter: HostedStructuredAdapter = {
        prepare: ({ outputSchema }) =>
          Effect.succeed({
            execute: Ref.updateAndGet(executions, (count) => count + 1).pipe(
              Effect.flatMap(() =>
                Schema.decodeUnknownEffect(outputSchema)({ compactedConversation: "trusted" }).pipe(
                  Effect.orDie
                )
              )
            ),
          }),
      };
      const first = yield* makeTestInference();
      const second = yield* makeTestInference();
      const firstInference = makeHostedInference({
        ...first.inferenceAdapter,
        structured: structuredAdapter,
      });
      const secondInference = makeHostedInference({
        ...second.inferenceAdapter,
        structured: structuredAdapter,
      });
      const outputSchema = Schema.Struct({ compactedConversation: Schema.String });
      const prepared = yield* firstInference.prepareStructured({
        context: makeHostedStructuredContext({
          messages: [{ role: "user", content: "compact this" }],
        }),
        objectName: HostedStructuredObjectName.make("compacted_conversation"),
        outputSchema,
      });
      expect(
        Reflect.ownKeys(prepared).every(
          (key) => Object.getOwnPropertyDescriptor(prepared, key)?.enumerable === false
        )
      ).toBe(true);

      const discarded = yield* firstInference.prepareStructured({
        context: makeHostedStructuredContext({
          messages: [{ role: "user", content: "discard this" }],
        }),
        objectName: HostedStructuredObjectName.make("compacted_conversation"),
        outputSchema,
      });
      yield* firstInference.discardStructured(discarded);
      const text = yield* firstInference.prepareText(request(context("text")));
      const crossKind = yield* Schema.decodeUnknownEffect(ForgedPreparedStructured)(text);
      const forged = yield* Schema.decodeUnknownEffect(ForgedPreparedStructured)(Object.freeze({}));

      const exits = yield* Effect.all(
        [
          firstInference.executeStructured(crossKind),
          firstInference.executeStructured(structuredClone(prepared)),
          firstInference.executeStructured(forged),
          secondInference.executeStructured(prepared),
          firstInference.executeStructured(discarded),
        ].map(Effect.exit)
      );
      expect(exits.every(Exit.isFailure)).toBe(true);
      expect(yield* Ref.get(executions)).toBe(0);

      expect(yield* firstInference.executeStructured(prepared)).toEqual({
        compactedConversation: "trusted",
      });
      expect(Exit.isFailure(yield* Effect.exit(firstInference.executeStructured(prepared)))).toBe(
        true
      );
      expect(yield* Ref.get(executions)).toBe(1);
    })
);

it.effect("returns transformed structured domain output without decoding it as wire data", () =>
  Effect.gen(function* () {
    const state = yield* makeTestInference();
    const inference = makeHostedInference({
      ...state.inferenceAdapter,
      structured: {
        prepare: ({ outputSchema }) =>
          Effect.succeed({
            execute: Schema.decodeUnknownEffect(outputSchema)({
              generatedAt: "2026-08-12T00:00:00.000Z",
            }).pipe(Effect.orDie),
          }),
      },
    });
    const prepared = yield* inference.prepareStructured({
      context: makeHostedStructuredContext({ messages: [] }),
      objectName: HostedStructuredObjectName.make("transformed_output"),
      outputSchema: Schema.Struct({ generatedAt: Schema.DateFromString }),
    });

    const output = yield* inference.executeStructured(prepared);

    expect(output.generatedAt.toISOString()).toBe("2026-08-12T00:00:00.000Z");
  })
);

it.effect("rejects a structured authority while its execution is in progress", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const state = yield* makeTestInference();
    const inference = makeHostedInference({
      ...state.inferenceAdapter,
      structured: {
        prepare: () =>
          Effect.succeed({
            execute: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
      },
    });
    const prepared = yield* inference.prepareStructured({
      context: makeHostedStructuredContext({ messages: [] }),
      objectName: HostedStructuredObjectName.make("in_progress"),
      outputSchema: Schema.Struct({ value: Schema.String }),
    });
    const fiber = yield* inference
      .executeStructured(prepared)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);

    expect(Exit.isFailure(yield* Effect.exit(inference.executeStructured(prepared)))).toBe(true);
    yield* Fiber.interrupt(fiber);
    expect(Exit.isFailure(yield* Effect.exit(inference.executeStructured(prepared)))).toBe(true);
  })
);

it.effect("preserves structured authority only after retryable provider failure", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const state = yield* makeTestInference();
    const inference = makeHostedInference({
      ...state.inferenceAdapter,
      structured: {
        prepare: ({ outputSchema }) =>
          Effect.succeed({
            execute: Ref.updateAndGet(attempts, (attempt) => attempt + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(
                      new HostedInferenceError({
                        reason: { _tag: "ProviderUnavailable" },
                        retryable: true,
                        retryAfter: Option.none(),
                      })
                    )
                  : Schema.decodeUnknownEffect(outputSchema)({ value: "retried" }).pipe(
                      Effect.orDie
                    )
              )
            ),
          }),
      },
    });
    const prepared = yield* inference.prepareStructured({
      context: makeHostedStructuredContext({ messages: [] }),
      objectName: HostedStructuredObjectName.make("retry_exact"),
      outputSchema: Schema.Struct({ value: Schema.String }),
    });

    expect(Exit.isFailure(yield* Effect.exit(inference.executeStructured(prepared)))).toBe(true);
    expect(yield* inference.executeStructured(prepared)).toEqual({ value: "retried" });
    expect(Exit.isFailure(yield* Effect.exit(inference.executeStructured(prepared)))).toBe(true);
  })
);

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

it.effect("rejects a continued request with a forged semantic context", () =>
  Effect.gen(function* () {
    const { inference } = yield* makeTestInference();
    const first = yield* inference.prepareText(request(context("first")));
    const generated = yield* inference.executeText(first);
    const forgedContext = yield* Schema.decodeUnknownEffect(ForgedHostedTextContext)({});

    const exit = yield* Effect.exit(
      inference.prepareText({
        _tag: "Continued",
        context: forgedContext,
        continuation: generated.continuation,
        toolChoice: "none",
      })
    );

    expect(exit._tag).toBe("Failure");
  })
);

it.effect("discards an unexecuted continued request and releases its continuation", () =>
  Effect.gen(function* () {
    const { inference } = yield* makeTestInference();
    const first = yield* inference.prepareText(request(context("first")));
    const generated = yield* inference.executeText(first);
    const continued = yield* inference.prepareText({
      _tag: "Continued",
      context: context("continued"),
      continuation: generated.continuation,
      toolChoice: "none",
    });

    yield* inference.discardText(continued);

    const replacement = yield* inference.prepareText({
      _tag: "Continued",
      context: context("replacement"),
      continuation: generated.continuation,
      toolChoice: "none",
    });
    expect(Exit.isSuccess(yield* Effect.exit(inference.executeText(replacement)))).toBe(true);
  })
);

it.effect("validates a continued request without retaining its continuation", () =>
  Effect.gen(function* () {
    const { inference } = yield* makeTestInference();
    const first = yield* inference.prepareText(request(context("first")));
    const generated = yield* inference.executeText(first);

    yield* inference.validateText({
      _tag: "Continued",
      context: context("validation"),
      continuation: generated.continuation,
      toolChoice: "none",
    });

    const replay = yield* Effect.exit(
      inference.prepareText({
        _tag: "Continued",
        context: context("replay"),
        continuation: generated.continuation,
        toolChoice: "none",
      })
    );
    expect(replay._tag).toBe("Failure");
  })
);

it.effect("discards an unexecuted request and rejects later execution", () =>
  Effect.gen(function* () {
    const { executions, inference } = yield* makeTestInference();
    const prepared = yield* inference.prepareText(request(context("discarded")));

    yield* inference.discardText(prepared);
    const execute = yield* Effect.exit(inference.executeText(prepared));
    const discardAgain = yield* Effect.exit(inference.discardText(prepared));

    expect(execute._tag).toBe("Failure");
    expect(discardAgain._tag).toBe("Failure");
    expect(yield* Ref.get(executions)).toEqual([]);
  })
);

it.effect("releases a claimed continuation when continued preparation fails", () =>
  Effect.gen(function* () {
    const state = yield* makeTestInference();
    const attempts = yield* Ref.make(0);
    const failure = new HostedInferenceError({
      reason: { _tag: "ProviderUnavailable" },
      retryable: false,
      retryAfter: Option.none(),
    });
    const inference = makeHostedInference({
      ...state.inferenceAdapter,
      prepare: (input) =>
        Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 2 ? Effect.fail(failure) : state.inferenceAdapter.prepare(input)
          )
        ),
    });
    const first = yield* inference.prepareText(request(context("first")));
    const generated = yield* inference.executeText(first);
    const continuedRequest: HostedTextRequest = {
      _tag: "Continued",
      context: context("failed continuation"),
      continuation: generated.continuation,
      toolChoice: "none",
    };

    expect(Exit.isFailure(yield* Effect.exit(inference.prepareText(continuedRequest)))).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          inference.prepareText({ ...continuedRequest, context: context("released continuation") })
        )
      )
    ).toBe(false);
  })
);

it.effect("rejects recovery after a successful execution", () =>
  Effect.gen(function* () {
    const { inference } = yield* makeTestInference();
    const prepared = yield* inference.prepareText(request(context("successful")));

    yield* inference.executeText(prepared);

    expect(Exit.isFailure(yield* Effect.exit(inference.recoverText(prepared)))).toBe(true);
  })
);

it.effect("recovers invalid output only through an opaque one-shot continuation", () =>
  Effect.gen(function* () {
    const state = yield* makeTestInference();
    const invalid = new HostedInferenceError({
      reason: { _tag: "InvalidOutput", description: "Hosted provider response was invalid" },
      retryable: false,
      retryAfter: Option.none(),
    });
    const inference = makeHostedInference({
      ...state.inferenceAdapter,
      execute: () => Effect.fail(invalid),
    });
    const prepared = yield* inference.prepareText(request(context("stable")));
    yield* Effect.flip(inference.executeText(prepared));
    const continuation = yield* inference.recoverText(prepared);
    const replay = yield* Effect.exit(inference.recoverText(prepared));
    const continued = yield* inference.prepareText({
      _tag: "Continued",
      context: context("feedback"),
      continuation,
      toolChoice: "none",
    });

    expect(replay._tag).toBe("Failure");
    expect(Exit.isFailure(yield* Effect.exit(inference.executeText(continued)))).toBe(true);
  })
);

it.effect("recovers invalid continued output and consumes its source continuation", () =>
  Effect.gen(function* () {
    const state = yield* makeTestInference();
    const attempts = yield* Ref.make(0);
    const invalid = new HostedInferenceError({
      reason: { _tag: "InvalidOutput", description: "Hosted provider response was invalid" },
      retryable: false,
      retryAfter: Option.none(),
    });
    const inference = makeHostedInference({
      ...state.inferenceAdapter,
      execute: (prepared) =>
        Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 2 ? Effect.fail(invalid) : state.inferenceAdapter.execute(prepared)
          )
        ),
    });
    const first = yield* inference.prepareText(request(context("first")));
    const generated = yield* inference.executeText(first);
    const continued = yield* inference.prepareText({
      _tag: "Continued",
      context: context("continued"),
      continuation: generated.continuation,
      toolChoice: "none",
    });
    yield* Effect.flip(inference.executeText(continued));

    const recovered = yield* inference.recoverText(continued);
    const prepared = yield* inference.prepareText({
      _tag: "Continued",
      context: context("recovered"),
      continuation: recovered,
      toolChoice: "none",
    });

    expect(Exit.isSuccess(yield* Effect.exit(inference.executeText(prepared)))).toBe(true);
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
        _tag: "Continued",
        context: context("forged continuation"),
        continuation: forgedContinuation,
        toolChoice: "none",
      })
    );
    const moved = yield* Effect.exit(
      inference.prepareText({
        _tag: "Continued",
        context: context("foreign continuation"),
        continuation: foreignGenerated.continuation,
        toolChoice: "none",
      })
    );
    const continuedContext = makeHostedTextContext({
      prefix: [{ role: "system", content: "stable prefix" }],
      continuationTail: [{ role: "tool", content: [] }],
      suffix: [{ role: "system", content: "next suffix" }],
    });

    const second = yield* inference.prepareText({
      _tag: "Continued",
      context: continuedContext,
      continuation: generated.continuation,
      toolChoice: "none",
    });
    yield* inference.executeText(second);
    const replay = yield* Effect.exit(
      inference.prepareText({
        _tag: "Continued",
        context: context("replay"),
        continuation: generated.continuation,
        toolChoice: "none",
      })
    );

    expect(forged._tag).toBe("Failure");
    expect(moved._tag).toBe("Failure");
    expect(replay._tag).toBe("Failure");
    expect((yield* Ref.get(executions))[1]?.messages).toEqual([
      { role: "system", content: "first" },
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
