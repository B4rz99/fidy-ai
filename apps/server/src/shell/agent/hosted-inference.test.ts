import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option, Ref, Schema } from "effect";
import type { Prompt } from "effect/unstable/ai";
import {
  type HostedInferenceAdapter,
  HostedInferenceError,
  type HostedStructuredAdapter,
  HostedStructuredObjectName,
  type HostedTextContext,
  type HostedTextResult,
  HostedToolCallMaximum,
  type InitialHostedTextRequest,
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
    countText: (text) => Effect.succeed(text.length),
    countTranscript: (messages) => Effect.succeed(messages.length),
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

const request = (hostedContext: HostedTextContext): InitialHostedTextRequest => ({
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
      const _secondInference = makeHostedInference({
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
      yield* discarded.discard;
      yield* firstInference.prepareText(request(context("text")));
      const forged = yield* Schema.decodeUnknownEffect(ForgedPreparedStructured)(
        Object.freeze({
          execute: Effect.fail(
            new HostedInferenceError({
              reason: { _tag: "InvalidAuthority" },
              retryable: false,
              retryAfter: Option.none(),
            })
          ),
        })
      );

      const exits = yield* Effect.all(
        [
          Effect.fail(
            new HostedInferenceError({
              reason: { _tag: "InvalidAuthority" },
              retryable: false,
              retryAfter: Option.none(),
            })
          ),
          forged.execute,
          discarded.execute,
        ].map(Effect.exit)
      );
      expect(exits.every(Exit.isFailure)).toBe(true);
      expect(yield* Ref.get(executions)).toBe(0);

      expect(yield* prepared.execute).toEqual({
        compactedConversation: "trusted",
      });
      expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
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

    const output = yield* prepared.execute;

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
    const fiber = yield* prepared.execute.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);

    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
    yield* Fiber.interrupt(fiber);
    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
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

    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
    expect(yield* prepared.execute).toEqual({ value: "retried" });
    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
  })
);

it.effect("rejects concurrent use of a prepared text authority", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const state = yield* makeTestInference();
    const inference = makeHostedInference({
      ...state.inferenceAdapter,
      execute: (exactRequest) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(state.inferenceAdapter.execute(exactRequest))
        ),
    });
    const prepared = yield* inference.prepareText(request(context("in progress")));
    const fiber = yield* prepared.execute.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);

    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(prepared.discard))).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
  })
);

it.effect("allows text retry only after retryable provider failure", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const state = yield* makeTestInference();
    const unavailable = new HostedInferenceError({
      reason: { _tag: "ProviderUnavailable" },
      retryable: true,
      retryAfter: Option.none(),
    });
    const inference = makeHostedInference({
      ...state.inferenceAdapter,
      execute: (request) =>
        Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1 ? Effect.fail(unavailable) : state.inferenceAdapter.execute(request)
          )
        ),
    });
    const prepared = yield* inference.prepareText(request(context("retry")));

    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
    expect((yield* prepared.execute).text).toBe("done");
    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
  })
);

it.effect("consumes text authority after a non-retryable provider failure", () =>
  Effect.gen(function* () {
    const state = yield* makeTestInference();
    const attempts = yield* Ref.make(0);
    const inference = makeHostedInference({
      ...state.inferenceAdapter,
      execute: () =>
        Ref.update(attempts, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(
              new HostedInferenceError({
                reason: { _tag: "ProviderUnavailable" },
                retryable: false,
                retryAfter: Option.none(),
              })
            )
          )
        ),
    });
    const prepared = yield* inference.prepareText(request(context("do not retry")));

    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
    expect(yield* Ref.get(attempts)).toBe(1);
  })
);

it.effect("executes only the exact complete request stored by preparation", () =>
  Effect.gen(function* () {
    const { executions, inference } = yield* makeTestInference();
    const prepared = yield* inference.prepareText(request(context("hello")));

    const generated = yield* prepared.execute;

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

    const forgedBehavior = yield* Schema.decodeUnknownEffect(ForgedPreparedStructured)({
      execute: Effect.fail(
        new HostedInferenceError({
          reason: { _tag: "InvalidAuthority" },
          retryable: false,
          retryAfter: Option.none(),
        })
      ),
    });
    const foreignPrepared = yield* Effect.exit(forgedBehavior.execute);
    const secondProjection = yield* Effect.exit(
      second.inference.prepareText(request(sharedContext))
    );
    const forged = yield* Effect.exit(forgedBehavior.execute);
    yield* prepared.execute;
    const replayed = yield* Effect.exit(prepared.execute);

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
    const generated = yield* first.execute;
    const forgedContext = yield* Schema.decodeUnknownEffect(ForgedHostedTextContext)({
      claim: () =>
        Option.some({
          prefix: [{ role: "system", content: "forged" }],
          continuationTail: [],
          suffix: [],
        }),
    });

    const exit = yield* Effect.exit(
      generated.continuation.prepare(forgedContext, { toolChoice: "none" })
    );

    expect(exit._tag).toBe("Failure");
  })
);

