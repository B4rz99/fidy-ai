import type { Effect } from "effect";
import type { OutboundHttp } from "~/shell/outbound-http/operations";
import { verifyMistralTokenConformance as verifyInternal } from "~/shell/hosted-inference/internal/mistral-conformance";
import type {
  MistralConformanceError,
  MistralConformanceReport,
} from "./mistral-conformance-contract";

export type {
  MistralConformanceCaseId,
  MistralConformanceFailureReason,
  MistralConformanceReport,
} from "./mistral-conformance-contract";
export { MistralConformanceError } from "./mistral-conformance-contract";

/**
 * Explicit operational entrypoint for the pinned Mistral tokenizer conformance probe. This is the
 * published seam for the probe implementation: scripts and other modules cannot import the
 * `internal/` module, so callers acquire the workflow and its safe contract here.
 */
export const verifyMistralTokenConformance: Effect.Effect<
  ReadonlyArray<MistralConformanceReport>,
  MistralConformanceError,
  OutboundHttp
> = verifyInternal;
