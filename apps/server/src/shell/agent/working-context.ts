import { Brand, Option } from "effect";
import type { DateTime } from "effect";
import type { User } from "~/core/identity/model";
import type { UserId } from "~/core/identity/reference";
import type { TranscriptEntry, TranscriptTurnId } from "~/core/transcript/model";
import type { HostedAgentSessionId } from "~/core/transcript/reference";
import type { HostedInitialTextContext } from "~/shell/hosted-inference/contract";
import { hostedContextSections } from "~/shell/_shared/hosted-context-sections";

const makeInitialContext = Brand.nominal<HostedInitialTextContext>();

/** Exact retained evidence bound to the session in which it was appended, not merely to a User. */
export type SessionTranscriptEntry = Readonly<{
  sessionId: HostedAgentSessionId;
  userId: UserId;
  sequence: bigint;
  entry: TranscriptEntry;
}>;

/**
 * Builds one immutable model context from already-decoded User-owned projections. The caller must
 * read current Memories and the exact retained entries under the User coordination boundary and
 * must supply the newly admitted request separately: it is not replayed as prior continuity.
 */
export const assembleWorkingContext = ({
  sessionId,
  userId,
  activeTurnId,
  user,
  startedAt,
  memories,
  compactedConversation,
  transcript,
  activeRequest,
}: Readonly<{
  sessionId: HostedAgentSessionId;
  userId: UserId;
  activeTurnId: TranscriptTurnId;
  user: Pick<User, "serviceMarket" | "locale" | "timeZone">;
  startedAt: DateTime.Utc;
  memories: ReadonlyArray<Readonly<{ text: string }>>;
  compactedConversation: Option.Option<
    Readonly<{ sessionId: HostedAgentSessionId; userId: UserId; text: string }>
  >;
  transcript: ReadonlyArray<SessionTranscriptEntry>;
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
      startedAt,
      memories,
      compactedConversation: Option.filter(
        compactedConversation,
        (item) => item.sessionId === sessionId && item.userId === userId
      ),
      transcript: ordered.map(({ entry }) => entry),
    }),
    activeRequest: { _tag: "Present", text: activeRequest },
  });
};
