import {
  Array as Arr,
  type Data,
  Effect,
  Match,
  Option,
  Predicate,
  Schema,
  type Types,
} from "effect";
import {
  type AssistantTranscriptEntry,
  type CanonicalToolCallEntry,
  type CanonicalToolOutcome,
  type CanonicalToolResultEntry,
  type FailedTurnTranscriptEntry,
  type InterruptedTurnTranscriptEntry,
  type UserTranscriptEntry,
} from "~/core/agent/contract";

type DeepReadonly<Value> =
  Value extends ReadonlyArray<infer Element>
    ? ReadonlyArray<DeepReadonly<Element>>
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

type ReadonlyJson = DeepReadonly<Schema.Json>;

type WindowTextEntry =
  | Pick<typeof UserTranscriptEntry.Encoded, "_tag" | "turnId" | "text">
  | Pick<typeof AssistantTranscriptEntry.Encoded, "_tag" | "turnId" | "text">;

type SucceededOutcome = Types.ExtractTag<CanonicalToolOutcome, "Succeeded">;

type CommittedOutcome = Types.ExtractTag<CanonicalToolOutcome, "CommittedOutputUnavailable">;

type FailedOutcome = Exclude<CanonicalToolOutcome, SucceededOutcome | CommittedOutcome>;

type WindowOutcome = Data.TaggedEnum<
  {
    readonly Succeeded: { readonly output: ReadonlyJson };
    readonly CommittedOutputUnavailable: {};
  } & { readonly [Tag in FailedOutcome["_tag"]]: { readonly failure: ReadonlyJson } }
>;

type WindowCallEntry = Pick<
  typeof CanonicalToolCallEntry.Encoded,
  "_tag" | "turnId" | "toolCallId" | "operation"
> & {
  readonly input: ReadonlyJson;
};

type WindowResultEntry = Pick<
  typeof CanonicalToolResultEntry.Encoded,
  "_tag" | "turnId" | "toolCallId" | "operation"
> & {
  readonly outcome: WindowOutcome;
};

export type TranscriptWindowEntry = WindowTextEntry | WindowCallEntry | WindowResultEntry;

type LifecycleWindowEntry =
  | Pick<typeof FailedTurnTranscriptEntry.Encoded, "_tag" | "turnId">
  | Pick<typeof InterruptedTurnTranscriptEntry.Encoded, "_tag" | "turnId">;

export type TranscriptSelectionEntry = TranscriptWindowEntry | LifecycleWindowEntry;

export const isTranscriptWindowEntry = (
  entry: TranscriptSelectionEntry
): entry is TranscriptWindowEntry =>
  !Predicate.isTagged(entry, "FailedTurnTranscriptEntry") &&
  !Predicate.isTagged(entry, "InterruptedTurnTranscriptEntry");

export const TranscriptWindowTurnLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 })
)
  .pipe(Schema.brand("TranscriptWindowTurnLimit"))
  .annotate({ identifier: "TranscriptWindowTurnLimit" });

export type TranscriptWindowTurnLimit = typeof TranscriptWindowTurnLimit.Type;

export const TranscriptWindowCharacterLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 200_000 })
)
  .pipe(Schema.brand("TranscriptWindowCharacterLimit"))
  .annotate({ identifier: "TranscriptWindowCharacterLimit" });

export type TranscriptWindowCharacterLimit = typeof TranscriptWindowCharacterLimit.Type;

const outcomeEvidence = Match.type<WindowOutcome>().pipe(
  Match.tag("Succeeded", (outcome): ReadonlyJson => outcome.output),
  Match.tag("CommittedOutputUnavailable", (outcome): ReadonlyJson => outcome),
  Match.orElse((outcome): ReadonlyJson => outcome.failure)
);

const entryCharacters = (entry: TranscriptWindowEntry): number =>
  Match.value(entry).pipe(
    Match.tagsExhaustive({
      UserTranscriptEntry: (user) => user.text.length,
      AssistantTranscriptEntry: (assistant) => assistant.text.length,
      CanonicalToolCallEntry: (call) => JSON.stringify(call.input).length,
      CanonicalToolResultEntry: (result) => JSON.stringify(outcomeEvidence(result.outcome)).length,
    })
  );

type NonEmptyTurn = [TranscriptWindowEntry, ...Array<TranscriptWindowEntry>];

const groupTurns = (entries: ReadonlyArray<TranscriptWindowEntry>): ReadonlyArray<NonEmptyTurn> => {
  const turns: Array<NonEmptyTurn> = [];

  for (const entry of entries) {
    const current = turns.at(-1);

    if (current !== undefined && current[0].turnId === entry.turnId) current.push(entry);
    else turns.push([entry]);
  }

  return turns;
};

type WindowTurn = Arr.NonEmptyReadonlyArray<TranscriptWindowEntry>;

type WindowUserEntry = Types.ExtractTag<WindowTextEntry, "UserTranscriptEntry">;

type WindowCallEntryValue = Types.ExtractTag<TranscriptWindowEntry, "CanonicalToolCallEntry">;

type WindowResultEntryValue = Types.ExtractTag<TranscriptWindowEntry, "CanonicalToolResultEntry">;

const activeTurnUser = (
  turn: WindowTurn,
  maxCharacters: TranscriptWindowCharacterLimit
): Option.Option<WindowUserEntry> => {
  const lastEntry = Arr.lastNonEmpty(turn);

  return Option.some(Arr.headNonEmpty(turn)).pipe(
    Option.filter((entry): entry is WindowUserEntry =>
      Predicate.isTagged(entry, "UserTranscriptEntry")
    ),
    Option.filter((user) => entryCharacters(user) <= maxCharacters),
    Option.filter(() => !Predicate.isTagged(lastEntry, "AssistantTranscriptEntry"))
  );
};

