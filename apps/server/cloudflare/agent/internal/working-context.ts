import {
  type HostedAgentSessionId,
  type TranscriptEntry,
  type TranscriptTurnId,
} from "../../../src/core/agent/contract";
import { Brand, Data, type DateTime, Option } from "effect";
import { type User, type UserId } from "../../../src/core/identity/contract";

import type {
  HostedConversationChannel,
  HostedInitialTextContext,
} from "../../../src/shell/hosted-inference/contract";
import { hostedContextSections } from "./context-sections";
import type { ProactiveReplyContext } from "../contract";

const makeInitialContext = Brand.nominal<HostedInitialTextContext>();

export type SessionTranscriptEntry = Readonly<{
  sessionId: HostedAgentSessionId;
  userId: UserId;
  sequence: bigint;
  entry: TranscriptEntry;
}>;

const ActiveRequest = Data.taggedEnum<HostedInitialTextContext["activeRequest"]>();

export const assembleWorkingContext = ({
  sessionId,
  userId,
  activeTurnId,
  user,
  channel,
  startedAt,
  memories,
  compactedConversation,
  transcript,
  proactiveReply,
  activeRequest,
}: Readonly<{
  sessionId: HostedAgentSessionId;
  userId: UserId;
  activeTurnId: TranscriptTurnId;
  user: Pick<User, "serviceMarket" | "locale" | "timeZone">;
  channel: HostedConversationChannel;
  startedAt: DateTime.Utc;
  memories: ReadonlyArray<Readonly<{ text: string }>>;
  compactedConversation: Option.Option<
    Readonly<{ sessionId: HostedAgentSessionId; userId: UserId; text: string }>
  >;
  transcript: ReadonlyArray<SessionTranscriptEntry>;
  proactiveReply: Option.Option<ProactiveReplyContext>;
  activeRequest: string;
}>): HostedInitialTextContext => {
  const ordered = transcript
    .filter(
      (item) =>
        item.sessionId === sessionId && item.userId === userId && item.entry.turnId !== activeTurnId
    )
    .toSorted((left, right) => {
      if (left.sequence < right.sequence) return -1;

      if (left.sequence > right.sequence) return 1;

      return 0;
    });

  return makeInitialContext({
    sections: hostedContextSections({
      user,
      channel,
      startedAt,
      memories,
      compactedConversation: Option.filter(
        compactedConversation,
        (item) => item.sessionId === sessionId && item.userId === userId
      ),
      transcript: ordered.map(({ entry }) => entry),
      proactiveReply: Option.filter(proactiveReply, (item) => item.userId === userId),
    }),
    activeRequest: ActiveRequest.Present({ text: activeRequest }),
  });
};
