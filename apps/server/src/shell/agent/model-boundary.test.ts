import { expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import {
  AgentIteration,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
  FailedTurnTranscriptEntry,
  InterruptedTurnTranscriptEntry,
  ToolCallId,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  UserTranscriptEntry,
} from "~/core/transcript/model";
import {
  exactTranscriptPrompt,
  projectTranscriptForModel,
  systemPrompt,
  transcriptPrompt,
  turnPrompt,
} from "./model-boundary";

const userContext = {
  serviceMarket: ServiceMarket.make("CO"),
  locale: Locale.make("es-CO"),
  timeZone: IanaTimeZone.make("America/Bogota"),
};
const occurredAt = DateTime.makeUnsafe("2026-07-20T12:00:00Z");
const projectionTurnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-0000000004f2");

it("excludes lifecycle markers from the model projection", () => {
  const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-0000000004f1");

  expect(
    projectTranscriptForModel(
      [
        { _tag: "FailedTurnTranscriptEntry", turnId },
        { _tag: "InterruptedTurnTranscriptEntry", turnId },
      ],
      1_000
    )
  ).toEqual([]);
});

it("projects safe and sensitive transcript prose with its original role", () => {
  expect(
    transcriptPrompt([
      UserTranscriptEntry.make({
        id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004f3"),
        turnId: projectionTurnId,
        text: TranscriptText.make("contenido seguro"),
        occurredAt,
      }),
      AssistantTranscriptEntry.make({
        id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004f4"),
        turnId: projectionTurnId,
        iteration: AgentIteration.make(1),
        text: TranscriptText.make("contraseña: hunter2"),
        occurredAt,
      }),
    ])
  ).toEqual([
    { role: "user", content: "contenido seguro" },
    {
      role: "assistant",
      content:
        "No envíes credenciales ni tokens por chat. Este mensaje no fue guardado ni procesado.",
    },
  ]);
});

it("projects exact canonical tool and lifecycle evidence without semantic redaction", () => {
  const call = CanonicalToolCallEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004f5"),
    turnId: projectionTurnId,
    iteration: AgentIteration.make(1),
    toolCallId: ToolCallId.make("call-exact"),
    operation: CanonicalOperationId.make("transactions.listTransactions"),
    input: { password: "exact evidence" },
    occurredAt,
  });
  const result = CanonicalToolResultEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004f6"),
    turnId: projectionTurnId,
    iteration: AgentIteration.make(1),
    toolCallId: ToolCallId.make("call-exact"),
    operation: CanonicalOperationId.make("transactions.listTransactions"),
    outcome: { _tag: "CanonicalOperationFailed", failure: { reason: "exact failure" } },
    occurredAt,
  });
  const failed = FailedTurnTranscriptEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004f7"),
    turnId: projectionTurnId,
    reason: "HostedInferenceFailed",
    occurredAt,
  });
  const interrupted = InterruptedTurnTranscriptEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004f8"),
    turnId: projectionTurnId,
    occurredAt,
  });

  expect(exactTranscriptPrompt([call, result, failed, interrupted])).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          id: "call-exact",
          name: "transactions__listTransactions",
          params: { password: "exact evidence" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call-exact",
          name: "transactions__listTransactions",
          result: { reason: "exact failure" },
          isFailure: true,
        },
      ],
    },
    { role: "user", content: "[TURN_FAILED:HostedInferenceFailed]" },
    { role: "user", content: "[TURN_INTERRUPTED]" },
  ]);
});

it("projects canonical tool evidence while replacing sensitive boundary values", () => {
  const providerCredential = ["sk", "fixturecredentialvalue"].join("-");
  const call = CanonicalToolCallEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004f9"),
    turnId: projectionTurnId,
    iteration: AgentIteration.make(1),
    toolCallId: ToolCallId.make("call-sensitive"),
    operation: CanonicalOperationId.make("transactions.listTransactions"),
    input: { credential: providerCredential },
    occurredAt,
  });
  const result = CanonicalToolResultEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004fa"),
    turnId: projectionTurnId,
    iteration: AgentIteration.make(1),
    toolCallId: ToolCallId.make("call-safe"),
    operation: CanonicalOperationId.make("transactions.listTransactions"),
    outcome: { _tag: "Succeeded", output: { count: 1 } },
    occurredAt,
  });
  const sensitiveFailure = CanonicalToolResultEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004fb"),
    turnId: projectionTurnId,
    iteration: AgentIteration.make(1),
    toolCallId: ToolCallId.make("call-failed"),
    operation: CanonicalOperationId.make("transactions.listTransactions"),
    outcome: {
      _tag: "CanonicalOperationFailed",
      failure: { credential: providerCredential },
    },
    occurredAt,
  });

  expect(transcriptPrompt([call, result, sensitiveFailure])).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          id: "call-sensitive",
          name: "transactions__listTransactions",
          params: {
            code: "sensitive_entry_rejected",
            message: "A sensitive value was removed at the model boundary.",
          },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call-safe",
          name: "transactions__listTransactions",
          result: { count: 1 },
          isFailure: false,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call-failed",
          name: "transactions__listTransactions",
          result: {
            code: "sensitive_entry_rejected",
            message: "A sensitive value was removed at the model boundary.",
          },
          isFailure: true,
        },
      ],
    },
  ]);
});

it("warns against credentials and unnecessary sensitive information without soliciting them", () => {
  const prompt = systemPrompt(userContext);

  expect(prompt).toContain(
    "No solicites credenciales, tokens, contraseñas, números de tarjeta ni números de cuenta"
  );
  expect(prompt).toContain("advierte al Usuario que no envíe información sensible innecesaria");
});

it("keeps volatile turn instants out of the cacheable prompt head", () => {
  const firstTurn = DateTime.makeUnsafe("2026-07-20T12:00:00Z");
  const secondTurn = DateTime.makeUnsafe("2026-07-20T13:00:00Z");

  const headBeforeFirstTurn = systemPrompt(userContext);
  const headBeforeSecondTurn = systemPrompt(userContext);

  expect(headBeforeFirstTurn).toBe(headBeforeSecondTurn);
  expect(headBeforeFirstTurn).not.toContain("2026-07-20");
  expect(turnPrompt(firstTurn)).toContain("2026-07-20T12:00:00.000Z");
  expect(turnPrompt(secondTurn)).toContain("2026-07-20T13:00:00.000Z");
});
