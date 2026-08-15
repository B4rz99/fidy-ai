import { Data, Effect, Option } from "effect";
import type { Prompt } from "effect/unstable/ai";
import {
  type PreparedAttemptContext,
  type PreparedWorkingContextSnapshot,
} from "~/shell/transcript/conversation-continuity";
import { freezeDeep } from "~/shell/_shared/deep-freeze";
import { exactTranscriptPrompt, systemPrompt, turnPrompt } from "./model-boundary";

/** Fixed, provider-neutral semantic projection owned and ordered by WorkingContext. @internal */
export type WorkingContextProjection = Readonly<{
  prefix: ReadonlyArray<Prompt.MessageEncoded>;
  continuationTail: ReadonlyArray<Prompt.MessageEncoded>;
  suffix: ReadonlyArray<Prompt.MessageEncoded>;
}>;

/** Immutable semantic context reused by every hosted round of one admitted Turn. */
export type WorkingContext = WorkingContextProjection &
  Readonly<{ startedAt: PreparedWorkingContextSnapshot["startedAt"] }>;

/** Content-free construction failure. */
export class WorkingContextUnavailable extends Data.TaggedError("WorkingContextUnavailable")<{
  readonly reason: "InvalidAuthority" | "UnknownUser";
}> {}

const untrustedText = (kind: string, value: unknown): string =>
  `[UNTRUSTED_${kind.toUpperCase()}]\n${String(value)}\n[/UNTRUSTED_${kind.toUpperCase()}]`;

const quotedUserContext = (kind: string, value: unknown): Prompt.UserMessageEncoded => ({
  role: "user",
  content: untrustedText(kind, value),
});

const activeRequestContext = (value: unknown): Prompt.UserMessageEncoded => ({
  role: "user",
  content: untrustedText("active_request", value),
});

const maximumToolResultCharacters = 32_000;

const transcriptProjection = (
  entries: PreparedWorkingContextSnapshot["transcript"]
): ReadonlyArray<Prompt.MessageEncoded> =>
  exactTranscriptPrompt(
    entries.map((entry) => {
      if (
        entry._tag !== "CanonicalToolResultEntry" ||
        JSON.stringify(entry.outcome).length <= maximumToolResultCharacters
      ) {
        return entry;
      }
      return {
        ...entry,
        outcome: {
          _tag: "ToolOutputRejected" as const,
          failure: {
            code: "tool_result_too_large",
            message: "The canonical result exceeded the model-context safety limit.",
          },
        },
      };
    })
  ).map((message) => {
    if (typeof message.content !== "string") return message;
    if (message.role === "user") {
      return { ...message, content: untrustedText("transcript_user", message.content) };
    }
    if (message.role === "assistant") {
      return { ...message, content: untrustedText("transcript_assistant", message.content) };
    }
    return message;
  });

const projectSnapshot = ({
  user,
  memories,
  transcript,
  compactedConversation,
  request,
  startedAt,
}: PreparedWorkingContextSnapshot): Effect.Effect<
  WorkingContextProjection,
  WorkingContextUnavailable
> =>
  Option.match(user, {
    onNone: () => Effect.fail(new WorkingContextUnavailable({ reason: "UnknownUser" })),
    onSome: (stableUser) =>
      Effect.succeed({
        prefix: [
          { role: "system", content: systemPrompt(stableUser) },
          { role: "system", content: turnPrompt(startedAt) },
          ...memories.map((memory) => quotedUserContext("memory", memory.text)),
          ...Option.match(compactedConversation, {
            onNone: () => [],
            onSome: ({ text }) => [quotedUserContext("compacted_conversation", text)],
          }),
          ...transcriptProjection(transcript),
          activeRequestContext(request.text),
        ],
        continuationTail: [],
        suffix: [],
      }),
  });

/**
 * The sole WorkingContext constructor. It projects an active prepared snapshot into immutable,
 * provider-neutral semantic context without retaining persistence state.
 */
export const makeWorkingContext = Effect.fn("WorkingContext.make")(function* (
  context: PreparedAttemptContext
) {
  if (!context.isActive()) {
    return yield* new WorkingContextUnavailable({ reason: "InvalidAuthority" });
  }
  const projection = freezeDeep(structuredClone(yield* projectSnapshot(context)));
  return Object.freeze({ ...projection, startedAt: context.startedAt });
});
