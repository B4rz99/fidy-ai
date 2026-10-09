import { afterEach, expect, it, vi } from "vitest";
import { Effect } from "effect";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("does not mount the local UI reference in production", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.stubEnv("DEV", false);
      yield* Effect.tryPromise(() => expect(import("./ui-reference")).resolves.toBeDefined());
      expect(document.querySelector("#root")).toBeNull();
    })
  ));

it("reports a missing reference root during development", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.stubEnv("DEV", true);
      yield* Effect.tryPromise(() =>
        expect(import("./ui-reference")).rejects.toThrow("UI reference root is missing")
      );
    })
  ));
