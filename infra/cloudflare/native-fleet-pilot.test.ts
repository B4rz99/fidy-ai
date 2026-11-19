import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { runFleetPilot } from "./native-fleet-pilot";

it.effect("erases its one new physical User if metering stops during observation", () =>
  Effect.gen(function* () {
    let stored = false;
    let registrations = 0;
    let erased = 0;
    const result = yield* Effect.exit(runFleetPilot({
      inventory: () => Effect.succeed(stored ? new Map([["new", true]]) : new Map<string, boolean>()),
      register: () => Effect.sync(() => {
        stored = true;
        registrations++;
        return {
          outcome: "created",
          erase: () => Effect.sync(() => { erased++; stored = false; return "reference"; }),
          denied: () => Effect.void,
        };
      }),
      renew: () => Effect.void,
      watch: () => Effect.fail(Error("quota")),
      record: () => Effect.void,
    }));
    expect(result._tag).toBe("Failure");
    expect({ registrations, erased, stored }).toEqual({ registrations: 1, erased: 1, stored: false });
  })
);
