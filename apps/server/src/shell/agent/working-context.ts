import { Brand, Data, Effect, Option } from "effect";
import { type PreparedWorkingContextSnapshot } from "~/shell/transcript/conversation-continuity";
import type { TranscriptEntry } from "~/core/transcript/model";
import { freezeDeep } from "~/shell/_shared/deep-freeze";
import { hostedContextSections } from "~/shell/_shared/hosted-context-sections";
import type { HostedInitialTextContext } from "~/shell/hosted-inference/contract";

/** Fixed, provider-neutral semantic projection; WorkingContext is its only live-Turn constructor. @internal */
type WorkingContextProjection = HostedInitialTextContext;

const makeInitialTextContext = Brand.nominal<HostedInitialTextContext>();

/** Immutable semantic snapshot reused by every hosted round of one admitted Turn. */
export type WorkingContext = WorkingContextProjection &
  Readonly<{
    hostedAgentSessionId: PreparedWorkingContextSnapshot["hostedAgentSessionId"];
    startedAt: PreparedWorkingContextSnapshot["startedAt"];
  }>;

/** Content-free construction failure. */
export class WorkingContextUnavailable extends Data.TaggedError("WorkingContextUnavailable")<{
  readonly reason: "UnknownUser";
}> {}

/** The semantic fields required to project a prepared snapshot through production prompt framing. */
type WorkingContextProjectionInput = Readonly<{
  user: PreparedWorkingContextSnapshot["user"];
  memories: ReadonlyArray<Readonly<{ text: string }>>;
  transcript: ReadonlyArray<TranscriptEntry>;
  compactedConversation: Option.Option<Readonly<{ text: string }>>;
  request: Readonly<{ text: string }>;
  hostedAgentSessionId: PreparedWorkingContextSnapshot["hostedAgentSessionId"];
  startedAt: PreparedWorkingContextSnapshot["startedAt"];
}>;

/** Projects one complete semantic snapshot through the production prompt framing. @internal */
const projectWorkingContext = ({
  user,
  memories,
  transcript,
  compactedConversation,
  request,
  startedAt,
}: WorkingContextProjectionInput): Effect.Effect<
  WorkingContextProjection,
  WorkingContextUnavailable
> =>
  Option.match(user, {
    onNone: () => Effect.fail(new WorkingContextUnavailable({ reason: "UnknownUser" })),
    onSome: (stableUser) =>
      Effect.succeed(
        makeInitialTextContext({
          sections: hostedContextSections({
            user: stableUser,
            startedAt,
            memories,
            compactedConversation,
            transcript,
          }),
          activeRequest: { _tag: "Present", text: request.text },
        })
      ),
  });

const makeWorkingContextFromInput = (
  input: WorkingContextProjectionInput
): Effect.Effect<WorkingContext, WorkingContextUnavailable> =>
  projectWorkingContext(input).pipe(
    Effect.map((projection) =>
      Object.freeze({
        ...freezeDeep(structuredClone(projection)),
        hostedAgentSessionId: input.hostedAgentSessionId,
        startedAt: input.startedAt,
      })
    )
  );

/**
 * The sole live-Turn WorkingContext constructor. It projects one prepared snapshot into an
 * immutable provider-neutral semantic context without retaining persistence state. Whether the
 * preparation is still current is the hosted runtime's decision, checked before this is called.
 */
export const makeWorkingContext = Effect.fn(function* (context: PreparedWorkingContextSnapshot) {
  return yield* makeWorkingContextFromInput(context);
});
