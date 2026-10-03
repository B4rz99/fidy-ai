import { Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { type PairingClient, PollingDelayed } from "./contract";
import { makeLoginFixture, privateProof, rawBearer, request, started } from "./login.test-fixture";
import { expect, it } from "@effect/vitest";
import { login } from "./operations";
import { CliFailure } from "../credential/contract";

it.effect(
  "waits the advertised cadence, persists before success and exposes only public progress",
  () =>
    Effect.gen(function* () {
      const fixture = makeLoginFixture();
      const output: Array<unknown> = [];
      const fiber = yield* login(
        request,
        (event) =>
          Effect.sync(() => {
            output.push(event);
          }),
        fixture.dependencies
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("4 seconds");
      expect(fixture.claims).toHaveLength(0);
      yield* TestClock.adjust("1 second");
      const grant = yield* Fiber.join(fiber);
      expect(fixture.saved).toHaveLength(1);
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        output,
        grant,
      });
      expect(json).toContain("BCDF-GHJK");
      expect(json).not.toContain(privateProof);
      expect(json).not.toContain(rawBearer);
    })
);

it.effect("respects slowdown without retrying before its interval", () =>
  Effect.gen(function* () {
    const fixture = makeLoginFixture();
    let claims = 0;
    const pairing: PairingClient = {
      ...fixture.dependencies.pairing,
      claim: () => {
        claims += 1;
        return claims === 1
          ? Effect.fail(new PollingDelayed({ retryAfterSeconds: 10 }))
          : fixture.dependencies.pairing.claim(started);
      },
    };
    const fiber = yield* login(request, () => Effect.void, {
      ...fixture.dependencies,
      pairing,
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    yield* TestClock.adjust("9 seconds");
    expect(claims).toBe(1);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(claims).toBe(2);
  })
);

it.effect("does not replay a claimed bearer or report a failed save as success", () =>
  Effect.gen(function* () {
    const fixture = makeLoginFixture();
    const failedStore: typeof fixture.dependencies.store = {
      ...fixture.dependencies.store,
      save: () => Effect.fail(new CliFailure({ reason: "StorageUnavailable" })),
    };
    const fiber = yield* login(request, () => Effect.void, {
      ...fixture.dependencies,
      store: failedStore,
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fixture.claims).toHaveLength(1);
  })
);

it.effect("refuses unavailable native storage before starting any pairing", () =>
  Effect.gen(function* () {
    let started = false;
    const result = yield* Effect.exit(
      login({ recipientLabel: "Mi agente", scopes: ["read"], lifetimeDays: 7 }, () => Effect.void, {
        verifyStorage: Effect.fail(new CliFailure({ reason: "StorageUnavailable" })),
        store: {
          load: Effect.die("not reached"),
          save: () => Effect.die("not reached"),
          clear: Effect.die("not reached"),
        },
        pairing: {
          start: () =>
            Effect.sync(() => {
              started = true;
            }).pipe(Effect.andThen(Effect.die("not reached"))),
          claim: () => Effect.die("not reached"),
        },
      })
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(started).toBe(false);
  })
);