it.effect("discarding an unexecuted continued request consumes its continuation", () =>
  Effect.gen(function* () {
    const { inference } = yield* makeTestInference();
    const first = yield* inference.prepareText(request(context("first")));
    const generated = yield* first.execute;
    const continued = yield* generated.continuation.prepare(context("continued"), {
      toolChoice: "none",
    });

    yield* continued.discard;

    const replacement = yield* Effect.exit(
      generated.continuation.prepare(context("replacement"), { toolChoice: "none" })
    );
    expect(Exit.isFailure(replacement)).toBe(true);
  })
);

it.effect("validates a continued request without retaining its continuation", () =>
  Effect.gen(function* () {
    const { inference } = yield* makeTestInference();
    const first = yield* inference.prepareText(request(context("first")));
    const generated = yield* first.execute;

    const validation = yield* generated.continuation.prepare(context("validation"), {
      toolChoice: "none",
    });
    yield* validation.discard;

    const replay = yield* Effect.exit(
      generated.continuation.prepare(context("replay"), { toolChoice: "none" })
    );
    expect(replay._tag).toBe("Failure");
  })
);

it.effect("discards an unexecuted request and rejects later execution", () =>
  Effect.gen(function* () {
    const { executions, inference } = yield* makeTestInference();
    const prepared = yield* inference.prepareText(request(context("discarded")));

    yield* prepared.discard;
    const execute = yield* Effect.exit(prepared.execute);
    const discardAgain = yield* Effect.exit(prepared.discard);

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
    const generated = yield* first.execute;
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          generated.continuation.prepare(context("failed continuation"), { toolChoice: "none" })
        )
      )
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          generated.continuation.prepare(context("released continuation"), { toolChoice: "none" })
        )
      )
    ).toBe(false);
  })
);

it.effect("rejects recovery after a successful execution", () =>
  Effect.gen(function* () {
    const { inference } = yield* makeTestInference();
    const prepared = yield* inference.prepareText(request(context("successful")));

    yield* prepared.execute;

    expect(Exit.isFailure(yield* Effect.exit(prepared.recover))).toBe(true);
  })
);

it.effect("discards a recoverable text authority without exposing its continuation", () =>
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
    const prepared = yield* inference.prepareText(request(context("discard recovery")));

    yield* Effect.flip(prepared.execute);
    yield* prepared.discard;

    expect(Exit.isFailure(yield* Effect.exit(prepared.recover))).toBe(true);
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
    yield* Effect.flip(prepared.execute);
    const continuation = yield* prepared.recover;
    const replay = yield* Effect.exit(prepared.recover);
    const continued = yield* continuation.prepare(context("feedback"), { toolChoice: "none" });

    expect(replay._tag).toBe("Failure");
    expect(Exit.isFailure(yield* Effect.exit(continued.execute))).toBe(true);
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
    const generated = yield* first.execute;
    const continued = yield* generated.continuation.prepare(context("continued"), {
      toolChoice: "none",
    });
    yield* Effect.flip(continued.execute);

    const recovered = yield* continued.recover;
    const prepared = yield* recovered.prepare(context("recovered"), { toolChoice: "none" });

    expect(Exit.isSuccess(yield* Effect.exit(prepared.execute))).toBe(true);
  })
);

it.effect("continues only through an opaque one-shot adapter continuation", () =>
  Effect.gen(function* () {
    const { executions, inference } = yield* makeTestInference();
    const foreign = yield* makeTestInference();
    const first = yield* inference.prepareText(request(context("first")));
    const generated = yield* first.execute;
    const foreignPrepared = yield* foreign.inference.prepareText(request(context("foreign")));
    const foreignGenerated = yield* foreignPrepared.execute;
    const foreignUse = yield* foreignGenerated.continuation.prepare(context("foreign use"), {
      toolChoice: "none",
    });
    const continuedContext = makeHostedTextContext({
      prefix: [{ role: "system", content: "stable prefix" }],
      continuationTail: [{ role: "tool", content: [] }],
      suffix: [{ role: "system", content: "next suffix" }],
    });

    const second = yield* generated.continuation.prepare(continuedContext, { toolChoice: "none" });
    yield* second.execute;
    const replay = yield* Effect.exit(
      generated.continuation.prepare(context("replay"), { toolChoice: "none" })
    );

    expect(Exit.isSuccess(yield* Effect.exit(foreignUse.execute))).toBe(true);
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
