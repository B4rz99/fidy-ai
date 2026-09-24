/** Provider-neutral hosted inference authority and direct Workers AI adapter seam. */
export {
  verifyHostedInferenceConformance,
  verifyHostedInferenceConformanceChecks,
} from "./conformance";
export { ApprovedWorkersAiModel, approvedWorkersAiModel } from "./model";
export { makeWorkersAiHostedInference } from "./workers-ai";
export type { WorkersAiBindingRun, WorkersAiRequest } from "./workers-ai";
export { HostedInferenceError, HostedToolCallMaximum } from "./contract";
export type {
  HostedInferenceService,
  HostedInitialTextContext,
  HostedStructuredRequest,
  HostedTextRequest,
} from "./contract";
export { HostedInference } from "./operations";
