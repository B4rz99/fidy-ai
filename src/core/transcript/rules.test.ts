import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Result, Schema } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import {
  AgentIteration,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
  ToolCallId,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  UserTranscriptEntry,
} from "./model";
import {
  TranscriptWindowCharacterLimit,
  type TranscriptWindowEntry,
  TranscriptWindowTurnLimit,
  selectTranscriptWindow,
} from "./rules";

const occurredAt = DateTime.makeUnsafe("2026-07-20T12:00:00Z");

it("rejects a value outside every TranscriptEntry variant", () => {
  expect(Result.isFailure(Schema.decodeUnknownResult(TranscriptEntry)([]))).toBe(true);
});

const selectWindow = (
  entries: ReadonlyArray<TranscriptWindowEntry>,
  maxTurns: number,
  maxCharacters: number
): Effect.Effect<ReadonlyArray<TranscriptWindowEntry>> =>
  selectTranscriptWindow(
    entries,
    TranscriptWindowTurnLimit.make(maxTurns),
    TranscriptWindowCharacterLimit.make(maxCharacters)
  );
const entryId = (suffix: string): TranscriptEntryId =>
  TranscriptEntryId.make(`f1d1a000-0000-4000-8000-${suffix.padStart(12, "0")}`);
const turnId = (suffix: string): TranscriptTurnId =>
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

const windowOperation = CanonicalOperationId.make("categories.listCategories");
const windowUser = (suffix: string, id: TranscriptTurnId, text = "u"): UserTranscriptEntry =>
  UserTranscriptEntry.make({
    id: entryId(suffix),
    turnId: id,
    text: TranscriptText.make(text),
    occurredAt,
  });
const windowAssistant = (
  suffix: string,
  id: TranscriptTurnId,
  text = "a"
): AssistantTranscriptEntry =>
  AssistantTranscriptEntry.make({
    id: entryId(suffix),
    turnId: id,
    iteration: AgentIteration.make(1),
    text: TranscriptText.make(text),
    occurredAt,
  });
const windowCall = (
  suffix: string,
  id: TranscriptTurnId,
  toolCallId: string
): CanonicalToolCallEntry =>
  CanonicalToolCallEntry.make({
    id: entryId(suffix),
    turnId: id,
    iteration: AgentIteration.make(1),
    toolCallId: ToolCallId.make(toolCallId),
    operation: windowOperation,
    input: Schema.decodeUnknownSync(Schema.Json)({}),
    occurredAt,
  });
/** A call whose serialized input alone overruns the character bounds under test. */
const windowOversizedCall = (
  suffix: string,
  id: TranscriptTurnId,
  toolCallId: string
): CanonicalToolCallEntry => ({
  ...windowCall(suffix, id, toolCallId),
  input: Schema.decodeUnknownSync(Schema.Json)({ tooLarge: "x".repeat(20) }),
});
const windowResult = (
  suffix: string,
  id: TranscriptTurnId,
  toolCallId: string
): CanonicalToolResultEntry =>
  CanonicalToolResultEntry.make({
    id: entryId(suffix),
    turnId: id,
    iteration: AgentIteration.make(1),
    toolCallId: ToolCallId.make(toolCallId),
    operation: windowOperation,
    outcome: { _tag: "Succeeded", output: {} },
    occurredAt,
  });

it("accepts every canonical TranscriptEntry variant", () => {
  const id = turnId("0");
  const operation = CanonicalOperationId.make("categories.listCategories");
  const entries: ReadonlyArray<TranscriptEntry> = [
    UserTranscriptEntry.make({
      id: entryId("01"),
      turnId: id,
      text: TranscriptText.make("user"),
      occurredAt,
    }),
    AssistantTranscriptEntry.make({
      id: entryId("02"),
      turnId: id,
      iteration: AgentIteration.make(1),
      text: TranscriptText.make("assistant"),
      occurredAt,
    }),
    CanonicalToolCallEntry.make({
      id: entryId("03"),
      turnId: id,
      iteration: AgentIteration.make(1),
      toolCallId: ToolCallId.make("call"),
      operation,
      input: {},
      occurredAt,
    }),
    CanonicalToolResultEntry.make({
      id: entryId("04"),
      turnId: id,
      iteration: AgentIteration.make(1),
      toolCallId: ToolCallId.make("call"),
      operation,
      outcome: { _tag: "Succeeded", output: {} },
      occurredAt,
    }),
  ];

  for (const entry of entries) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(TranscriptEntry)(entry))).toBe(true);
  }
});

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

