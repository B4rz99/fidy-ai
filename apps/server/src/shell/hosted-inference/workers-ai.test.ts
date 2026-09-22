import { strict as assert } from "node:assert";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
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
  output: ReadonlyArray<unknown>;
  status: "completed" | "queued";
  usage: unknown;
}>;

const response = (body: unknown, status = 200): Response => Response.json(body, { status });

const completed = (overrides: Partial<ProviderResponseFixture> = {}): Response =>
  response({
    status: "completed",
    output: [
      {
        id: "message-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Listo" }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
    ...overrides,
  });

const requestTextContent = (request: WorkersAiRequest): ReadonlyArray<string> =>
  request.input.flatMap((item) =>
    "role" in item && typeof item.content === "string" ? [item.content] : []
  );

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

it.effect("sends canonical tool schemas through the direct binding with bounded generation", () =>
  Effect.gen(function* () {
    const binding = captureRun(() => Promise.resolve(completed()));
    const inference = yield* makeConfiguredInference(binding.run);
    const prepared = yield* inference.prepareText({
      context: initialContext(),
      availableOperations: [CanonicalOperationId.make("transactions.createTransaction")],
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(1),
    });

    yield* prepared.execute;

    expect(binding.calls).toHaveLength(1);
    const call = binding.calls[0];
    expect(call?.model).toBe(approvedWorkersAiModel);
    expect(call?.options.returnRawResponse).toBe(true);
    expect(call?.request).toMatchObject({
      max_output_tokens: 16_000,
      parallel_tool_calls: false,
      truncation: "disabled",
    });
    expect(call?.request).not.toHaveProperty("gateway");
    expect(call?.request).not.toHaveProperty("store");
    expect(call?.request.tools.map(({ name }) => name)).toContain(
      "transactions__createTransaction"
    );
    const textContent = call === undefined ? [] : requestTextContent(call.request);
    expect(textContent.some((content) => content.includes("es-CO"))).toBe(true);
    expect(
      textContent.some((content) => content.includes("Gasté 42.500 pesos en el mercado"))
    ).toBe(true);
  })
);

it.effect("rejects malformed canonical tool arguments without exposing provider content", () =>
  Effect.gen(function* () {
    const privateValue = "4111111111111111";
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          output: [
            {
              type: "function_call",
              call_id: "call-1",
              name: "transactions__createTransaction",
              arguments: JSON.stringify({ privateValue }),
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
      completed({ status: "queued" }),
      completed({ usage: undefined }),
      completed({
        usage: {
          input_tokens: 12,
          output_tokens: excessiveOutputTokens,
          total_tokens: excessiveOutputTokens + 12,
        },
      }),
      completed({
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "private refusal content" }],
          },
        ],
      }),
      completed({ output: [] }),
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
    expect(binding.calls[1]?.request.input).toEqual(
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
          output: [
            {
              id: "message-1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: `${privateValue}${"x".repeat(600_000)}` }],
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
      type: "function_call",
      name: "transactions__createTransaction",
      arguments: "{}",
    };
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          output: [
            { ...call, call_id: "call-1" },
            { ...call, call_id: "call-2" },
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
          output: [
            {
              id: "message-1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: '{"text":"resumen"}' }],
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
    expect(binding.calls[0]?.request.text).toMatchObject({
      format: { type: "json_schema", strict: true },
    });
  })
);

it.effect("rejects malformed structured output without exposing it", () =>
  Effect.gen(function* () {
    const privateValue = "private malformed finance";
    const binding = captureRun(() =>
      Promise.resolve(
        completed({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: `{${privateValue}` }],
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
