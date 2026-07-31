import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import {
  AgentIteration,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
  ToolCallId,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  UserTranscriptEntry,
  type TranscriptEntry,
} from "./model";
import {
  selectTranscriptWindow,
  TranscriptWindowCharacterLimit,
  TranscriptWindowTurnLimit,
  type TranscriptWindowEntry,
} from "./rules";

const occurredAt = DateTime.makeUnsafe("2026-07-20T12:00:00Z");
const selectWindow = (
  entries: ReadonlyArray<TranscriptWindowEntry>,
  maxTurns: number,
  maxCharacters: number
) =>
  selectTranscriptWindow(
    entries,
    TranscriptWindowTurnLimit.make(maxTurns),
    TranscriptWindowCharacterLimit.make(maxCharacters)
  );
const entryId = (suffix: string) =>
  TranscriptEntryId.make(`f1d1a000-0000-4000-8000-${suffix.padStart(12, "0")}`);
const turnId = (suffix: string) =>
  TranscriptTurnId.make(`f1d1a000-0000-4000-8001-${suffix.padStart(12, "0")}`);

const turn = (suffix: string, user: string, assistant: string): ReadonlyArray<TranscriptEntry> => [
  UserTranscriptEntry.make({
    id: entryId(`${suffix}1`),
    turnId: turnId(suffix),
    text: TranscriptText.make(user),
    occurredAt,
  }),
  AssistantTranscriptEntry.make({
    id: entryId(`${suffix}2`),
    turnId: turnId(suffix),
    iteration: AgentIteration.make(1),
    text: TranscriptText.make(assistant),
    occurredAt,
  }),
];

it.effect("keeps the newest complete Transcript turns within both context bounds", () =>
  Effect.gen(function* () {
    const oldest = turn("1", "old user", "old assistant");
    const middle = turn("2", "middle user", "middle assistant");
    const newest = turn("3", "new user", "new assistant");
    const selected = yield* selectWindow([...oldest, ...middle, ...newest], 2, 1_000);

    expect(selected).toEqual([...middle, ...newest]);
  })
);

it.effect("never splits a turn to fill the remaining character budget", () =>
  Effect.gen(function* () {
    const older = turn("4", "small", "small");
    const newest = turn("5", "newest-user", "newest-assistant");
    const selected = yield* selectWindow(
      [...older, ...newest],
      5,
      "newest-user".length + "newest-assistant".length
    );

    expect(selected).toEqual(newest);
  })
);

it.effect("returns no partial entries when the newest complete turn exceeds the bound", () =>
  Effect.gen(function* () {
    const newest = turn("6", "oversized-user", "oversized-assistant");

    expect(yield* selectWindow(newest, 1, 1)).toEqual([]);
  })
);

it.effect(
  "retains the User request and newest complete tool feedback from an oversized active turn",
  () =>
    Effect.gen(function* () {
      const id = turnId("7");
      const operation = CanonicalOperationId.make("categories.listCategories");
      const user = UserTranscriptEntry.make({
        id: entryId("71"),
        turnId: id,
        text: TranscriptText.make("current request"),
        occurredAt,
      });
      const oldCall = CanonicalToolCallEntry.make({
        id: entryId("72"),
        turnId: id,
        iteration: AgentIteration.make(1),
        toolCallId: ToolCallId.make("old-call"),
        operation,
        input: { old: "x".repeat(40) },
        occurredAt,
      });
      const oldResult = CanonicalToolResultEntry.make({
        id: entryId("73"),
        turnId: id,
        iteration: AgentIteration.make(1),
        toolCallId: ToolCallId.make("old-call"),
        operation,
        outcome: { _tag: "Succeeded", output: { old: "x".repeat(40) } },
        occurredAt,
      });
      const latestCall = CanonicalToolCallEntry.make({
        id: entryId("74"),
        turnId: id,
        iteration: AgentIteration.make(2),
        toolCallId: ToolCallId.make("latest-call"),
        operation,
        input: {},
        occurredAt,
      });
      const latestResult = CanonicalToolResultEntry.make({
        id: entryId("75"),
        turnId: id,
        iteration: AgentIteration.make(2),
        toolCallId: ToolCallId.make("latest-call"),
        operation,
        outcome: { _tag: "ToolInputRejected", failure: { code: "retry" } },
        occurredAt,
      });
      const latestCharacters = 33;

      expect(
        yield* selectWindow(
          [user, oldCall, oldResult, latestCall, latestResult],
          1,
          latestCharacters
        )
      ).toEqual([user, latestCall, latestResult]);
    })
);

it.effect("counts canonical call inputs and both result outcomes in the turn budget", () =>
  Effect.gen(function* () {
    const id = turnId("8");
    const operation = CanonicalOperationId.make("categories.listCategories");
    const entries: ReadonlyArray<TranscriptEntry> = [
      CanonicalToolCallEntry.make({
        id: entryId("81"),
        turnId: id,
        iteration: AgentIteration.make(1),
        toolCallId: ToolCallId.make("call-1"),
        operation,
        input: { requested: true },
        occurredAt,
      }),
      CanonicalToolResultEntry.make({
        id: entryId("82"),
        turnId: id,
        iteration: AgentIteration.make(1),
        toolCallId: ToolCallId.make("call-1"),
        operation,
        outcome: { _tag: "Succeeded", output: ["complete"] },
        occurredAt,
      }),
      CanonicalToolResultEntry.make({
        id: entryId("83"),
        turnId: id,
        iteration: AgentIteration.make(1),
        toolCallId: ToolCallId.make("call-2"),
        operation,
        outcome: { _tag: "ToolInputRejected", failure: { code: "rejected" } },
        occurredAt,
      }),
    ];
    expect(yield* selectWindow(entries, 1, 49)).toEqual(entries);
    expect(yield* selectWindow(entries, 1, 48)).toEqual([]);
  })
);