it.effect("retains an active User request exactly at the character boundary", () =>
  Effect.gen(function* () {
    const user = UserTranscriptEntry.make({
      id: entryId("91"),
      turnId: turnId("9"),
      text: TranscriptText.make("boundary"),
      occurredAt,
    });

    expect(yield* selectWindow([user], 1, 8)).toEqual([user]);
    expect(yield* selectWindow([user], 1, 7)).toEqual([]);
  })
);

it.effect("retains an unmatched trailing result without its preceding call", () =>
  Effect.gen(function* () {
    const id = turnId("10");
    const operation = CanonicalOperationId.make("categories.listCategories");
    const user = UserTranscriptEntry.make({
      id: entryId("101"),
      turnId: id,
      text: TranscriptText.make("u"),
      occurredAt,
    });
    const call = CanonicalToolCallEntry.make({
      id: entryId("102"),
      turnId: id,
      iteration: AgentIteration.make(1),
      toolCallId: ToolCallId.make("different-call"),
      operation,
      input: { tooLarge: "x".repeat(20) },
      occurredAt,
    });
    const result = CanonicalToolResultEntry.make({
      id: entryId("103"),
      turnId: id,
      iteration: AgentIteration.make(1),
      toolCallId: ToolCallId.make("result-call"),
      operation,
      outcome: { _tag: "Succeeded", output: {} },
      occurredAt,
    });

    expect(yield* selectWindow([user, call, result], 1, 3)).toEqual([user, result]);
  })
);

it.effect("does not treat a non-call entry as the call for a trailing result", () =>
  Effect.gen(function* () {
    const id = turnId("11");
    const operation = CanonicalOperationId.make("categories.listCategories");
    const user = UserTranscriptEntry.make({
      id: entryId("111"),
      turnId: id,
      text: TranscriptText.make("u"),
      occurredAt,
    });
    const assistant = AssistantTranscriptEntry.make({
      id: entryId("112"),
      turnId: id,
      iteration: AgentIteration.make(1),
      text: TranscriptText.make("too large"),
      occurredAt,
    });
    const result = CanonicalToolResultEntry.make({
      id: entryId("113"),
      turnId: id,
      iteration: AgentIteration.make(1),
      toolCallId: ToolCallId.make("result-call"),
      operation,
      outcome: { _tag: "Succeeded", output: {} },
      occurredAt,
    });

    expect(yield* selectWindow([user, assistant, result], 1, 3)).toEqual([user, result]);
  })
);

it.effect("walks backward over each complete trailing call and result pair", () =>
  Effect.gen(function* () {
    const id = turnId("12");
    const operation = CanonicalOperationId.make("categories.listCategories");
    const user = UserTranscriptEntry.make({
      id: entryId("121"),
      turnId: id,
      text: TranscriptText.make("u"),
      occurredAt,
    });
    const oldCall = CanonicalToolCallEntry.make({
      id: entryId("122"),
      turnId: id,
      iteration: AgentIteration.make(1),
      toolCallId: ToolCallId.make("old-call"),
      operation,
      input: { tooLarge: "x".repeat(20) },
      occurredAt,
    });
    const trailing = [1, 2].flatMap((iteration) => {
      const toolCallId = ToolCallId.make(`call-${iteration}`);
      return [
        CanonicalToolCallEntry.make({
          id: entryId(`12${iteration * 2 + 1}`),
          turnId: id,
          iteration: AgentIteration.make(iteration),
          toolCallId,
          operation,
          input: {},
          occurredAt,
        }),
        CanonicalToolResultEntry.make({
          id: entryId(`12${iteration * 2 + 2}`),
          turnId: id,
          iteration: AgentIteration.make(iteration),
          toolCallId,
          operation,
          outcome: { _tag: "Succeeded", output: {} },
          occurredAt,
        }),
      ];
    });

    expect(yield* selectWindow([user, oldCall, ...trailing], 1, 9)).toEqual([user, ...trailing]);
  })
);

