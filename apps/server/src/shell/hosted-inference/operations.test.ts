import { strict as assert } from "node:assert";
import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Schema } from "effect";
import { maximumToolCallsPerTurn } from "~/core/agent/contract";
import {
  type HostedContinuationEvent,
  type HostedInferenceError,
  HostedInferenceError as HostedInferenceFailure,
  type HostedInferenceStubBehavior,
  type HostedTextRequest,
  type HostedTextResult,
  HostedToolCallMaximum,
} from "./contract";
import { makeHostedInferenceStub } from "./operations";
import { hostedInitialTextContext as context } from "./context.test-fixture";

const request = (text: string): HostedTextRequest => ({
  context: context(text),
  toolChoice: "auto" as const,
  maximumToolCalls: HostedToolCallMaximum.make(2),
  availableOperations: [],
});

const continuationEvents = (description: string): ReadonlyArray<HostedContinuationEvent> => [
  { _tag: "InvalidOutputFeedback" as const, description },
];

const generated = (text = "ok"): Omit<HostedTextResult, "continuation"> => ({
  text,
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
});

const assertHostedFailure = (exit: unknown, error: HostedInferenceError): void =>
  assert.deepStrictEqual(exit, Exit.fail(error));

const invalidAuthority = (): HostedInferenceError =>
  new HostedInferenceFailure({
    reason: { _tag: "InvalidAuthority" },
    retryable: false,
    retryAfter: Option.none(),
  });

const retryableUnavailable = (): HostedInferenceError =>
  new HostedInferenceFailure({
    reason: { _tag: "ProviderUnavailable" },
    retryable: true,
    retryAfter: Option.none(),
  });

const invalidOutput = (): HostedInferenceError =>
  new HostedInferenceFailure({
    reason: { _tag: "InvalidOutput", description: "Hosted provider response was invalid" },
    retryable: false,
    retryAfter: Option.none(),
  });

it("caps caller-supplied tool maxima at the hosted turn bound", () => {
  expect(() => HostedToolCallMaximum.make(maximumToolCallsPerTurn + 1)).toThrow();
});

const stubBehavior = (
  overrides: Partial<HostedInferenceStubBehavior> = {}
): HostedInferenceStubBehavior => ({
  countText: () => Effect.succeed(1),
  countTranscript: () => Effect.succeed(1),
  validate: () => Effect.void,
  generate: () => Effect.succeed(generated()),
  generateStructured: () => Effect.die("Unexpected structured request"),
  ...overrides,
});

it.effect("keeps structured execution and discard one-shot", () =>
  Effect.gen(function* () {
    const executions = yield* Ref.make(0);
    const inference = makeHostedInferenceStub(
      stubBehavior({
        generateStructured: (schema) =>
          Ref.update(executions, (count) => count + 1).pipe(
            Effect.andThen(
              Schema.decodeUnknownEffect(schema)({ compactedConversation: "trusted" }).pipe(
                Effect.orDie
              )
            )
          ),
      })
    );
    const outputSchema = Schema.Struct({ compactedConversation: Schema.String });
    const executed = yield* inference.prepareStructured({
      context: { prior: Option.some("compact this"), entries: [] },
      purpose: "conversation-compaction",
      outputSchema,
    });
    const discarded = yield* inference.prepareStructured({
      context: { prior: Option.some("discard this"), entries: [] },
      purpose: "conversation-compaction",
      outputSchema,
    });

    yield* discarded.discard;
    assertHostedFailure(yield* Effect.exit(discarded.execute), invalidAuthority());
    expect(yield* executed.execute).toEqual({ compactedConversation: "trusted" });
    assertHostedFailure(yield* Effect.exit(executed.execute), invalidAuthority());
    expect(yield* Ref.get(executions)).toBe(1);
  })
);

