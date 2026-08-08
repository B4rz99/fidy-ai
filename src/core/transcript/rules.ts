import { Effect, Option, Schema } from "effect";
import {
  type AssistantTranscriptEntry,
  type CanonicalToolCallEntry,
  type CanonicalToolOutcome,
  type CanonicalToolResultEntry,
  type UserTranscriptEntry,
} from "./model";

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
type SucceededOutcome = Extract<CanonicalToolOutcome, { readonly _tag: "Succeeded" }>;
type FailedOutcome = Exclude<CanonicalToolOutcome, SucceededOutcome>;
type WindowOutcome =
  | { readonly _tag: SucceededOutcome["_tag"]; readonly output: ReadonlyJson }
  | { readonly _tag: FailedOutcome["_tag"]; readonly failure: ReadonlyJson };
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

/** Canonical Transcript fields considered for complete-turn model context selection. */
export type TranscriptWindowEntry = WindowTextEntry | WindowCallEntry | WindowResultEntry;

/** Positive whole-turn bound for model-context selection. */
export const TranscriptWindowTurnLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 })
)
  .pipe(Schema.brand("TranscriptWindowTurnLimit"))
  .annotate({ identifier: "TranscriptWindowTurnLimit" });
export type TranscriptWindowTurnLimit = typeof TranscriptWindowTurnLimit.Type;

/** Positive character bound for model-context selection. */
export const TranscriptWindowCharacterLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 200_000 })
)
  .pipe(Schema.brand("TranscriptWindowCharacterLimit"))
  .annotate({ identifier: "TranscriptWindowCharacterLimit" });
export type TranscriptWindowCharacterLimit = typeof TranscriptWindowCharacterLimit.Type;

const entryCharacters = (entry: TranscriptWindowEntry): number => {
  switch (entry._tag) {
    case "UserTranscriptEntry":
    case "AssistantTranscriptEntry":
      return entry.text.length;
    case "CanonicalToolCallEntry":
      return JSON.stringify(entry.input).length;
    case "CanonicalToolResultEntry":
      return JSON.stringify(
        entry.outcome._tag === "Succeeded" ? entry.outcome.output : entry.outcome.failure
      ).length;
  }
};

type NonEmptyTurn = [TranscriptWindowEntry, ...Array<TranscriptWindowEntry>];

const groupTurns = (
  entries: ReadonlyArray<TranscriptWindowEntry>
): ReadonlyArray<ReadonlyArray<TranscriptWindowEntry>> => {
  const turns: Array<NonEmptyTurn> = [];
  for (const entry of entries) {
    const current = turns.at(-1);
    if (current !== undefined && current[0].turnId === entry.turnId) current.push(entry);
    else turns.push([entry]);
  }
  return turns;
};

type WindowUserEntry = Extract<WindowTextEntry, { readonly _tag: "UserTranscriptEntry" }>;
type WindowCallEntryValue = Extract<
  TranscriptWindowEntry,
  { readonly _tag: "CanonicalToolCallEntry" }
>;
type WindowResultEntryValue = Extract<
  TranscriptWindowEntry,
  { readonly _tag: "CanonicalToolResultEntry" }
>;

const activeTurnUser = (
  turn: ReadonlyArray<TranscriptWindowEntry>,
  maxCharacters: TranscriptWindowCharacterLimit
): Option.Option<WindowUserEntry> => {
  const lastEntry = Option.getOrThrow(Option.fromUndefinedOr(turn.at(-1)));
  return Option.fromUndefinedOr(turn[0]).pipe(
    Option.filter((entry): entry is WindowUserEntry => entry._tag === "UserTranscriptEntry"),
    Option.filter((user) => entryCharacters(user) <= maxCharacters),
    Option.filter(() => lastEntry._tag !== "AssistantTranscriptEntry")
  );
};

const matchingTrailingCall = (
  previous: Option.Option<TranscriptWindowEntry>,
  result: WindowResultEntryValue
): Option.Option<WindowCallEntryValue> =>
  previous.pipe(
    Option.filter(
      (entry): entry is WindowCallEntryValue => entry._tag === "CanonicalToolCallEntry"
    ),
    Option.filter((call) => call.toolCallId === result.toolCallId)
  );

const trailingTurnUnit = (
  turn: ReadonlyArray<TranscriptWindowEntry>,
  index: number
): ReadonlyArray<TranscriptWindowEntry> => {
  const entry = Option.getOrThrow(Option.fromUndefinedOr(turn[index]));
  return entry._tag === "CanonicalToolResultEntry"
    ? matchingTrailingCall(Option.fromUndefinedOr(turn[index - 1]), entry).pipe(
        Option.match({
          onNone: () => [entry],
          onSome: (call) => [call, entry],
        })
      )
    : [entry];
};

/** Whether the entry at the index is the call already carried by the result that follows it. */
const pairedWithFollowingResult = (
  turn: ReadonlyArray<TranscriptWindowEntry>,
  index: number
): boolean =>
  Option.fromUndefinedOr(turn[index + 1]).pipe(
    Option.exists(() => trailingTurnUnit(turn, index + 1).length > 1)
  );

const boundedActiveTurn = (
  turn: ReadonlyArray<TranscriptWindowEntry>,
  maxCharacters: TranscriptWindowCharacterLimit
): ReadonlyArray<TranscriptWindowEntry> => {
  const user = activeTurnUser(turn, maxCharacters);
  if (Option.isNone(user)) return [];

  const state: {
    suffix: Array<TranscriptWindowEntry>;
    characters: number;
    stopped: boolean;
  } = {
    suffix: [],
    characters: entryCharacters(user.value),
    stopped: false,
  };
  const [, ...trailing] = turn;
  const newestFirstIndexes = Array.from(trailing.keys(), (index) => turn.length - 1 - index);
  newestFirstIndexes.forEach((index) => {
    if (state.stopped) return;
    if (pairedWithFollowingResult(turn, index)) return;
    const unit = trailingTurnUnit(turn, index);
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
  remaining: ReadonlyArray<ReadonlyArray<TranscriptWindowEntry>>;
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
  turn: ReadonlyArray<TranscriptWindowEntry>,
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
  turns: ReadonlyArray<ReadonlyArray<TranscriptWindowEntry>>,
  maxTurns: TranscriptWindowTurnLimit,
  maxCharacters: TranscriptWindowCharacterLimit
): ReadonlyArray<TranscriptWindowEntry> =>
  continueNewestTurns(
    { remaining: turns.toReversed(), selected: [], characters: 0 },
    maxTurns,
    maxCharacters
  );

/**
 * Selects the newest contiguous Transcript turns that satisfy both bounds.
 * Entries must be chronological, with entries from each turn contiguous; the
 * caller decides which turns are complete or may include an in-progress turn.
 * Complete turns remain atomic. If the active newest turn exceeds the aggregate
 * bound, its User request and newest complete call/result suffix are retained.
 * No entry is truncated and persisted history is never mutated.
 */
export const selectTranscriptWindow = Effect.fn("selectTranscriptWindow")(
  (
    entries: ReadonlyArray<TranscriptWindowEntry>,
    maxTurns: TranscriptWindowTurnLimit,
    maxCharacters: TranscriptWindowCharacterLimit
  ) => Effect.succeed(newestTurnsWithin(groupTurns(entries), maxTurns, maxCharacters))
);
