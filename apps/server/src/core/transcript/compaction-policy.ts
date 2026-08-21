import { Schema } from "effect";

/** Provider-token trigger and bounded replacement output, both expressed as positive token counts. */
export const ConversationCompactionTokenCount = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ConversationCompactionTokenCount")
);
export type ConversationCompactionTokenCount = typeof ConversationCompactionTokenCount.Type;

/** Production exact-Transcript token threshold that requests Compaction. */
export const defaultCompactionTriggerTokens = 100_000;

/** Production maximum for one generated CompactedConversation replacement. */
export const defaultCompactionMaximumTokens = 15_000;
