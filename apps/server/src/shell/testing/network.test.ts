import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { availableLoopbackPort } from "./network";

it.effect("allocates distinct operating-system-selected loopback ports", () =>
  Effect.gen(function* () {
    const ports = yield* Effect.all([availableLoopbackPort, availableLoopbackPort], {
      concurrency: "unbounded",
    });

    expect(new Set(ports).size).toBe(2);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65_535);
    }
  })
);