it.effect("bounds structured retries after provider unavailability", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const inference = makeHostedInferenceStub(
      stubBehavior({
        generateStructured: () =>
          Ref.update(attempts, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail(retryableUnavailable()))
          ),
      })
    );
    const prepared = yield* inference.prepareStructured({
      context: { prior: Option.none(), entries: [] },
      purpose: "conversation-compaction",
      outputSchema: Schema.Struct({ text: Schema.String }),
    });

    assertHostedFailure(yield* Effect.exit(prepared.execute), retryableUnavailable());
    assertHostedFailure(yield* Effect.exit(prepared.execute), retryableUnavailable());
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidAuthority());
    expect(yield* Ref.get(attempts)).toBe(2);
  })
);

it.effect("rejects concurrent prepared execution", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const inference = makeHostedInferenceStub(
      stubBehavior({
        generate: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(generated())
          ),
      })
    );
    const prepared = yield* inference.prepareText(request("in progress"));
    assertHostedFailure(yield* Effect.exit(prepared.repairInvalidOutput), invalidAuthority());
    const fiber = yield* prepared.execute.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);

    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidAuthority());
    assertHostedFailure(yield* Effect.exit(prepared.discard), invalidAuthority());
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
  })
);

it.effect("allows one explicit retry after provider unavailability", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const inference = makeHostedInferenceStub(
      stubBehavior({
        generate: () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1 ? Effect.fail(retryableUnavailable()) : Effect.succeed(generated())
            )
          ),
      })
    );
    const prepared = yield* inference.prepareText(request("retry"));

    assertHostedFailure(yield* Effect.exit(prepared.execute), retryableUnavailable());
    expect(Exit.isSuccess(yield* Effect.exit(prepared.execute))).toBe(true);
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidAuthority());
  })
);

it.effect("bounds repeated retryable text failures", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const inference = makeHostedInferenceStub(
      stubBehavior({
        generate: () =>
          Ref.update(attempts, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail(retryableUnavailable()))
          ),
      })
    );
    const prepared = yield* inference.prepareText(request("bounded retry"));

    assertHostedFailure(yield* Effect.exit(prepared.execute), retryableUnavailable());
    assertHostedFailure(yield* Effect.exit(prepared.execute), retryableUnavailable());
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidAuthority());
    expect(yield* Ref.get(attempts)).toBe(2);
  })
);

it.effect("consumes discarded and successfully executed text authority", () =>
  Effect.gen(function* () {
    const inference = makeHostedInferenceStub(stubBehavior());
    const executed = yield* inference.prepareText(request("execute once"));

    yield* executed.execute;
    assertHostedFailure(yield* Effect.exit(executed.execute), invalidAuthority());
    assertHostedFailure(yield* Effect.exit(executed.repairInvalidOutput), invalidAuthority());

    const discarded = yield* inference.prepareText(request("discard once"));
    yield* discarded.discard;
    assertHostedFailure(yield* Effect.exit(discarded.execute), invalidAuthority());
    assertHostedFailure(yield* Effect.exit(discarded.discard), invalidAuthority());
  })
);

it.effect("restores a continuation when its preparation is rejected", () =>
  Effect.gen(function* () {
    const validations = yield* Ref.make(0);
    const inference = makeHostedInferenceStub(
      stubBehavior({
        validate: () =>
          Ref.updateAndGet(validations, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 2
                ? Effect.fail(
                    new HostedInferenceFailure({
                      reason: { _tag: "CapacityExceeded", inputTokens: 1 },
                      retryable: false,
                      retryAfter: Option.none(),
                    })
                  )
                : Effect.void
            )
          ),
      })
    );
    const first = yield* inference.prepareText(request("first"));
    const result = yield* first.execute;

    assertHostedFailure(
      yield* Effect.exit(result.continuation.prepare(continuationEvents("rejected"))),
      new HostedInferenceFailure({
        reason: { _tag: "CapacityExceeded", inputTokens: 1 },
        retryable: false,
        retryAfter: Option.none(),
      })
    );
    expect(
      Exit.isSuccess(
        yield* Effect.exit(result.continuation.prepare(continuationEvents("accepted")))
      )
    ).toBe(true);
  })
);

