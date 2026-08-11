import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { type TrialPeriod } from "./model";
import { UserId } from "./reference";
import { decideEffectiveAccess, makeColombianUser } from "./rules";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000001");
const createdAt = DateTime.makeUnsafe("2026-07-28T00:00:00Z");
const makeTrialPeriod = (overrides: Partial<TrialPeriod> = {}): TrialPeriod => ({
  startedAt: DateTime.makeUnsafe("2026-08-01T12:00:00Z"),
  endsAt: DateTime.makeUnsafe("2026-08-08T12:00:00Z"),
  ...overrides,
});

it.effect("creates a Colombian User with explicit independent context", () =>
  Effect.gen(function* () {
    const user = yield* makeColombianUser(userId, { createdAt, paidTier: "free" });

    expect(user).toMatchObject({
      id: userId,
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
      paidTier: "free",
      trialPeriod: {
        startedAt: createdAt,
        endsAt: DateTime.makeUnsafe("2026-08-04T00:00:00Z"),
      },
      createdAt,
    });
  })
);

it.effect("ends trial-derived Pro access at the exclusive TrialPeriod end", () =>
  Effect.gen(function* () {
    const trialPeriod = makeTrialPeriod();

    expect(
      yield* decideEffectiveAccess(
        { paidTier: "free", trialPeriod },
        DateTime.makeUnsafe("2026-08-08T11:59:59.999Z")
      )
    ).toBe("pro");
    expect(
      yield* decideEffectiveAccess(
        { paidTier: "free", trialPeriod },
        DateTime.makeUnsafe("2026-08-08T12:00:00Z")
      )
    ).toBe("free");
  })
);

it.effect("keeps paid Pro access after the TrialPeriod ends", () =>
  Effect.gen(function* () {
    const trialPeriod = makeTrialPeriod();

    expect(
      yield* decideEffectiveAccess(
        { paidTier: "pro", trialPeriod },
        DateTime.makeUnsafe("2026-08-02T00:00:00Z")
      )
    ).toBe("pro");
    expect(
      yield* decideEffectiveAccess(
        { paidTier: "pro", trialPeriod },
        DateTime.makeUnsafe("2026-09-01T00:00:00Z")
      )
    ).toBe("pro");
  })
);
