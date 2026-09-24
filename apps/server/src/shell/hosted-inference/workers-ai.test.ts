import { strict as assert } from "node:assert";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { ToolCallId } from "~/core/transcript/model";
import {
  HostedInferenceError,
  type HostedInferenceFailureReason,
  type HostedInferenceService,
  type HostedInitialTextContext,
  HostedToolCallMaximum,
} from "./contract";
import { approvedWorkersAiModel } from "./model";
import { hostedInitialTextContext } from "./test-fixtures";
import {
  type WorkersAiBindingRun,
  type WorkersAiRequest,
  makeWorkersAiHostedInference,
} from "./workers-ai";

const hostedFailure = (
  reason: HostedInferenceFailureReason,
  retryable = false
): HostedInferenceError =>
  new HostedInferenceError({ reason, retryable, retryAfter: Option.none() });

const assertHostedFailure = (exit: unknown, expected: HostedInferenceError): void =>
  assert.deepStrictEqual(exit, Exit.fail(expected));
const excessiveOutputTokens = 16_001;

const initialContext = (text = "Gasté 42.500 pesos en el mercado"): HostedInitialTextContext =>
  hostedInitialTextContext(text);

type ProviderResponseFixture = Readonly<{
  choices: ReadonlyArray<unknown>;
  usage: unknown;
}>;

const response = (body: unknown, status = 200): Response => Response.json(body, { status });

const completed = (overrides: Partial<ProviderResponseFixture> = {}): Response =>
  response({
    choices: [{ message: { role: "assistant", content: "Listo" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
    ...overrides,
  });

const captureRun = (
  reply: (request: WorkersAiRequest, signal: AbortSignal) => Promise<Response>
): Readonly<{
  calls: Array<
    Readonly<{
      model: string;
      request: WorkersAiRequest;
      options: Readonly<{ returnRawResponse: true; signal: AbortSignal }>;
    }>
  >;
  run: WorkersAiBindingRun;
}> => {
  const calls: Array<
    Readonly<{
      model: string;
      request: WorkersAiRequest;
      options: Readonly<{ returnRawResponse: true; signal: AbortSignal }>;
    }>
  > = [];
  return {
    calls,
    run: (model, request, options) => {
      calls.push({ model, request, options });
      return reply(request, options.signal);
    },
  };
};

const makeConfiguredInference = (
  run: WorkersAiBindingRun
): Effect.Effect<HostedInferenceService, HostedInferenceError> =>
  makeWorkersAiHostedInference({
    model: Option.some(approvedWorkersAiModel),
    run: Option.some(run),
  });

it.effect("fails closed when the configured Workers AI model is absent or unsupported", () =>
  Effect.gen(function* () {
    const run = captureRun(() => Promise.resolve(completed())).run;

    const configurations = [
      { model: Option.none<string>(), run: Option.some(run) },
      {
        model: Option.some("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        run: Option.some(run),
      },
      { model: Option.some<string>(approvedWorkersAiModel), run: Option.none() },
    ];
    for (const configuration of configurations) {
      const exit = yield* Effect.exit(makeWorkersAiHostedInference(configuration));
      assertHostedFailure(exit, hostedFailure({ _tag: "ProviderUnavailable" }));
    }
  })
);

it.effect(
  "selects a canonical operation from Gemma chat completions without granting extra tools",
  () =>
    Effect.gen(function* () {
      const binding = captureRun(() =>
        Promise.resolve(
          response({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "transactions__listTransactions",
                        arguments: '{"query":{}}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
          })
        )
      );

      const inference = yield* makeConfiguredInference(binding.run);
      const prepared = yield* inference.prepareText({
        context: initialContext(),
        availableOperations: [CanonicalOperationId.make("transactions.listTransactions")],
        toolChoice: "auto",
        maximumToolCalls: HostedToolCallMaximum.make(1),
      });

      const result = yield* prepared.execute;
      expect(result.toolCalls.map(({ operation }) => operation)).toEqual([
        "transactions.listTransactions",
      ]);
      expect(binding.calls).toHaveLength(1);
      const call = binding.calls[0];
      expect(call?.model).toBe(approvedWorkersAiModel);
      expect(call?.options.returnRawResponse).toBe(true);
      expect(call?.request).toMatchObject({
        max_tokens: 16_000,
        chat_template_kwargs: { enable_thinking: false },
        tool_choice: "auto",
      });
      expect(call?.request).not.toHaveProperty("gateway");
      expect(call?.request).not.toHaveProperty("store");
      expect(call?.request).toMatchObject({
        tools: [{ type: "function", function: { name: "transactions__listTransactions" } }],
      });
      expect(call?.request).toHaveProperty("messages");
    })
);

it.effect("rejects a truncated tool call before it can be executed", () =>
  Effect.gen(function* () {
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "transactions__listTransactions", arguments: '{"query":{}}' },
                  },
                ],
              },
              finish_reason: "length",
            },
          ],
        })
      )
    );
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareText({
      context: initialContext(),
      availableOperations: [CanonicalOperationId.make("transactions.listTransactions")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });

    assertHostedFailure(
      yield* Effect.exit(prepared.execute),
      hostedFailure({ _tag: "InvalidOutput", description: "Hosted provider response was invalid" })
    );
    expect(binding.calls).toHaveLength(1);
  })
);

