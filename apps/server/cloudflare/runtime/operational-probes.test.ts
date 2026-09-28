import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { inspectOperationalCapabilities } from "./operational-probes";

it.effect(
  "distinguishes reachable Worker metadata from D1, coordinator, bindings, and provider configuration",
  () =>
    Effect.gen(function* () {
      const result = yield* inspectOperationalCapabilities({
        d1: {
          prepare: (): { first: () => Promise<{ usable: number }> } => ({
            first: () => Promise.resolve({ usable: 1 }),
          }),
        },
        coordinator: {
          getByName: (): { fetch: () => Promise<Response> } => ({
            fetch: () => Promise.resolve(new Response(null, { status: 503 })),
          }),
        },
        requiredBindings: [true, false],
        providerConfigured: true,
      });
      expect(result).toEqual([
        { component: "capability", operation: "d1", state: "healthy" },
        { component: "capability", operation: "requiredBindings", state: "unavailable" },
        { component: "capability", operation: "coordination", state: "unavailable" },
        { component: "capability", operation: "providerConfig", state: "healthy" },
      ]);
    })
);

it.effect("never substitutes a zero or a green result when D1 is unreachable", () =>
  Effect.gen(function* () {
    const result = yield* inspectOperationalCapabilities({
      d1: {
        prepare: () => {
          throw new Error("sensitive SQL error");
        },
      },
      coordinator: {
        getByName: (): { fetch: () => Promise<Response> } => ({
          fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        }),
      },
      requiredBindings: [true],
      providerConfigured: false,
    });
    expect(result.map(({ operation, state }) => ({ operation, state }))).toEqual([
      { operation: "d1", state: "unavailable" },
      { operation: "requiredBindings", state: "healthy" },
      { operation: "coordination", state: "healthy" },
      { operation: "providerConfig", state: "unavailable" },
    ]);
    const rendered = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result);
    expect(rendered).not.toContain("sensitive");
  })
);
