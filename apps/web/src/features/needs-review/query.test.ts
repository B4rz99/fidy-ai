import { reviewPendingCountQuery } from "./navigation-query";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vitest";
import { type FidyClient, makeFidyClient } from "@/transport/client";
import { reviewWorkspaceQueries } from "./query";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const countQueries = (client: FidyClient): ReturnType<typeof reviewWorkspaceQueries> => {
  const active = reviewPendingCountQuery(client);
  return { source: active, active };
};
it.live.each(["workspace", "count"] as const)(
  "shares %s reads, coalesces focus while waiting, and refreshes again after completion",
  (projection) =>
    Effect.gen(function* () {
      const window = Object.assign(new EventTarget(), { Uint8Array });
      vi.stubGlobal("window", window);
      vi.stubGlobal("document", { visibilityState: "visible" });
      const gate = yield* Deferred.make<void>();
      let reads = 0;
      let held = false;
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          reads += 1;
          if (held) yield* Deferred.await(gate);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ data: { pendingCount: 0, total: 0, items: [] }, next: [] })
          );
        })
      );
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });
      const registry = AtomRegistry.make();
      const badge =
        projection === "count"
          ? countQueries(client)
          : reviewWorkspaceQueries({
              client,
              filter: "pending",
              page: 0,
            });
      const panel =
        projection === "count"
          ? countQueries(client)
          : reviewWorkspaceQueries({
              client,
              filter: "pending",
              page: 0,
            });
      expect(panel.source).toBe(badge.source);
      expect(panel.active).toBe(badge.active);
      // React reads its snapshot during render, before subscribing in the commit.
      registry.get(badge.active);
      yield* Effect.sleep("20 millis");
      const unmount = [registry.mount(badge.active), registry.mount(panel.active)];
      try {
        yield* AtomRegistry.getResult(registry, panel.active);
        expect(reads).toBe(1);
        held = true;
        window.dispatchEvent(new Event("focus"));
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(2)));
        window.dispatchEvent(new Event("visibilitychange"));
        yield* Effect.sleep("20 millis");
        expect(reads).toBe(2);
        held = false;
        yield* Deferred.succeed(gate, undefined);
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(registry.get(panel.active).waiting).toBe(false))
        );
        window.dispatchEvent(new Event("focus"));
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(3)));
      } finally {
        for (const dispose of unmount) dispose();
        registry.dispose();
        vi.unstubAllGlobals();
      }
    })
);

it.live("polls remote Review counts without item rows and stops with its registry", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    vi.stubGlobal("window", Object.assign(new EventTarget(), { Uint8Array }));
    vi.stubGlobal("document", { visibilityState: "visible" });
    let pending = 0;
    let reads = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        expect(request.urlParams).toContainEqual(["limit", "0"]);
        reads += 1;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ data: { pendingCount: pending, total: pending, items: [] }, next: [] })
        );
      })
    );
    const client = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, http),
    });
    const registry = AtomRegistry.make();
    const query = reviewPendingCountQuery(client);
    const unmount = registry.mount(query);
    try {
      const initial = yield* Effect.forkChild(AtomRegistry.getResult(registry, query));
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(0));
      expect((yield* Fiber.join(initial)).data.pendingCount).toBe(0);
      pending = 1;
      yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(60000));
      expect(AsyncResult.getOrThrow(registry.get(query)).data.pendingCount).toBe(1);
      expect(reads).toBe(2);
    } finally {
      unmount();
      registry.dispose();
    }
    yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(60000));
    expect(reads).toBe(2);
  })
);
