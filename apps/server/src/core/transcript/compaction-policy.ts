import { Option, Schema } from "effect";

/** Provider-token trigger and bounded replacement output, both expressed as positive token counts. */
export const ConversationCompactionTokenCount = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ConversationCompactionTokenCount")
);
export type ConversationCompactionTokenCount = typeof ConversationCompactionTokenCount.Type;

/** Production exact-Transcript token threshold that requests Compaction. */
export const defaultCompactionTriggerTokens = 100_000;

/** Production maximum for one generated CompactedConversation replacement. */
export const defaultCompactionMaximumTokens = 15_000;

/** Compaction also precedes the exact-entry capacity of a long, low-token Hosted Agent Session. */
export const compactionEntryTrigger = 80;

/** The last complete terminal Turn in the contiguous retained prefix, never a Pending User entry. */
export const terminalPrefixCursor = (
  entries: ReadonlyArray<
    Readonly<{ sequence: number; status: "pending" | "completed" | "failed" | "interrupted" }>
  >
): Option.Option<number> => {
  const pending = entries.findIndex((entry) => entry.status === "pending");
  return pending === 0
    ? Option.none()
    : Option.fromNullishOr(entries.at(pending < 0 ? -1 : pending - 1)?.sequence);
};

/** Decide when exact retained continuity should be replaced before the next hosted Turn. */
export const shouldCompactConversation = ({
  entryCount,
  tokenCount,
}: Readonly<{ entryCount: number; tokenCount: number }>): boolean =>
  entryCount >= compactionEntryTrigger || tokenCount >= defaultCompactionTriggerTokens;
