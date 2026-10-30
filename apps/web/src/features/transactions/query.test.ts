import { afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeFidyClient } from "@/transport/client";
import { transactionFirstPage, transactionPageInitialValue } from "./query";

afterEach(() => vi.unstubAllGlobals());
it.live(
  "uses the handed-off page across asynchronous mount and equivalent period objects; another month and refresh read HTTP",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", Object.assign(new EventTarget(), { Uint8Array }));
      let reads = 0;
      const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          reads += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ data: [], next: [] }))
          );
        })
      );
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: transport,
      });
      const from = DateTime.makeUnsafe("2026-10-01T05:00:00Z");
      const to = DateTime.makeUnsafe("2026-11-01T05:00:00Z");
      const observation = { from, to, page: { data: [], next: [] } };
      const registry = AtomRegistry.make({
        initialValues: [transactionPageInitialValue(client, observation, Date.now())],
      });
      try {
        yield* Effect.sleep("5 millis");
        const period = {
          from: DateTime.makeUnsafe(DateTime.formatIso(from)),
          to: DateTime.makeUnsafe(DateTime.formatIso(to)),
          timeZone: "America/Bogota",
        };
        const query = transactionFirstPage(client, period);
        const anotherActor = makeFidyClient({
          apiOrigin: "https://api.test.fidyapp.com",
          httpClient: transport,
        });
        expect(transactionFirstPage(anotherActor, period)).not.toBe(query);
        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        expect(reads).toBe(0);
        yield* Effect.sleep("450 millis");
        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        expect(reads).toBe(0);
        registry.refresh(query);
        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        expect(reads).toBe(1);
        const next = { from: to, to: DateTime.makeUnsafe("2026-12-01T05:00:00Z") };
        yield* AtomRegistry.getResult(registry, transactionFirstPage(client, next), {
          suspendOnWaiting: true,
        });
        expect(reads).toBe(2);
      } finally {
        registry.dispose();
      }
    })
);
