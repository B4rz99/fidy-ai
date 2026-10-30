import { expect, it, vi } from "vitest";
import { Clock, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { makeFidyClient } from "@/transport/client";
import { recurringWorkspaceQuery } from "./controller";

it("retains the prepared recurring display source across equivalent render inputs", () => {
  const client = makeFidyClient({ apiOrigin: "https://api.test.fidyapp.com" });
  const prepared = recurringWorkspaceQuery({
    apiClient: client,
    query: { month: "2026-10", view: "compact" },
  });
  const rendered = recurringWorkspaceQuery({
    apiClient: client,
    query: { month: "2026-10", view: "compact" },
  });
  expect(rendered.view).toBe(prepared.view);
  expect(rendered.source).toBe(prepared.source);
  expect(
    recurringWorkspaceQuery({
      apiClient: client,
      query: { month: "2026-11", view: "compact" },
    }).view
  ).not.toBe(prepared.view);
});

it("keeps the mounted Recurring query owner through garbage collection and a local rerender", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      const http = HttpClient.make((request) => {
        reads += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: {
                document: {
                  revision: 0,
                  plans: [],
                  exceptions: [],
                  fulfillments: [],
                  excludedTransactionIds: [],
                  suggestions: [],
                },
                month: "2026-10",
                today: "2026-10-29",
                occurrences: [],
                previous: [],
                summary: [],
                invalidFulfillmentIds: [],
                matches: [],
                matchesComplete: true,
              },
              next: [],
            })
          )
        );
      });
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });
      const registry = AtomRegistry.make();
      const { source, view } = recurringWorkspaceQuery({
        apiClient: client,
        query: { month: "2026-10", view: "compact" },
      });
      const mounts = [registry.mount(view)];
      try {
        yield* AtomRegistry.getResult(registry, view);
        expect(reads).toBe(1);
        for (let turn = 0; turn < 5; turn += 1) {
          yield* Effect.sleep("20 millis");
          Bun.gc(true);
        }
        const now = yield* Clock.currentTimeMillis;
        vi.spyOn(Date, "now").mockReturnValue(now + 6000);
        const rerendered = recurringWorkspaceQuery({
          apiClient: client,
          query: { month: "2026-10", view: "compact" },
        });
        expect(rerendered.source).toBe(source);
        expect(rerendered.view).toBe(view);
        mounts.push(registry.mount(rerendered.view));
        yield* Effect.sleep("30 millis");
        expect(reads).toBe(1);
      } finally {
        vi.restoreAllMocks();
        for (const unmount of mounts) unmount();
        registry.dispose();
      }
    })
  ));
