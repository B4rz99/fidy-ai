import { Data, Effect, Function as Fn, Option } from "effect";
import type { Prompt } from "effect/unstable/ai";
import {
  type PreparedAttemptContext,
  type PreparedWorkingContextSnapshot,
  claimPreparedAttemptContext,
} from "~/shell/transcript/conversation-continuity";
import { freezeDeep } from "~/shell/_shared/deep-freeze";
import { exactTranscriptPrompt, systemPrompt, turnPrompt } from "./model-boundary";

/** Opaque immutable semantic snapshot reused by every hosted round of one admitted Turn. */
export type WorkingContext = Readonly<{ startedAt: PreparedWorkingContextSnapshot["startedAt"] }>;

/** Fixed, provider-neutral projection claimable once by one HostedInference adapter. @internal */
type WorkingContextProjection = Readonly<{
  prefix: ReadonlyArray<Prompt.MessageEncoded>;
  continuationTail: ReadonlyArray<Prompt.MessageEncoded>;
  suffix: ReadonlyArray<Prompt.MessageEncoded>;
}>;

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

type WorkingContextAuthority = WorkingContext &
  Readonly<{ claim: () => Option.Option<WorkingContextProjection> }>;

const workingContextAuthorityPrototype: object = Object.freeze({});

const workingContextAuthority = (
  startedAt: PreparedWorkingContextSnapshot["startedAt"],
  claim: () => Option.Option<WorkingContextProjection>
): WorkingContext => {
  const authority = Fn.cast<object, WorkingContextAuthority>({});
  Object.setPrototypeOf(authority, workingContextAuthorityPrototype);
  Object.defineProperties(authority, {
    startedAt: { enumerable: true, value: startedAt },
    claim: { enumerable: false, value: claim },
  });
  return Object.freeze(authority);
};

/** Consumes an authentic WorkingContext once; structural lookalikes are rejected. @internal */
export const claimWorkingContext = (
  context: WorkingContext
): Option.Option<WorkingContextProjection> =>
  Object.getPrototypeOf(context) === workingContextAuthorityPrototype
    ? Fn.cast<WorkingContext, WorkingContextAuthority>(context).claim()
    : Option.none();

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
 * The sole WorkingContext constructor. It consumes exactly one PreparedAttempt.context and stores
 * no reconstructible User, request, revision, scope, or prose on the returned authority.
 */
export const makeWorkingContext = Effect.fn("WorkingContext.make")(function* (
  context: PreparedAttemptContext
) {
  const source = claimPreparedAttemptContext(context);
  if (Option.isNone(source)) {
    return yield* new WorkingContextUnavailable({ reason: "InvalidAuthority" });
  }
  const projection = yield* projectSnapshot(source.value);
  const isolated = freezeDeep(structuredClone(projection));
  let available = true;
  return workingContextAuthority(source.value.startedAt, () => {
    if (!available) return Option.none();
    available = false;
    return Option.some(isolated);
  });
});
