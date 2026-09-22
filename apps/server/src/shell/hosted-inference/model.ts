import { Schema } from "effect";

const approvedWorkersAiModelId = "@cf/openai/gpt-oss-120b" as const;

/** The Workers AI model whose exact revision has passed Fidy's conformance suite. */
export const ApprovedWorkersAiModel = Schema.Literal(approvedWorkersAiModelId).pipe(
  Schema.brand("ApprovedWorkersAiModel")
);
export type ApprovedWorkersAiModel = typeof ApprovedWorkersAiModel.Type;

/** Production model selection; changing this value requires passing conformance again. */
export const approvedWorkersAiModel = ApprovedWorkersAiModel.make(approvedWorkersAiModelId);
