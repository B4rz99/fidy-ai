import { expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import {
  AgentIteration,
  AssistantTranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  UserTranscriptEntry,
} from "~/core/transcript/model";
import {
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
