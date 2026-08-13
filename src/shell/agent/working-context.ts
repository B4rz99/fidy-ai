import { Data, Effect, Option } from "effect";
import type { Prompt } from "effect/unstable/ai";
import {
  type TranscriptWindowCharacterLimit,
  TranscriptWindowTurnLimit,
  isTranscriptWindowEntry,
  selectTranscriptWindow,
} from "~/core/transcript/rules";
import {
  type PreparedAttemptContext,
  type PreparedWorkingContextSnapshot,
  claimPreparedAttemptContext,
} from "~/shell/transcript/conversation-continuity";
import {
  projectTranscriptForModel,
  systemPrompt,
  transcriptPrompt,
  turnPrompt,
} from "./model-boundary";

const workingContextNominal = Symbol("WorkingContext");

/** Opaque immutable semantic snapshot reused by every hosted round of one admitted Turn. */
export type WorkingContext = Readonly<{ [workingContextNominal]: true }>;

/** Fixed, provider-neutral projection claimable once by one HostedInference adapter. @internal */
export type WorkingContextProjection = Readonly<{
  prefix: ReadonlyArray<Prompt.MessageEncoded>;
}>;

/** Content-free construction failure. */
export class WorkingContextUnavailable extends Data.TaggedError("WorkingContextUnavailable")<{
  readonly reason: "InvalidAuthority" | "UnknownUser";
}> {}

const projections = new WeakMap<object, WorkingContextProjection>();

const freezeDeep: <A>(value: A) => A = (value) => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
};

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

type ProjectedTranscriptEntry = Parameters<typeof transcriptPrompt>[0][number];

const isMatchingActiveRequest = (entry: ProjectedTranscriptEntry, activeRequest: string): boolean =>
  entry._tag === "UserTranscriptEntry" && entry.text === activeRequest;

const isConfirmationRequest = (entry: ProjectedTranscriptEntry): boolean =>
  entry._tag === "UserTranscriptEntry" && entry.text.startsWith("CONFIRMAR ");

const isSupersededActiveRequest = (
  entry: ProjectedTranscriptEntry,
  activeRequest: string
): boolean =>
  [isMatchingActiveRequest(entry, activeRequest), isConfirmationRequest(entry)].includes(true);

const isConsumedAtomicBatchEvidence = (entry: ProjectedTranscriptEntry): boolean =>
  (entry._tag === "CanonicalToolCallEntry" || entry._tag === "CanonicalToolResultEntry") &&
  entry.operation === "operations.executeAtomicBatch";

const projectTranscriptEntry = (
  entry: ProjectedTranscriptEntry
): ReadonlyArray<Prompt.MessageEncoded> => {
  if (entry._tag === "UserTranscriptEntry") {
    return [{ role: "user", content: untrustedText("transcript_user", entry.text) }];
  }
  if (entry._tag === "AssistantTranscriptEntry") {
    return [{ role: "assistant", content: untrustedText("transcript_assistant", entry.text) }];
  }
  return transcriptPrompt([entry]);
};

const transcriptProjection = (
  entries: ReadonlyArray<ProjectedTranscriptEntry>,
  activeRequest: string
): ReadonlyArray<Prompt.MessageEncoded> =>
  entries
    .filter(
      (entry) =>
        !isSupersededActiveRequest(entry, activeRequest) && !isConsumedAtomicBatchEvidence(entry)
    )
    .flatMap(projectTranscriptEntry);

const projectSnapshot = (
  { user, memories, transcript, request, startedAt }: PreparedWorkingContextSnapshot,
  limits: Readonly<{
    maxTranscriptTurns: TranscriptWindowTurnLimit;
    maxTranscriptCharacters: TranscriptWindowCharacterLimit;
    maxToolResultCharacters: number;
  }>
): Effect.Effect<WorkingContextProjection, WorkingContextUnavailable> =>
  Option.match(user, {
    onNone: () => Effect.fail(new WorkingContextUnavailable({ reason: "UnknownUser" })),
    onSome: (stableUser) => {
      const windowEntries = transcript.filter(isTranscriptWindowEntry);
      const bounded =
        limits.maxTranscriptTurns === 1
          ? Effect.succeed([])
          : selectTranscriptWindow(
              windowEntries,
              TranscriptWindowTurnLimit.make(limits.maxTranscriptTurns - 1),
              limits.maxTranscriptCharacters
            );
      return Effect.map(bounded, (boundedTranscript) => ({
        prefix: [
          { role: "system", content: systemPrompt(stableUser) },
          { role: "system", content: turnPrompt(startedAt) },
          ...memories.map((memory) => quotedUserContext("memory", memory.text)),
          // CompactedConversation is intentionally absent until #206 supplies the optional value.
          ...transcriptProjection(
            projectTranscriptForModel(boundedTranscript, limits.maxToolResultCharacters),
            request.text
          ),
          activeRequestContext(request.text),
        ],
      }));
    },
  });

/**
 * The sole WorkingContext constructor. It consumes exactly one PreparedAttempt.context and stores
 * no reconstructible User, request, revision, scope, or prose on the returned authority.
 */
export const makeWorkingContext = Effect.fn("WorkingContext.make")(function* (
  context: PreparedAttemptContext,
  limits: Readonly<{
    maxTranscriptTurns: TranscriptWindowTurnLimit;
    maxTranscriptCharacters: TranscriptWindowCharacterLimit;
    maxToolResultCharacters: number;
  }>
) {
  const source = claimPreparedAttemptContext(context);
  if (Option.isNone(source)) {
    return yield* new WorkingContextUnavailable({ reason: "InvalidAuthority" });
  }
  const projection = yield* projectSnapshot(source.value, limits);
  const authority: WorkingContext = Object.freeze({ [workingContextNominal]: true });
  projections.set(authority, freezeDeep(structuredClone(projection)));
  return authority;
});

/** Claims the one adapter-local projection authority. A second or foreign claim returns None. @internal */
export const claimWorkingContextProjection = (
  context: object
): Option.Option<WorkingContextProjection> => {
  const projection = projections.get(context);
  if (projection === undefined) return Option.none();
  projections.delete(context);
  return Option.some(projection);
};
