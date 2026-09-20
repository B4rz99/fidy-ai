import { expect, it } from "@effect/vitest";
import { TranscriptTurnId } from "~/core/transcript/model";
import { containsSensitiveChatValue, projectTranscriptForModel } from "./model-boundary";

it("does not mistake a card-like digit run inside a hexadecimal digest for a card", () => {
  const digest = `a${"4222222222222"}${"a".repeat(50)}`;

  expect(digest).toHaveLength(64);
  expect(containsSensitiveChatValue(`CONFIRMAR LOTE ${digest}`)).toBe(false);
  expect(containsSensitiveChatValue("tarjeta 4222222222222")).toBe(true);
});

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
