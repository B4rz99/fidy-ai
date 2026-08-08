import type { Response } from "effect/unstable/ai";

/** Builds a complete encoded finish part for deterministic LanguageModel test doubles. */
export const makeLanguageModelFinishPart = (
  reason: Response.FinishReason
): Response.FinishPartEncoded => ({
  type: "finish",
  reason,
  usage: {
    inputTokens: { uncached: 100, total: 150, cacheRead: 50, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  },
  response: undefined,
});
