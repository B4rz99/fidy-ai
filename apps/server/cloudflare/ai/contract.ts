import type { WorkersAiBindingRun } from "@fidy/server/hosted-inference";

/** Core bindings required to construct hosted inference without any external-model route. */
export type WorkersAiEnvironment = Readonly<{
  AI: Readonly<{ run: WorkersAiBindingRun }>;
  HOSTED_AI_MODEL: string;
}>;
