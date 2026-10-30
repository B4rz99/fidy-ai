import { Deferred, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { reviewWorkspaceQueries } from "./query";

it.live(
  "shares Review reads, coalesces focus while waiting, and refreshes again after completion",
  () =>
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
            new Response(
              JSON.stringify({ data: { pendingCount: 0, total: 0, items: [] }, next: [] }),
              {
                headers: { "content-type": "application/json" },
              }
            )
          );
        })
      );
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });
      const registry = AtomRegistry.make();
      const badge = reviewWorkspaceQueries(client, "pending", 0);
      const panel = reviewWorkspaceQueries(client, "pending", 0);
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
