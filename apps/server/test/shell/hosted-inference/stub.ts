import { Effect } from "effect";
import type {
  HostedInferenceService,
  HostedInferenceStubBehavior,
} from "~/shell/hosted-inference/contract";
import type { HostedInferenceAdapter } from "~/shell/hosted-inference/internal/adapter";
import { hostedInferenceInternal } from "~/shell/hosted-inference/internal/inference";

type StubRequest = Parameters<HostedInferenceStubBehavior["generate"]>[0];

export const makeHostedInferenceStub = (
  behavior: HostedInferenceStubBehavior
): HostedInferenceService => {
  const adapter: HostedInferenceAdapter<StubRequest, void> = {
    countText: behavior.countText,
    countTranscript: behavior.countTranscript,
    prepare: (input) =>
      behavior.validate().pipe(
        Effect.as(
          input.toolChoice === "none"
            ? { availableOperations: input.availableOperations, toolChoice: "none" as const }
            : {
                availableOperations: input.availableOperations,
                maximumToolCalls: input.maximumToolCalls,
                toolChoice: "auto" as const,
              }
        )
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

  return hostedInferenceInternal(adapter);
};
