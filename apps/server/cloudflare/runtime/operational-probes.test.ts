import { Effect } from "effect";
import { expect, it } from "vitest";
import { inspectOperationalCapabilities } from "./operational-probes";

it("distinguishes reachable Worker metadata from D1, coordinator, bindings, and provider configuration", async () => {
  const result = await Effect.runPromise(
    inspectOperationalCapabilities({
      d1: {
        prepare: (): { first: () => Promise<{ usable: number }> } => ({
          first: async () => ({ usable: 1 }),
        }),
      },
      coordinator: {
        getByName: (): { fetch: () => Promise<Response> } => ({
          fetch: async () => new Response(null, { status: 503 }),
        }),
      },
      requiredBindings: [true, false],
      providerConfigured: true,
    })
  );
  expect(result).toEqual([
    { component: "capability", operation: "d1", state: "healthy" },
    { component: "capability", operation: "requiredBindings", state: "unavailable" },
    { component: "capability", operation: "coordination", state: "unavailable" },
    { component: "capability", operation: "providerConfig", state: "healthy" },
  ]);
});

it("never substitutes a zero or a green result when D1 is unreachable", async () => {
  const result = await Effect.runPromise(
    inspectOperationalCapabilities({
      d1: {
        prepare: () => {
          throw new Error("sensitive SQL error");
        },
      },
      coordinator: {
        getByName: (): { fetch: () => Promise<Response> } => ({
          fetch: async () => new Response(null, { status: 204 }),
        }),
      },
      requiredBindings: [true],
      providerConfigured: false,
    })
  );
  expect(result.map(({ operation, state }) => ({ operation, state }))).toEqual([
    { operation: "d1", state: "unavailable" },
    { operation: "requiredBindings", state: "healthy" },
    { operation: "coordination", state: "healthy" },
    { operation: "providerConfig", state: "unavailable" },
  ]);
  expect(JSON.stringify(result)).not.toContain("sensitive");
});
