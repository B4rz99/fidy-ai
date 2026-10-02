import { Data } from "effect";
import type { WorkersAiBindingRun } from "../../src/shell/hosted-inference/contract";

/** Core bindings required to construct hosted inference without any external-model route. */
export type WorkersAiEnvironment = Readonly<{
  AI: Readonly<{ run: WorkersAiBindingRun }>;
  HOSTED_AI_MODEL: string;
}>;

/** Workers AI admission retention failed without exposing database or inference evidence. */
export class WorkersAiAdmissionUnavailable extends Data.TaggedError(
  "WorkersAiAdmissionUnavailable"
) {}
