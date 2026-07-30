import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { transitionInsight } from "./rules";

const decide = (current: "pending" | "delivered" | "read" | "dismissed", target: typeof current) =>
  Effect.runSync(Effect.result(transitionInsight({ current, target })));

it("moves a pending InsightEvent to delivered", () => {
  const outcome = decide("pending", "delivered");

  expect(Result.isSuccess(outcome) ? outcome.success : undefined).toBe("delivered");
});

it("lets consumers skip delivery evidence when they read or dismiss a pending InsightEvent", () => {
  expect(Result.isSuccess(decide("pending", "read"))).toBe(true);
  expect(Result.isSuccess(decide("pending", "dismissed"))).toBe(true);
  expect(Result.isSuccess(decide("delivered", "dismissed"))).toBe(true);
});

it("permits every adjacent forward movement", () => {
  expect(Result.isSuccess(decide("delivered", "read"))).toBe(true);
  expect(Result.isSuccess(decide("read", "dismissed"))).toBe(true);
});

it("rejects repeats and backward movements with the valid choices from the current state", () => {
  const repeated = decide("delivered", "delivered");
  const backward = decide("read", "pending");
  const terminal = decide("dismissed", "read");

  expect(Result.isFailure(repeated) ? repeated.failure : undefined).toMatchObject({
    current: "delivered",
    target: "delivered",
    allowedTargets: ["read", "dismissed"],
  });
  expect(Result.isFailure(backward)).toBe(true);
  expect(Result.isFailure(terminal) ? terminal.failure.allowedTargets : undefined).toEqual([]);
});
