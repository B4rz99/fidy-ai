import { Data } from "effect";

/** Identifier of one pinned Mistral conformance probe. */
export type MistralConformanceCaseId =
  | "baseline"
  | "small-schema"
  | "large-schema"
  | "production-compaction";

/** Safe closed reasons emitted by the manual conformance workflow. */
export type MistralConformanceFailureReason =
  | "provider_failed"
  | "provider_response_invalid"
  | "provider_model_mismatch"
  | "prompt_count_mismatch";

/** Content-free failure from the manual Mistral conformance workflow. */
export class MistralConformanceError extends Data.TaggedError("MistralConformanceError")<{
  readonly reason: MistralConformanceFailureReason;
  readonly caseId: MistralConformanceCaseId;
}> {}

/** Safe numeric evidence from one hosted accounting probe. */
export type MistralConformanceReport = Readonly<{
  id: MistralConformanceCaseId;
  localPromptTokens: number;
  hostedPromptTokens: number;
  outputReserve: number;
  completeRequestTokens: number;
}>;
