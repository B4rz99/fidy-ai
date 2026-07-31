import { Effect, Schema, Struct } from "effect";
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

const boundedActiveTurn = (
  turn: ReadonlyArray<TranscriptWindowEntry>,
  maxCharacters: TranscriptWindowCharacterLimit
): ReadonlyArray<TranscriptWindowEntry> => {
  const user = turn[0];
  const last = turn.at(-1);
  if (
    user?._tag !== "UserTranscriptEntry" ||
    last?._tag === "AssistantTranscriptEntry" ||
    entryCharacters(user) > maxCharacters
  ) {
    return [];
  }

  const suffix: Array<TranscriptWindowEntry> = [];
  let characters = entryCharacters(user);
  for (let index = turn.length - 1; index > 0;) {
    const entry = turn[index];
    if (entry === undefined) break;
    const previous = turn[index - 1];
    const unit =
      entry._tag === "CanonicalToolResultEntry" &&
      previous?._tag === "CanonicalToolCallEntry" &&
      previous.toolCallId === entry.toolCallId
        ? [previous, entry]
        : [entry];
    const unitCharacters = unit.reduce((total, member) => total + entryCharacters(member), 0);
    if (characters + unitCharacters > maxCharacters) break;
    suffix.unshift(...unit);
    characters += unitCharacters;
    index -= unit.length;
  }
  return [user, ...suffix];
};

const newestTurnsWithin = (
  turns: ReadonlyArray<ReadonlyArray<TranscriptWindowEntry>>,
  maxTurns: TranscriptWindowTurnLimit,
  maxCharacters: TranscriptWindowCharacterLimit
): ReadonlyArray<TranscriptWindowEntry> => {
  const selected: Array<ReadonlyArray<TranscriptWindowEntry>> = [];
  let characters = 0;
  for (const turn of turns.toReversed()) {
    const turnCharacters = turn.reduce((total, entry) => total + entryCharacters(entry), 0);
    if (selected.length >= maxTurns || characters + turnCharacters > maxCharacters) {
      return selected.length === 0 ? boundedActiveTurn(turn, maxCharacters) : selected.flat();
    }
    selected.unshift(turn);
    characters += turnCharacters;
  }
  return selected.flat();
};

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
