import { Effect, Option } from "effect";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedInferenceStubBehavior,
  type HostedTextContext,
  type HostedTextContinuation,
  type HostedTextToolPolicy,
  type PreparedHostedText,
} from "~/shell/hosted-inference/contract";
import {
  continuationPolicy,
  makeContinuationAuthority,
  makeOneShotPreparation,
  makePreparedLifecycleTransitions,
  makePreparedTextAuthority,
} from "./authority";

const invalidAuthority = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "InvalidAuthority" },
    retryable: false,
    retryAfter: Option.none(),
  });

const makePrepared = (
  behavior: HostedInferenceStubBehavior,
  contexts: ReadonlyArray<HostedTextContext>,
  policy: HostedTextToolPolicy
): PreparedHostedText => {
  const lifecycle = makePreparedLifecycleTransitions();
  const makeContinuation = (nextPolicy: HostedTextToolPolicy): HostedTextContinuation => {
    const guard = makeOneShotPreparation();
    return makeContinuationAuthority({
      prepare: (events: Parameters<HostedTextContinuation["prepare"]>[0]) =>
        Effect.suspend(() => {
          if (!guard.begin()) return Effect.fail(invalidAuthority());
          const context: HostedTextContext = {
            sections: structuredClone(events),
            activeRequest: { _tag: "Absent" },
          };
          return behavior.validateText({ context, ...nextPolicy }).pipe(
            Effect.map(() => makePrepared(behavior, [...contexts, context], nextPolicy)),
            Effect.tapError(() => Effect.sync(() => guard.restore()))
          );
        }),
    });
  };
  const execute: PreparedHostedText["execute"] = Effect.suspend(() => {
    if (!lifecycle.beginExecution()) return Effect.fail(invalidAuthority());
    return behavior.generate(contexts, policy).pipe(
      Effect.tapError((error) => Effect.sync(() => lifecycle.failExecution(error))),
      Effect.tap(() => Effect.sync(() => lifecycle.completeExecution())),
      Effect.onExit(() =>
        Effect.sync(() => {
          if (lifecycle.current() === "executing") lifecycle.completeExecution();
        })
      ),
      Effect.map((result) => ({
        ...result,
        continuation: makeContinuation(
          continuationPolicy({ policy, consumedToolCalls: result.toolCalls.length })
        ),
      }))
    );
  });
  const recover: PreparedHostedText["recover"] = Effect.suspend(() => {
    if (!lifecycle.beginRecovery()) return Effect.fail(invalidAuthority());
    return Effect.succeed(makeContinuation(policy));
  });
  const discard: PreparedHostedText["discard"] = Effect.suspend(() => {
    if (!lifecycle.beginDiscard()) return Effect.fail(invalidAuthority());
    return Effect.void;
  });
  return makePreparedTextAuthority({ execute, recover, discard });
};

/** Builds deterministic inference while preserving one-shot prepared authority. @internal */
export const makeHostedInferenceStubInternal = (
  behavior: HostedInferenceStubBehavior
): HostedInferenceService => ({
  countText: behavior.countText,
  countTranscript: behavior.countTranscript,
  prepareText: (request) =>
    behavior
      .validateText(request)
      .pipe(Effect.map(() => makePrepared(behavior, [structuredClone(request.context)], request))),
  validateText: behavior.validateText,
  prepareStructured: behavior.prepareStructured,
});