it.effect("rejects malformed canonical tool arguments without exposing provider content", () =>
  Effect.gen(function* () {
    const privateValue = "4111111111111111";
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "transactions__createTransaction",
                      arguments: JSON.stringify({ privateValue }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })
      )
    );
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareText({
      context: initialContext(),
      availableOperations: [CanonicalOperationId.make("transactions.createTransaction")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });

    const exit = yield* Effect.exit(prepared.execute);

    assertHostedFailure(
      exit,
      hostedFailure({ _tag: "InvalidOutput", description: "Hosted tool arguments were invalid" })
    );
    expect(String(exit)).not.toContain(privateValue);
  })
);

it.effect("rejects unfinished, refused, and empty provider output", () =>
  Effect.gen(function* () {
    const invalidResponses = [
      completed({ choices: [] }),
      completed({ usage: undefined }),
      completed({
        usage: {
          prompt_tokens: 12,
          completion_tokens: excessiveOutputTokens,
          total_tokens: excessiveOutputTokens + 12,
        },
      }),
      completed({
        choices: [
          {
            message: { role: "assistant", content: null, refusal: "private refusal content" },
            finish_reason: "stop",
          },
        ],
      }),
      completed({
        choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
      }),
    ];

    for (const invalidResponse of invalidResponses) {
      const binding = captureRun(() => Promise.resolve(invalidResponse));
      const inference = yield* makeConfiguredInference(binding.run);
      const prepared = yield* inference.prepareText({
        context: initialContext(),
        availableOperations: [],
        toolChoice: "none",
      });
      const exit = yield* Effect.exit(prepared.execute);

      assertHostedFailure(
        exit,
        hostedFailure({
          _tag: "InvalidOutput",
          description: "Hosted provider response was invalid",
        })
      );
      expect(String(exit)).not.toContain("private refusal content");
    }
  })
);

it.effect("preserves provider continuation across repeated bounded rounds", () =>
  Effect.gen(function* () {
    const binding = captureRun(() => Promise.resolve(completed()));
    const inference = yield* makeConfiguredInference(binding.run);
    const first = yield* inference.prepareText({
      context: initialContext(),
      availableOperations: [],
      toolChoice: "none",
    });
    const generated = yield* first.execute;
    const second = yield* generated.continuation.prepare([
      { _tag: "InvalidOutputFeedback", description: "Answer with the corrected shape." },
    ]);

    yield* second.execute;

    expect(binding.calls).toHaveLength(2);
    expect(binding.calls[1]?.request.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({
          role: "system",
          content: "Answer with the corrected shape.",
        }),
      ])
    );
  })
);

it.effect("continues a canonical operation with the matching tool result in Gemma messages", () =>
  Effect.gen(function* () {
    const binding = captureRun(() =>
      Promise.resolve(
        binding.calls.length === 1
          ? completed({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "transactions__listTransactions",
                          arguments: '{"query":{}}',
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            })
          : completed()
      )
    );
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareText({
      context: initialContext(),
      availableOperations: [CanonicalOperationId.make("transactions.listTransactions")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });
    const first = yield* prepared.execute;
    const next = yield* first.continuation.prepare([
      {
        _tag: "ToolResult",
        toolCallId: ToolCallId.make("call-1"),
        operation: CanonicalOperationId.make("transactions.listTransactions"),
        outcome: { _tag: "Succeeded", output: { count: 1 } },
      },
    ]);
    expect((yield* next.execute).text).toBe("Listo");
    expect(binding.calls[1]?.request.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [expect.objectContaining({ id: "call-1" })],
        }),
        { role: "tool", tool_call_id: "call-1", content: '{"count":1}' },
      ])
    );
  })
);

it.effect("rejects oversized context before invoking Workers AI", () =>
  Effect.gen(function* () {
    const binding = captureRun(() => Promise.resolve(completed()));
    const inference = yield* makeConfiguredInference(binding.run);

    const exit = yield* Effect.exit(
      inference.prepareText({
        context: initialContext("x".repeat(130_000)),
        availableOperations: [],
        toolChoice: "none",
      })
    );

    assertHostedFailure(
      exit,
      hostedFailure({
        _tag: "ActiveRequestCapacityExceeded",
        inputTokens: 130_000,
        maximumTokens: 16_000,
      })
    );
    expect(binding.calls).toHaveLength(0);
  })
);

