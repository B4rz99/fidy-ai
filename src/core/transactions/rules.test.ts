import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Result } from "effect";
import { checkAlreadyOccurred } from "./rules";

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

const decide = (occurredAt: string, now: string) =>
  Effect.runSync(Effect.result(checkAlreadyOccurred({ occurredAt: at(occurredAt), now: at(now) })));

it("accepts a movement that happened before it was recorded", () => {
  expect(Result.isSuccess(decide("2026-07-20T12:30:00Z", "2026-07-25T09:00:00Z"))).toBe(true);
});

it("accepts a capture that races the clock to the same instant", () => {
  expect(Result.isSuccess(decide("2026-07-25T09:00:00Z", "2026-07-25T09:00:00Z"))).toBe(true);
});

it("rejects a movement dated after the moment it is recorded, which has not happened", () => {
  const outcome = decide("2026-07-26T09:00:00Z", "2026-07-25T09:00:00Z");

  expect(Result.isFailure(outcome)).toBe(true);
});

it("names both instants, so a typo and a clock skew can be told apart", () => {
  const outcome = decide("2026-07-26T09:00:00Z", "2026-07-25T09:00:00Z");

  expect(Result.isFailure(outcome) ? outcome.failure : undefined).toMatchObject({
    occurredAt: at("2026-07-26T09:00:00Z"),
    now: at("2026-07-25T09:00:00Z"),
  });
});