it.effect("repairs invalid output once without exposing feedback preparation", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const inference = makeHostedInferenceStub(
      stubBehavior({
        generate: () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1 ? Effect.fail(invalidOutput()) : Effect.succeed(generated("recovered"))
            )
          ),
      })
    );
    const prepared = yield* inference.prepareText(request("recover"));
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidOutput());
    const recovered = yield* prepared.repairInvalidOutput;
    assertHostedFailure(yield* Effect.exit(prepared.repairInvalidOutput), invalidAuthority());

    expect((yield* recovered.execute).text).toBe("recovered");
    assertHostedFailure(yield* Effect.exit(recovered.execute), invalidAuthority());
  })
);

it.effect("consumes interrupted execution instead of restoring authority", () =>
  Effect.gen(function* () {
    const inference = makeHostedInferenceStub(stubBehavior({ generate: () => Effect.interrupt }));
    const prepared = yield* inference.prepareText(request("interrupt"));

    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidAuthority());
    assertHostedFailure(yield* Effect.exit(prepared.repairInvalidOutput), invalidAuthority());
  })
);

for (const terminalCause of [Cause.die("provider defect"), Cause.interrupt()]) {
  it.effect("consumes text authority when provider failure also contains a terminal cause", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const inference = makeHostedInferenceStub(
        stubBehavior({
          generate: () =>
            Ref.update(attempts, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.failCause(Cause.combine(Cause.fail(retryableUnavailable()), terminalCause))
              )
            ),
        })
      );
      const prepared = yield* inference.prepareText(request("uncertain outcome"));
      expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
      assertHostedFailure(yield* Effect.exit(prepared.execute), invalidAuthority());
      expect(yield* Ref.get(attempts)).toBe(1);
    })
  );
}

it.effect("consumes authority when constructing provider execution defects", () =>
  Effect.gen(function* () {
    let calls = 0;
    const inference = makeHostedInferenceStub(
      stubBehavior({
        generate: () => {
          calls += 1;
          throw new Error("provider construction failed");
        },
      })
    );
    const prepared = yield* inference.prepareText(request("construction defect"));
    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidAuthority());
    assertHostedFailure(yield* Effect.exit(prepared.discard), invalidAuthority());
    expect(calls).toBe(1);
  })
);

it.effect("consumes structured authority for mixed provider failures", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const inference = makeHostedInferenceStub(
      stubBehavior({
        generateStructured: () =>
          Ref.update(attempts, (count) => count + 1).pipe(
            Effect.andThen(
              Effect.failCause(
                Cause.combine(Cause.fail(retryableUnavailable()), Cause.die("uncertain"))
              )
            )
          ),
      })
    );
    const prepared = yield* inference.prepareStructured({
      context: { prior: Option.none(), entries: [] },
      purpose: "conversation-compaction",
      outputSchema: Schema.Struct({ text: Schema.String }),
    });
    expect(Exit.isFailure(yield* Effect.exit(prepared.execute))).toBe(true);
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidAuthority());
    expect(yield* Ref.get(attempts)).toBe(1);
  })
);

it.effect("spends text repair even when feedback preparation fails", () =>
  Effect.gen(function* () {
    const validations = yield* Ref.make(0);
    const inference = makeHostedInferenceStub(
      stubBehavior({
        validate: () =>
          Ref.updateAndGet(validations, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1 ? Effect.void : Effect.fail(retryableUnavailable())
            )
          ),
        generate: () => Effect.fail(invalidOutput()),
      })
    );
    const prepared = yield* inference.prepareText(request("repair once"));
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidOutput());
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidAuthority());
    assertHostedFailure(yield* Effect.exit(prepared.repairInvalidOutput), retryableUnavailable());
    assertHostedFailure(yield* Effect.exit(prepared.repairInvalidOutput), invalidAuthority());
    assertHostedFailure(yield* Effect.exit(prepared.discard), invalidAuthority());
    expect(yield* Ref.get(validations)).toBe(2);
  })
);

