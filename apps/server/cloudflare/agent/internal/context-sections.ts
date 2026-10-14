import { type DateTime, Option } from "effect";

import type { User } from "../../../src/core/identity/contract";
import type { TranscriptEntry } from "../../../src/core/agent/contract";
import type { HostedContextSection } from "../../../src/shell/hosted-inference/contract";

import type { ProactiveReplyContext } from "../contract";

export type HostedContextSectionInput = Readonly<{
  readonly user: Pick<User, "serviceMarket" | "locale" | "timeZone">;
  readonly startedAt: DateTime.Utc;
  readonly memories: ReadonlyArray<Readonly<{ text: string }>>;
  readonly compactedConversation: Option.Option<Readonly<{ text: string }>>;
  readonly transcript: ReadonlyArray<TranscriptEntry>;
  readonly proactiveReply: Option.Option<ProactiveReplyContext>;
}>;

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
  ...Option.match(input.proactiveReply, {
    onNone: () => [],
    onSome: ({ entry }) => [{ _tag: "ProactiveReply" as const, entry }],
  }),
  { _tag: "ContinuityBoundary", boundary: "close" },
];