it.effect("retains a User request that exactly fills an oversized active turn", () =>
  Effect.gen(function* () {
    const id = turnId("13");
    const user = windowUser("131", id, "boundary");
    const trailingCall = windowCall("132", id, "boundary-call");

    expect(yield* selectWindow([user, trailingCall], 1, 8)).toEqual([user]);
  })
);

it.effect("does not split a completed turn when only its User request fits", () =>
  Effect.gen(function* () {
    const id = turnId("14");
    const user = windowUser("141", id);
    const assistant = windowAssistant("142", id);

    expect(yield* selectWindow([user, assistant], 1, 1)).toEqual([]);
  })
);

it.effect("does not split a matching trailing call and result at the character boundary", () =>
  Effect.gen(function* () {
    const id = turnId("15");
    const user = windowUser("151", id);
    const call = windowCall("152", id, "boundary-pair");
    const result = windowResult("153", id, "boundary-pair");

    expect(yield* selectWindow([user, call, result], 1, 3)).toEqual([user]);
  })
);

it.effect("charges every retained standalone suffix entry against the character budget", () =>
  Effect.gen(function* () {
    const id = turnId("16");
    const user = windowUser("161", id);
    const oldest = windowCall("162", id, "oldest-call");
    const middle = windowCall("163", id, "middle-call");
    const newest = windowCall("164", id, "newest-call");

    expect(yield* selectWindow([user, oldest, middle, newest], 1, 5)).toEqual([
      user,
      middle,
      newest,
    ]);
  })
);

it.effect(
  "does not pair a trailing result with a preceding result even when their ToolCallIds match",
  () =>
    Effect.gen(function* () {
      const id = turnId("17");
      const user = windowUser("171", id);
      const previousResult = windowResult("172", id, "repeated-result");
      const trailingResult = windowResult("173", id, "repeated-result");

      expect(yield* selectWindow([user, previousResult, trailingResult], 1, 4)).toEqual([
        user,
        trailingResult,
      ]);
    })
);

it.effect(
  "does not pair a trailing call with a preceding call even when their ToolCallIds match",
  () =>
    Effect.gen(function* () {
      const id = turnId("18");
      const user = windowUser("181", id);
      const previousCall = windowCall("182", id, "repeated-call");
      const trailingCall = windowCall("183", id, "repeated-call");

      expect(yield* selectWindow([user, previousCall, trailingCall], 1, 4)).toEqual([
        user,
        trailingCall,
      ]);
    })
);

it.effect("does not duplicate the active User request while scanning its suffix", () =>
  Effect.gen(function* () {
    const id = turnId("19");
    const user = windowUser("191", id);

    expect(yield* selectWindow([user], 1, 2)).toEqual([user]);
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

it.effect("keeps a fitting mismatched call before an unmatched trailing result", () =>
  Effect.gen(function* () {
    const id = turnId("20");
    const user = windowUser("201", id);
    const oversized = windowOversizedCall("202", id, "oversized");
    const call = windowCall("203", id, "call-a");
    const result = windowResult("204", id, "call-b");

    expect(yield* selectWindow([user, oversized, call, result], 1, 5)).toEqual([
      user,
      call,
      result,
    ]);
  })
);

it.effect("stops the active suffix after its newest unit exceeds the character bound", () =>
  Effect.gen(function* () {
    const id = turnId("21");
    const user = windowUser("211", id);
    const olderCall = windowCall("212", id, "older-call");
    const oversizedCall = windowOversizedCall("213", id, "newest-call");

    expect(yield* selectWindow([user, olderCall, oversizedCall], 1, 3)).toEqual([user]);
  })
);

it.effect("retains repeated unmatched results when each one fits the active suffix", () =>
  Effect.gen(function* () {
    const id = turnId("22");
    const user = windowUser("221", id);
    const oversizedCall = windowOversizedCall("222", id, "oversized");
    const previousResult = windowResult("223", id, "repeated-result");
    const trailingResult = windowResult("224", id, "repeated-result");

    expect(
      yield* selectWindow([user, oversizedCall, previousResult, trailingResult], 1, 5)
    ).toEqual([user, previousResult, trailingResult]);
  })
);
