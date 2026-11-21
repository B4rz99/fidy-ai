import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { runFleetPilot } from "./native-fleet-pilot";

const listed = (stored: boolean): Map<string, boolean> => {
  const rows = new Map([
    ["probe", true],
    ["one", true],
    ["two", true],
  ]);

  if (stored) rows.set("new", true);

  return rows;
};

it.effect("erases its one new physical User if metering stops during observation", () =>
  Effect.gen(function* () {
    let stored = false;
    let registrations = 0;
    let erased = 0;

    const result = yield* Effect.exit(
      runFleetPilot({
        inventory: () => Effect.sync(() => listed(stored)),
        register: () =>
          Effect.sync(() => {
            stored = true;
            registrations++;

            return {
              id: "original",
              outcome: "created",
              erase: (): Effect.Effect<never, Error> =>
                Effect.fail(Error("signup session is stale")),
              denied: (): Effect.Effect<void> => Effect.void,
            };
          }),
        login: () =>
          Effect.succeed({
            id: "original",
            outcome: "approved",
            erase: () =>
              Effect.sync(() => {
                erased++;
                stored = false;

                return "reference";
              }),
            denied: () => Effect.void,
          }),
        beforeSignup: () => Effect.void,
        renewCleanup: () => Effect.void,
        renew: () => Effect.void,
        watch: () => Effect.fail(Error("quota")),
        record: () => Effect.void,
      })
    );

    expect(result._tag).toBe("Failure");
    expect({ registrations, erased, stored }).toEqual({
      registrations: 1,
      erased: 1,
      stored: false,
    });
  })
);

it.effect("recovers an established pilot session for cleanup after a lost signup reply", () =>
  Effect.gen(function* () {
    let stored = false;
    let cleaned = false;

    const result = yield* Effect.exit(
      runFleetPilot({
        inventory: () => Effect.sync(() => listed(stored)),
        register: () =>
          Effect.sync(() => {
            stored = true;
          }).pipe(Effect.andThen(Effect.fail(Error("reply lost")))),
        login: () =>
          Effect.succeed({
            id: "original",
            outcome: "approved",
            erase: (): Effect.Effect<string> =>
              Effect.sync(() => {
                cleaned = true;
                stored = false;

                return "reference";
              }),
            denied: (): Effect.Effect<void> => Effect.void,
          }),
        beforeSignup: () => Effect.void,
        renewCleanup: () => Effect.void,
        renew: () => Effect.void,
        watch: () => Effect.die("Unexpected trial after incomplete signup"),
        record: () => Effect.void,
      })
    );

    expect(result._tag).toBe("Failure");
    expect(cleaned).toBe(true);
  })
);

it.effect(
  "waits through delayed baseline, enrollment and physical disposal for one signed member",
  () =>
    Effect.gen(function* () {
      let rows = new Map<string, boolean>();

      let signups = 0,
        erasures = 0;

      const stages: string[] = [];

      const completed = yield* runFleetPilot({
        inventory: () => Effect.sync(() => new Map(rows)),
        register: () =>
          Effect.sync(() => {
            signups++;

            return {
              id: "original",
              outcome: "created",
              erase: (): Effect.Effect<never, Error> =>
                Effect.fail(Error("signup session is stale")),
              denied: (): Effect.Effect<void> => Effect.void,
            };
          }),
        login: () =>
          Effect.succeed({
            id: "original",
            outcome: "approved",
            erase: () =>
              Effect.sync(() => {
                erasures++;

                return "original";
              }),
            denied: () => Effect.void,
          }),
        beforeSignup: () => Effect.void,
        renewCleanup: () => Effect.void,
        renew: () => Effect.void,
        watch: (physical) =>
          Effect.sync(() => expect(physical).toBe("pilot")).pipe(
            Effect.andThen(Effect.sleep("10 minutes"))
          ),
        record: (event) =>
          Effect.sync(() => {
            stages.push(String(event["stage"]));
          }),
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("8 minutes");
      expect(signups).toBe(0);
      rows = new Map([
        ["probe", true],
        ["one", true],
        ["two", true],
      ]);
      yield* TestClock.adjust("8 minutes");
      expect(signups).toBe(1);
      rows.set("pilot", true);
      yield* TestClock.adjust("11 minutes");
      expect(erasures).toBe(1);
      yield* TestClock.adjust("8 minutes");
      rows.set("pilot", false);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(completed);

      for (const stage of [
        "waiting-baseline",
        "waiting-fresh-object",
        "waiting-physical-erasure",
        "physically-erased",
      ]) {
        expect(stages).toContain(stage);
      }

      expect({ signups, erasures }).toEqual({ signups: 1, erasures: 1 });
    })
);

it.effect(
  "refuses before signup and before renewing a lease when the refreshed reserve is missing",
  () =>
    Effect.gen(function* () {
      const stages: string[] = [];

      const result = yield* Effect.result(
        runFleetPilot({
          inventory: () => Effect.succeed(listed(false)),
          beforeSignup: () => Effect.fail(Error("insufficient headroom")),
          register: () => Effect.die("Unexpected signup"),
          login: () => Effect.die("Unexpected login"),
          renew: () => Effect.die("Unexpected work lease"),
          renewCleanup: () => Effect.die("Unexpected cleanup lease"),
          watch: () => Effect.die("Unexpected observation window"),
          record: (event) =>
            Effect.sync(() => {
              stages.push(String(event["stage"]));
            }),
        })
      );

      expect(result._tag).toBe("Failure");
      expect(stages).not.toContain("signup-started");
    })
);

it.effect("refuses to erase a different User returned by login", () =>
  Effect.gen(function* () {
    let registered = false;
    let erased = false;

    const browser = {
      erase: (): Effect.Effect<string> =>
        Effect.sync(() => {
          erased = true;

          return "reference";
        }),
      denied: (): Effect.Effect<void> => Effect.void,
    };

    const verdict = yield* runFleetPilot({
      register: () =>
        Effect.sync(() => {
          registered = true;

          return { ...browser, id: "original", outcome: "created" };
        }),
      login: () => Effect.succeed({ ...browser, id: "other", outcome: "approved" }),
      inventory: () => Effect.succeed(listed(registered)),
      beforeSignup: () => Effect.void,
      renew: () => Effect.void,
      renewCleanup: () => Effect.void,
      record: () => Effect.void,
      watch: () => Effect.void,
    }).pipe(Effect.result);

    expect(verdict._tag).toBe("Failure");
    expect(erased).toBe(false);
  })
);
