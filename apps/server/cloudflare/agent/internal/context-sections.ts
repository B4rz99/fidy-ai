import { Data, type DateTime, Option } from "effect";

import type { User } from "../../../src/core/identity/contract";
import type { TranscriptEntry } from "../../../src/core/agent/contract";
import type {
  HostedContextSection,
  HostedConversationChannel,
} from "../../../src/shell/hosted-inference/contract";

import type { ProactiveReplyContext } from "../contract";

export type HostedContextSectionInput = Readonly<{
  readonly user: Pick<User, "serviceMarket" | "locale" | "timeZone">;
  readonly channel: HostedConversationChannel;
  readonly startedAt: DateTime.Utc;
  readonly memories: ReadonlyArray<Readonly<{ text: string }>>;
  readonly compactedConversation: Option.Option<Readonly<{ text: string }>>;
  readonly transcript: ReadonlyArray<TranscriptEntry>;
  readonly proactiveReply: Option.Option<ProactiveReplyContext>;
}>;

const Section = Data.taggedEnum<HostedContextSection>();

export const hostedContextSections = (
  input: HostedContextSectionInput
): ReadonlyArray<HostedContextSection> => [
  Section.AssistantPolicy({ user: input.user, channel: input.channel }),
  Section.TurnStarted({ startedAt: input.startedAt, timeZone: input.user.timeZone }),
  Section.ContinuityBoundary({ boundary: "open" }),
  ...input.memories.map(({ text }) => Section.Memory({ text })),
  ...Option.match(input.compactedConversation, {
    onNone: () => [],
    onSome: ({ text }) => [Section.CompactedConversation({ text })],
  }),
  ...input.transcript.map((entry) => Section.Transcript({ entry })),
  ...Option.match(input.proactiveReply, {
    onNone: () => [],
    onSome: ({ entry }) => [Section.ProactiveReply({ entry })],
  }),
  Section.ContinuityBoundary({ boundary: "close" }),
];
