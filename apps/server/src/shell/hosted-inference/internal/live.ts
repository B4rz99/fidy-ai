import { openAiHostedInference } from "./openai";

/**
 * Primary provider-private HostedInference construction, exposed so the published
 * `operations.ts` layer never imports provider internals directly (ADR 0014; see the
 * `hosted-inference-orchestration-imports-provider` dependency rule). @internal
 */
export const makeHostedInferenceLive = openAiHostedInference;
