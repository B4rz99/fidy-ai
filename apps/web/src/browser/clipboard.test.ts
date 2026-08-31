import assert from "node:assert/strict";
import { Effect, Exit, Option } from "effect";
import { expect, it, vi } from "vitest";
import { ClipboardAccessFailed, writeClipboardText } from "./clipboard";

it("writes text through an available browser clipboard", async () => {
  const writeText = vi.fn(() => Promise.resolve());

  await Effect.runPromise(writeClipboardText(Option.some({ writeText }), "texto"));

  expect(writeText).toHaveBeenCalledWith("texto");
});

it("reports clipboard rejection through the typed failure channel", async () => {
  const writeText = vi.fn(() => Promise.reject(new Error("permission denied")));

  const exit = await Effect.runPromise(
    Effect.exit(writeClipboardText(Option.some({ writeText }), "texto"))
  );

  assert.deepStrictEqual(exit, Exit.fail(new ClipboardAccessFailed()));
});

it("reports an unavailable clipboard through the typed failure channel", async () => {
  const exit = await Effect.runPromise(Effect.exit(writeClipboardText(Option.none(), "texto")));

  assert.deepStrictEqual(exit, Exit.fail(new ClipboardAccessFailed()));
});
