import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { UserId } from "./reference";
import { isTrialPeriodActive, makeColombianUser } from "./rules";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000001");
const createdAt = DateTime.makeUnsafe("2026-07-28T00:00:00Z");

it.effect("creates a Colombian User with explicit independent context", () =>
  Effect.gen(function* () {
    const user = yield* makeColombianUser(userId, { createdAt });

    expect(user).toMatchObject({
      id: userId,
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Bogota",
      trialPeriod: {
        startedAt: createdAt,
        endsAt: DateTime.makeUnsafe("2026-08-04T00:00:00Z"),
      },
      createdAt,
    });
  })
);

it.effect("treats TrialPeriod as half-open at both boundaries", () =>
  Effect.gen(function* () {
    const user = yield* makeColombianUser(userId, { createdAt });
    expect(yield* isTrialPeriodActive(user.trialPeriod, createdAt)).toBe(true);
    expect(
      yield* isTrialPeriodActive(user.trialPeriod, DateTime.makeUnsafe("2026-08-03T23:59:59.999Z"))
    ).toBe(true);
    expect(yield* isTrialPeriodActive(user.trialPeriod, user.trialPeriod.endsAt)).toBe(false);
    expect(
      yield* isTrialPeriodActive(user.trialPeriod, DateTime.makeUnsafe("2026-07-27T23:59:59.999Z"))
    ).toBe(false);
  })
);
