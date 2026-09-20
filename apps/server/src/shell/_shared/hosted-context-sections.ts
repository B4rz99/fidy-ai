import { Option } from "effect";
import type { DateTime } from "effect";
import type { User } from "~/core/identity/model";
import type { TranscriptEntry } from "~/core/transcript/model";
import type { HostedContextSection } from "~/shell/hosted-inference/contract";

/** The semantic values one hosted context orders into its canonical section list. */
export type HostedContextSectionInput = Readonly<{
  readonly user: Pick<User, "serviceMarket" | "locale" | "timeZone">;
  readonly startedAt: DateTime.Utc;
  readonly memories: ReadonlyArray<Readonly<{ text: string }>>;
  readonly compactedConversation: Option.Option<Readonly<{ text: string }>>;
  readonly transcript: ReadonlyArray<TranscriptEntry>;
}>;

/**
 * The one canonical order of semantic hosted-context sections, so the live Turn WorkingContext
 * builds and HostedInference's synthetic maximum startup context can never drift apart.
 */
export const hostedContextSections = (
  input: HostedContextSectionInput
): ReadonlyArray<HostedContextSection> => [
  { _tag: "AssistantPolicy", user: input.user },
  { _tag: "TurnStarted", startedAt: input.startedAt },
  { _tag: "ContinuityBoundary", boundary: "open" },
  ...input.memories.map(({ text }) => ({ _tag: "Memory" as const, text })),
  ...Option.match(input.compactedConversation, {
    onNone: () => [],
    onSome: ({ text }) => [{ _tag: "CompactedConversation" as const, text }],
  }),
  ...input.transcript.map((entry) => ({ _tag: "Transcript" as const, entry })),
  { _tag: "ContinuityBoundary", boundary: "close" },
];
