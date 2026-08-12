import { Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import type { TranscriptContentEntry, TranscriptTurnId } from "~/core/transcript/model";
import {
  listRecentTranscriptEntries as loadRecentTranscriptEntries,
  listTranscriptTurnEntries as loadTranscriptTurnEntries,
  appendTranscriptEntries as persistTranscriptEntries,
} from "./repo";

/** Appends exact Transcript evidence for one explicit User in supplied order. */
export const appendTranscriptEntries = Effect.fn("appendTranscriptEntriesOperation")(
  (userId: UserId, entries: ReadonlyArray<TranscriptContentEntry>) =>
    persistTranscriptEntries(userId, entries)
);

/** Loads the newest completed Transcript turns for one explicit User. */
export const listRecentTranscriptEntries = Effect.fn("listRecentTranscriptEntriesOperation")(
  (userId: UserId, maxTurns: number) => loadRecentTranscriptEntries(userId, maxTurns)
);

/** Loads one explicit Transcript turn, including its in-progress entries. */
export const listTranscriptTurnEntries = Effect.fn("listTranscriptTurnEntriesOperation")(
  (userId: UserId, turnId: TranscriptTurnId) => loadTranscriptTurnEntries(userId, turnId)
);