it.effect("discard after invalid text output spends the separate repair right", () =>
  Effect.gen(function* () {
    const inference = makeHostedInferenceStub(
      stubBehavior({ generate: () => Effect.fail(invalidOutput()) })
    );
    const prepared = yield* inference.prepareText(request("discard repair"));
    assertHostedFailure(yield* Effect.exit(prepared.execute), invalidOutput());
    yield* prepared.discard;
    assertHostedFailure(yield* Effect.exit(prepared.repairInvalidOutput), invalidAuthority());
    assertHostedFailure(yield* Effect.exit(prepared.discard), invalidAuthority());
  })
);

it.effect("reserves continuation preparation and restores only failed preparation", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const validations = yield* Ref.make(0);
    const inference = makeHostedInferenceStub(
      stubBehavior({
        validate: () =>
          Ref.updateAndGet(validations, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 2
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void
            )
          ),
      })
    );
    const prepared = yield* inference.prepareText(request("continue"));
    const { continuation } = yield* prepared.execute;
    const pending = yield* continuation
      .prepare(continuationEvents("interrupted"))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    assertHostedFailure(
      yield* Effect.exit(continuation.prepare(continuationEvents("concurrent"))),
      invalidAuthority()
    );
    yield* Fiber.interrupt(pending);
    const descendant = yield* continuation.prepare(continuationEvents("accepted"));
    assertHostedFailure(
      yield* Effect.exit(continuation.prepare(continuationEvents("spent"))),
      invalidAuthority()
    );
    yield* descendant.discard;
    assertHostedFailure(
      yield* Effect.exit(continuation.prepare(continuationEvents("discarded descendant"))),
      invalidAuthority()
    );
    expect(yield* Ref.get(validations)).toBe(3);
  })
);

it.effect("reuses the exact captured request for an admitted provider retry", () =>
  Effect.gen(function* () {
    const admitted: Array<Parameters<HostedInferenceStubBehavior["generate"]>[0]> = [];
    const availableOperations: HostedTextRequest["availableOperations"][number][] = [];
    const inference = makeHostedInferenceStub(
      stubBehavior({
        generate: (captured) => {
          admitted.push(captured);
          return admitted.length === 1
            ? Effect.fail(retryableUnavailable())
            : Effect.succeed(generated());
        },
      })
    );
    const prepared = yield* inference.prepareText({
      ...request("fixed work"),
      availableOperations,
    });
    expect(Object.isFrozen(availableOperations)).toBe(false);
    assertHostedFailure(yield* Effect.exit(prepared.execute), retryableUnavailable());
    yield* prepared.execute;
    expect(admitted).toHaveLength(2);
    expect(admitted[1]).toBe(admitted[0]);
    expect(admitted[1]).toEqual({
      toolChoice: "auto",
      maximumToolCalls: 2,
      availableOperations: [],
    });
  })
);

it.effect("restores continuation when constructing preparation defects", () =>
  Effect.gen(function* () {
    let validations = 0;
    const inference = makeHostedInferenceStub(
      stubBehavior({
        validate: () => {
          validations += 1;
          if (validations === 2) throw new Error("preparation construction failed");
          return Effect.void;
        },
      })
    );
    const prepared = yield* inference.prepareText(request("continuation construction"));
    const { continuation } = yield* prepared.execute;
    expect(
      Exit.isFailure(yield* Effect.exit(continuation.prepare(continuationEvents("defect"))))
    ).toBe(true);
    const descendant = yield* continuation.prepare(continuationEvents("restored"));
    expect((yield* descendant.execute).text).toBe("ok");
    expect(validations).toBe(3);
  })
);
