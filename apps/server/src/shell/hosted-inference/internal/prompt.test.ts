import { expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import {
  AgentIteration,
  CanonicalToolCallEntry,
  FailedTurnTranscriptEntry,
  ToolCallId,
  TranscriptEntryId,
  TranscriptTurnId,
} from "~/core/transcript/model";
import { exactTranscriptPromptInternal, systemPromptInternal, turnPromptInternal } from "./prompt";

const userContext = {
  serviceMarket: ServiceMarket.make("CO"),
  locale: Locale.make("es-CO"),
  timeZone: IanaTimeZone.make("America/Bogota"),
};
const occurredAt = DateTime.makeUnsafe("2026-07-20T12:00:00Z");
const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-0000000004f2");

it("warns against credentials and unnecessary sensitive information without soliciting them", () => {
  const prompt = systemPromptInternal(userContext);

  expect(prompt).toContain(
    "No solicites credenciales, tokens, contraseñas, números de tarjeta ni números de cuenta"
  );
  expect(prompt).toContain("advierte al Usuario que no envíe información sensible innecesaria");
});

it("keeps volatile Turn instants out of the cacheable prompt head", () => {
  const headBeforeFirstTurn = systemPromptInternal(userContext);
  const headBeforeSecondTurn = systemPromptInternal(userContext);

  expect(headBeforeFirstTurn).toBe(headBeforeSecondTurn);
  expect(headBeforeFirstTurn).not.toContain("2026-07-20");
  expect(turnPromptInternal(occurredAt)).toContain("2026-07-20T12:00:00.000Z");
  expect(turnPromptInternal(DateTime.makeUnsafe("2026-07-20T13:00:00Z"))).toContain(
    "2026-07-20T13:00:00.000Z"
  );
});

it("projects exact canonical call and lifecycle evidence without semantic redaction", () => {
  const call = CanonicalToolCallEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004f5"),
    turnId,
    iteration: AgentIteration.make(1),
    toolCallId: ToolCallId.make("call-exact"),
    operation: CanonicalOperationId.make("transactions.listTransactions"),
    input: { password: "exact evidence" },
    occurredAt,
  });
  const failed = FailedTurnTranscriptEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000004f7"),
    turnId,
    reason: "HostedInferenceFailed",
    occurredAt,
  });

  expect(exactTranscriptPromptInternal([call, failed])).toEqual([
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
    { role: "user", content: "[TURN_FAILED:HostedInferenceFailed]" },
  ]);
});
