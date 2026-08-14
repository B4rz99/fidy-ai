import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { computePatIdleExpiry } from "./rules";

it.effect("computes the shared relational idle deadline exactly 90 days later", () =>
  Effect.gen(function* () {
    const renewed = yield* computePatIdleExpiry(DateTime.makeUnsafe("2026-01-01T00:00:00Z"));

    expect(DateTime.formatIso(renewed)).toBe("2026-04-01T00:00:00.000Z");
  })
);
