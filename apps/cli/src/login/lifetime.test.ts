import { StartedPATPairing } from "@fidy/server/client";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { type PairingClient, PollingDelayed } from "./contract";
import { CliFailure } from "../credential/contract";
import { makeLoginFixture, request } from "./login.test-fixture";
import { login } from "./operations";

it.effect("stops pending polls at the pairing deadline and never persists an expired pairing", () =>
  Effect.gen(function* () {
    const fixture = makeLoginFixture();
    let claims = 0;
    const pending = {
      ...fixture.dependencies.pairing,
      claim: (): Effect.Effect<
        Readonly<{ status: "pending_approval"; pollingIntervalSeconds: number }>
      > =>
        Effect.sync(() => {
          claims += 1;
          return { status: "pending_approval", pollingIntervalSeconds: 5 };
        }),
    };
    const fiber = yield* login(request, () => Effect.void, {
      ...fixture.dependencies,
      pairing: pending,
    }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(fiber)).toMatchObject({ failure: { reason: "Expired" } });
    const pollsBeforeDeadline = 119;
    expect(claims).toBe(pollsBeforeDeadline);
    expect(fixture.saved).toHaveLength(0);
  })
);

it.effect("interruption owns cancellation and does not begin another poll or save", () =>
  Effect.gen(function* () {
    const fixture = makeLoginFixture();
    const fiber = yield* login(request, () => Effect.void, fixture.dependencies).pipe(
      Effect.forkChild
    );
    yield* TestClock.adjust("1 second");
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust("10 minutes");
    expect(fixture.claims).toHaveLength(0);
    expect(fixture.saved).toHaveLength(0);
  })
);

it.effect("a lost claim response is non-recoverable and is never replayed", () =>
  Effect.gen(function* () {
    const fixture = makeLoginFixture();
    let claims = 0;
    const pairing = {
      ...fixture.dependencies.pairing,
      claim: (): Effect.Effect<never, CliFailure> =>
        Effect.sync(() => {
          claims += 1;
        }).pipe(Effect.andThen(Effect.fail(new CliFailure({ reason: "ClaimAmbiguous" })))),
    };
    const fiber = yield* login(request, () => Effect.void, {
      ...fixture.dependencies,
      pairing,
    }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ failure: { reason: "ClaimAmbiguous" } });
    yield* TestClock.adjust("10 minutes");
    expect(claims).toBe(1);
    expect(fixture.saved).toHaveLength(0);
  })
);

it.effect("a slowdown cannot lower the server-advertised polling cadence", () =>
  Effect.gen(function* () {
    const fixture = makeLoginFixture();
    let attempts = 0;
    const pairing: PairingClient = {
      ...fixture.dependencies.pairing,
      claim: (value: Parameters<typeof fixture.dependencies.pairing.claim>[0]) =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail(new PollingDelayed({ retryAfterSeconds: 1 }))
            : fixture.dependencies.pairing.claim(value);
        }),
    };
    const fiber = yield* login(request, () => Effect.void, {
      ...fixture.dependencies,
      pairing,
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("9 seconds");
    expect(attempts).toBe(1);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(attempts).toBe(2);
    expect(fixture.saved).toHaveLength(1);
  })
);

it.effect("even schema-valid remote expiry and cadence cannot create unbounded work", () =>
  Effect.gen(function* () {
    const fixture = makeLoginFixture();
    const future = yield* Schema.decodeEffect(
      Schema.toCodecJson(StartedPATPairing.fields.expiresAt)
    )("9999-01-01T00:00:00.000Z");
    const excessiveInterval = 1_000_000;
    let attempts = 0;
    const pairing: PairingClient = {
      ...fixture.dependencies.pairing,
      start: (value: Parameters<typeof fixture.dependencies.pairing.start>[0]) =>
        fixture.dependencies.pairing
          .start(value)
          .pipe(Effect.map((started) => ({ ...started, expiresAt: future }))),
      claim: () =>
        Effect.sync(() => {
          attempts += 1;
          return { status: "pending_approval", pollingIntervalSeconds: excessiveInterval } as const;
        }),
    };
    const fiber = yield* login(request, () => Effect.void, {
      ...fixture.dependencies,
      pairing,
    }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("10 minutes");
    yield* TestClock.adjust("15 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ failure: { reason: "ClaimAmbiguous" } });
    expect(attempts).toBe(1);
    expect(fixture.saved).toHaveLength(0);
  })
);
