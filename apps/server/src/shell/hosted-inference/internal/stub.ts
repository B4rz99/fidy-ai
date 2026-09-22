import { Effect } from "effect";
import type {
  HostedInferenceService,
  HostedInferenceStubBehavior,
} from "~/shell/hosted-inference/contract";
import type { HostedInferenceAdapter } from "./adapter";
import { makeHostedInferenceInternal } from "./inference";

type StubRequest = Parameters<HostedInferenceStubBehavior["generate"]>[0];

/** Builds deterministic inference through the same orchestration used by production adapters. */
export const makeHostedInferenceStubInternal = (
  behavior: HostedInferenceStubBehavior
): HostedInferenceService => {
  const adapter: HostedInferenceAdapter<StubRequest, void> = {
    countText: behavior.countText,
    countTranscript: behavior.countTranscript,
    prepare: (input) =>
      behavior.validate().pipe(
        Effect.as({
          availableOperations: input.availableOperations,
          ...(input.toolChoice === "none"
            ? { toolChoice: "none" as const }
            : {
                maximumToolCalls: input.maximumToolCalls,
                toolChoice: "auto" as const,
              }),
        })
      ),
    execute: (request) =>
      behavior.generate(request).pipe(
        Effect.map((result) => ({
          continuation: undefined,
          result,
        }))
      ),
    structured: {
      prepare: ({ outputSchema }) =>
        Effect.succeed({ execute: behavior.generateStructured(outputSchema) }),
    },
  };
  return makeHostedInferenceInternal(adapter);
};
