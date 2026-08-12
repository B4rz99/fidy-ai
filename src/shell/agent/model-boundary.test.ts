import { expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { TranscriptTurnId } from "~/core/transcript/model";
import { projectTranscriptForModel, systemPrompt, turnPrompt } from "./model-boundary";

const userContext = {
  serviceMarket: ServiceMarket.make("CO"),
  locale: Locale.make("es-CO"),
  timeZone: IanaTimeZone.make("America/Bogota"),
};

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