it.effect("bounds provider responses and performs no hidden retry", () =>
  Effect.gen(function* () {
    const privateValue = "private financial provider payload";
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          choices: [
            {
              message: { role: "assistant", content: `${privateValue}${"x".repeat(600_000)}` },
              finish_reason: "stop",
            },
          ],
        })
      )
    );
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareText({
      context: initialContext(),
      availableOperations: [],
      toolChoice: "none",
    });

    const exit = yield* Effect.exit(prepared.execute);

    assertHostedFailure(
      exit,
      hostedFailure({
        _tag: "InvalidOutput",
        description: "Hosted provider response was invalid",
      })
    );
    expect(binding.calls).toHaveLength(1);
    expect(String(exit)).not.toContain(privateValue);
  })
);

it.effect("times out stalled response bodies and cancels their reader", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const binding = captureRun(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel: (): void => {
              cancelled = true;
            },
            pull: (): void => undefined,
          })
        )
      )
    );
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareText({
      context: initialContext(),
      availableOperations: [],
      toolChoice: "none",
    });
    const execution = yield* prepared.execute.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;

    yield* TestClock.adjust("121 seconds");
    const exit = yield* Effect.exit(Fiber.join(execution));

    assertHostedFailure(exit, hostedFailure({ _tag: "ProviderUnavailable" }, true));
    expect(cancelled).toBe(true);
  })
);

it.effect("enforces the per-round tool-call bound before decoding arguments", () =>
  Effect.gen(function* () {
    const call = {
      type: "function",
      function: { name: "transactions__createTransaction", arguments: "{}" },
    };
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { ...call, id: "call-1" },
                  { ...call, id: "call-2" },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })
      )
    );
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareText({
      context: initialContext(),
      availableOperations: [CanonicalOperationId.make("transactions.createTransaction")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });

    const exit = yield* Effect.exit(prepared.execute);

    assertHostedFailure(
      exit,
      hostedFailure({
        _tag: "InvalidOutput",
        description: "Deterministic model exceeded the hosted tool-call limit",
      })
    );
    expect(binding.calls).toHaveLength(1);
  })
);

it.effect("strictly decodes bounded structured output", () =>
  Effect.gen(function* () {
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          choices: [
            {
              message: { role: "assistant", content: '{"text":"resumen"}' },
              finish_reason: "stop",
            },
          ],
        })
      )
    );
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareStructured({
      context: { prior: Option.none(), entries: [] },
      purpose: "conversation-compaction",
      outputSchema: Schema.Struct({ text: Schema.String }),
    });

    expect(yield* prepared.execute).toEqual({ text: "resumen" });
    expect(binding.calls[0]?.request.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true },
    });
  })
);

it.effect("rejects truncated structured output even if its JSON happens to parse", () =>
  Effect.gen(function* () {
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          choices: [
            {
              message: { role: "assistant", content: '{"text":"partial"}' },
              finish_reason: "length",
            },
          ],
        })
      )
    );
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareStructured({
      context: { prior: Option.none(), entries: [] },
      purpose: "conversation-compaction",
      outputSchema: Schema.Struct({ text: Schema.String }),
    });

    assertHostedFailure(
      yield* Effect.exit(prepared.execute),
      hostedFailure({ _tag: "StructuredOutputExceeded" })
    );
  })
);

it.effect("rejects malformed structured output without exposing it", () =>
  Effect.gen(function* () {
    const privateValue = "private malformed finance";
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          choices: [
            { message: { role: "assistant", content: `{${privateValue}` }, finish_reason: "stop" },
          ],
        })
      )
    );
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareStructured({
      context: { prior: Option.none(), entries: [] },
      purpose: "conversation-compaction",
      outputSchema: Schema.Struct({ text: Schema.String }),
    });

    const exit = yield* Effect.exit(prepared.execute);

    assertHostedFailure(
      exit,
      hostedFailure({
        _tag: "InvalidOutput",
        description: "Hosted structured output was malformed",
      })
    );
    expect(String(exit)).not.toContain(privateValue);
  })
);

it.effect("aborts the Workers AI call when execution is interrupted", () =>
  Effect.gen(function* () {
    let observed = Option.none<AbortSignal>();
    const pending = Promise.withResolvers<Response>();
    const binding = captureRun((_request, signal) => {
      observed = Option.some(signal);
      signal.addEventListener(
        "abort",
        () => pending.reject(new Error("private provider failure")),
        { once: true }
      );
      return pending.promise;
    });
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareText({
      context: initialContext(),
      availableOperations: [],
      toolChoice: "none",
    });
    const fiber = yield* prepared.execute.pipe(Effect.forkChild({ startImmediately: true }));

    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);

    expect(Option.getOrThrow(observed).aborted).toBe(true);
  })
);
