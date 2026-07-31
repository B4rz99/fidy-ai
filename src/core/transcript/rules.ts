import { Effect, Option, Schema, Struct } from "effect";
import {
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
  UserTranscriptEntry,
  type CanonicalToolOutcome,
} from "./model";

type DeepReadonly<T> =
  T extends ReadonlyArray<infer Value>
    ? ReadonlyArray<DeepReadonly<Value>>
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;
type ReadonlyJson = DeepReadonly<Schema.Json>;

const WindowTextEntry = Schema.Union([
  UserTranscriptEntry.mapFields(Struct.pick(["_tag", "turnId", "text"])),
  AssistantTranscriptEntry.mapFields(Struct.pick(["_tag", "turnId", "text"])),
]);
const WindowCallEntry = CanonicalToolCallEntry.mapFields(
  Struct.pick(["_tag", "turnId", "toolCallId", "operation", "input"])
);
const WindowResultEntry = CanonicalToolResultEntry.mapFields(
  Struct.pick(["_tag", "turnId", "toolCallId", "operation", "outcome"])
);
type SucceededOutcome = Extract<CanonicalToolOutcome, { readonly _tag: "Succeeded" }>;
type FailedOutcome = Exclude<CanonicalToolOutcome, SucceededOutcome>;
type WindowOutcome =
  | { readonly _tag: SucceededOutcome["_tag"]; readonly output: ReadonlyJson }
  | { readonly _tag: FailedOutcome["_tag"]; readonly failure: ReadonlyJson };
type WindowTextEntry = typeof WindowTextEntry.Encoded;
type WindowCallEntry = Omit<typeof WindowCallEntry.Encoded, "input"> & {
  readonly input: ReadonlyJson;
};
type WindowResultEntry = Omit<typeof WindowResultEntry.Encoded, "outcome"> & {
  readonly outcome: WindowOutcome;
};

/** Canonical Transcript fields considered for complete-turn model context selection. */
export type TranscriptWindowEntry = WindowTextEntry | WindowCallEntry | WindowResultEntry;

/** Positive whole-turn bound for model-context selection. */
export const TranscriptWindowTurnLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 })
).pipe(Schema.brand("TranscriptWindowTurnLimit"));
export type TranscriptWindowTurnLimit = typeof TranscriptWindowTurnLimit.Type;

/** Positive character bound for model-context selection. */
export const TranscriptWindowCharacterLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 200_000 })
).pipe(Schema.brand("TranscriptWindowCharacterLimit"));
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

const groupTurns = (
  entries: ReadonlyArray<TranscriptWindowEntry>
): ReadonlyArray<ReadonlyArray<TranscriptWindowEntry>> => {
  const turns: Array<Array<TranscriptWindowEntry>> = [];
  for (const entry of entries) {
    const current = turns.at(-1);
    if (current !== undefined && current[0]?.turnId === entry.turnId) current.push(entry);
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
): Option.Option<WindowUserEntry> =>
  Option.fromUndefinedOr(turn[0]).pipe(
    Option.filter((entry): entry is WindowUserEntry => entry._tag === "UserTranscriptEntry"),
    Option.filter((user) => entryCharacters(user) <= maxCharacters),
    Option.filter(() => turn.at(-1)?._tag !== "AssistantTranscriptEntry")
  );

const matchingTrailingCall = (
  previous: TranscriptWindowEntry | undefined,
  result: WindowResultEntryValue
): Option.Option<WindowCallEntryValue> =>
  Option.fromUndefinedOr(previous).pipe(
    Option.filter(
      (entry): entry is WindowCallEntryValue => entry._tag === "CanonicalToolCallEntry"
    ),
    Option.filter((call) => call.toolCallId === result.toolCallId)
  );

const trailingTurnUnit = (
  turn: ReadonlyArray<TranscriptWindowEntry>,
  index: number
): ReadonlyArray<TranscriptWindowEntry> =>
  Option.fromUndefinedOr(turn[index]).pipe(
    Option.match({
      onNone: () => [],
      onSome: (entry) =>
        entry._tag === "CanonicalToolResultEntry"
          ? matchingTrailingCall(turn[index - 1], entry).pipe(
              Option.match({
                onNone: () => [entry],
                onSome: (call) => [call, entry],
              })
            )
          : [entry],
    })
  );

const boundedActiveTurn = (
  turn: ReadonlyArray<TranscriptWindowEntry>,
  maxCharacters: TranscriptWindowCharacterLimit
): ReadonlyArray<TranscriptWindowEntry> => {
  const user = activeTurnUser(turn, maxCharacters);
  if (Option.isNone(user)) return [];

  const suffix: Array<TranscriptWindowEntry> = [];
  let characters = entryCharacters(user.value);
  for (let index = turn.length - 1; index > 0;) {
    const unit = trailingTurnUnit(turn, index);
    const unitCharacters = unit.reduce((total, member) => total + entryCharacters(member), 0);
    if (characters + unitCharacters > maxCharacters) break;
    suffix.unshift(...unit);
    characters += unitCharacters;
    index -= unit.length;
  }
  return [user.value, ...suffix];
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
