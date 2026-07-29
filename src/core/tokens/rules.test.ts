import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { renewAgentTokenIdleExpiry } from "./rules";

it.effect("renews AgentToken use for exactly 90 idle days without a fixed lifetime", () =>
  Effect.gen(function* () {
    const renewed = yield* renewAgentTokenIdleExpiry(DateTime.makeUnsafe("2026-01-01T00:00:00Z"));

    expect(DateTime.formatIso(renewed)).toBe("2026-04-01T00:00:00.000Z");
  })
);