const matchingTrailingCall = (
  previous: Option.Option<TranscriptWindowEntry>,
  result: WindowResultEntryValue
): Option.Option<WindowCallEntryValue> =>
  previous.pipe(
    Option.filter((entry): entry is WindowCallEntryValue =>
      Predicate.isTagged(entry, "CanonicalToolCallEntry")
    ),
    Option.filter((call) => call.toolCallId === result.toolCallId)
  );

const trailingTurnUnit = (
  entry: TranscriptWindowEntry,
  previous: Option.Option<TranscriptWindowEntry>
): ReadonlyArray<TranscriptWindowEntry> =>
  Match.value(entry).pipe(
    Match.tag("CanonicalToolResultEntry", (result): ReadonlyArray<TranscriptWindowEntry> =>
      matchingTrailingCall(previous, result).pipe(
        Option.match({
          onNone: () => [result],
          onSome: (call) => [call, result],
        })
      )
    ),
    Match.orElse((other): ReadonlyArray<TranscriptWindowEntry> => [other])
  );

const pairedWithFollowingResult = (turn: WindowTurn, index: number): boolean =>
  Option.fromUndefinedOr(turn[index + 1]).pipe(
    Option.exists(
      (following) => trailingTurnUnit(following, Option.fromUndefinedOr(turn[index])).length > 1
    )
  );

type ActiveTurnSuffix = {
  suffix: Array<TranscriptWindowEntry>;
  characters: number;
  stopped: boolean;
};

type NewestTrailingEntry = Readonly<{ entry: TranscriptWindowEntry; index: number }>;

const boundedActiveTurn = (
  turn: WindowTurn,
  maxCharacters: TranscriptWindowCharacterLimit
): ReadonlyArray<TranscriptWindowEntry> => {
  const user = activeTurnUser(turn, maxCharacters);

  if (Option.isNone(user)) return [];

  const state: ActiveTurnSuffix = {
    suffix: [],
    characters: entryCharacters(user.value),
    stopped: false,
  };

  const [, ...trailing] = turn;
  const newestFirst = trailing.map((entry, offset) => ({ entry, index: offset + 1 })).toReversed();
  newestFirst.forEach(({ entry, index }: NewestTrailingEntry) => {
    if (state.stopped) return;

    if (pairedWithFollowingResult(turn, index)) return;
    const unit = trailingTurnUnit(entry, Option.fromUndefinedOr(turn[index - 1]));
    const unitCharacters = unit.reduce((total, member) => total + entryCharacters(member), 0);

    if (state.characters + unitCharacters > maxCharacters) {
      state.stopped = true;

      return;
    }

    state.suffix.unshift(...unit);
    state.characters += unitCharacters;
  });

  return [user.value, ...state.suffix];
};

type TurnSelection = Readonly<{
  remaining: ReadonlyArray<WindowTurn>;
  selected: ReadonlyArray<ReadonlyArray<TranscriptWindowEntry>>;
  characters: number;
}>;

const exceedsWindow = ({
  selectedTurns,
  characters,
  turnCharacters,
  maxTurns,
  maxCharacters,
}: Readonly<{
  selectedTurns: number;
  characters: number;
  turnCharacters: number;
  maxTurns: TranscriptWindowTurnLimit;
  maxCharacters: TranscriptWindowCharacterLimit;
}>): boolean => selectedTurns >= maxTurns || characters + turnCharacters > maxCharacters;

const finishOverflow = (
  selected: ReadonlyArray<ReadonlyArray<TranscriptWindowEntry>>,
  turn: WindowTurn,
  maxCharacters: TranscriptWindowCharacterLimit
): ReadonlyArray<TranscriptWindowEntry> =>
  selected.length === 0 ? boundedActiveTurn(turn, maxCharacters) : selected.flat();

const continueNewestTurns = (
  state: TurnSelection,
  maxTurns: TranscriptWindowTurnLimit,
  maxCharacters: TranscriptWindowCharacterLimit
): ReadonlyArray<TranscriptWindowEntry> => {
  const turn = state.remaining[0];

  if (turn === undefined) return state.selected.flat();
  const turnCharacters = turn.reduce((total, entry) => total + entryCharacters(entry), 0);

  return exceedsWindow({
    selectedTurns: state.selected.length,
    characters: state.characters,
    turnCharacters,
    maxTurns,
    maxCharacters,
  })
    ? finishOverflow(state.selected, turn, maxCharacters)
    : continueNewestTurns(
        {
          remaining: state.remaining.slice(1),
          selected: [turn, ...state.selected],
          characters: state.characters + turnCharacters,
        },
        maxTurns,
        maxCharacters
      );
};

const newestTurnsWithin = (
  turns: ReadonlyArray<WindowTurn>,
  maxTurns: TranscriptWindowTurnLimit,
  maxCharacters: TranscriptWindowCharacterLimit
): ReadonlyArray<TranscriptWindowEntry> =>
  continueNewestTurns(
    { remaining: turns.toReversed(), selected: [], characters: 0 },
    maxTurns,
    maxCharacters
  );

export const selectTranscriptWindow = Effect.fn("selectTranscriptWindow")(
  (
    entries: ReadonlyArray<TranscriptSelectionEntry>,
    maxTurns: TranscriptWindowTurnLimit,
    maxCharacters: TranscriptWindowCharacterLimit
  ) =>
    Effect.succeed(
      newestTurnsWithin(
        groupTurns(entries.filter(isTranscriptWindowEntry)),
        maxTurns,
        maxCharacters
      )
    )
);
