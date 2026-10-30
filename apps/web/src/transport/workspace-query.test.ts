import { Clock, Deferred, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { makeFidyClient } from "./client";
import {
  revalidateWorkspaceQuery,
  workspaceCategoriesQuery,
  workspaceMetadataInitialValue,
  workspaceProfileQuery,
} from "./workspace-query";

const metadataResponse = (label: string): Response =>
  new Response(
    JSON.stringify({
      data: {
        id: "10000000-0000-4000-8000-000000000001",
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: "America/Bogota",
        createdAt: "2026-08-01T00:00:00Z",
        trialPeriod: { startedAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-08T00:00:00Z" },
      },
      categories: [{ id: "10000000-0000-4000-8000-000000000002", label }],
      next: [],
    }),
    { headers: { "content-type": "application/json" } }
  );
it.live("shares inline taxonomy with the profile and rereads its owner on explicit recovery", () =>
  Effect.gen(function* () {
    const reads: string[] = [];
    let label = "Mercado";
    const http = HttpClient.make((request) => {
      reads.push(new URL(request.url).pathname);
      return Effect.succeed(HttpClientResponse.fromWeb(request, metadataResponse(label)));
    });
    const client = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, http),
    });
    const registry = AtomRegistry.make();
    const profile = workspaceProfileQuery(client);
    const categories = workspaceCategoriesQuery(client);
    const unmount = [registry.mount(profile), registry.mount(categories.view)];
    try {
      const first = yield* AtomRegistry.getResult(registry, categories.source);
      expect(first.data[0]?.label).toBe("Mercado");
      expect(reads).toEqual(["/user"]);
      label = "Compras";
      registry.refresh(categories.source);
      const second = yield* AtomRegistry.getResult(registry, categories.source, {
        suspendOnWaiting: true,
      });
      expect(second.data[0]?.label).toBe("Compras");
      expect(reads).toEqual(["/user", "/user"]);
    } finally {
      for (const dispose of unmount) {
        dispose();
      }
      registry.dispose();
    }
  })
);
it.live("reuses recent display reads but respects explicit refresh and expiry", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const registry = AtomRegistry.make();
  const cleanup: Array<() => void> = [];
  return Effect.gen(function* () {
    let reads = 0;
    const source = Atom.make(Effect.sync(() => ++reads)).pipe(Atom.setIdleTTL("1 minute"));
    const mount = (): ReturnType<typeof revalidateWorkspaceQuery<number, never>> => {
      const query = revalidateWorkspaceQuery(source);
      cleanup.push(registry.mount(query));
      return query;
    };
    expect(yield* AtomRegistry.getResult(registry, mount())).toBe(1);
    now.mockReturnValue(3000);
    const recent = mount();
    expect(yield* AtomRegistry.getResult(registry, recent)).toBe(1);
    yield* Effect.sleep("20 millis");
    expect(reads).toBe(1);
    registry.refresh(recent);
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(2)));
    now.mockReturnValue(9000);
    mount();
    yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(3)));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const unmount of cleanup) {
          unmount();
        }
        registry.dispose();
        now.mockRestore();
      })
    )
  );
});
it.live("retains prepared metadata while the first fresh read is pending", () =>
  Effect.gen(function* () {
    const observedAt = yield* Clock.currentTimeMillis;
    const release = yield* Deferred.make<void>();
    const initialHttp = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, metadataResponse("Mercado")))
    );
    const initialClient = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, initialHttp),
    });
    const initialRegistry = AtomRegistry.make();
    const initialProfile = workspaceProfileQuery(initialClient);
    const detachInitial = initialRegistry.mount(initialProfile);
    const prepared = yield* AtomRegistry.getResult(initialRegistry, initialProfile);
    detachInitial();
    initialRegistry.dispose();
    let reads = 0;
    const http = HttpClient.make((request) => {
      reads += 1;
      return Deferred.await(release).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, metadataResponse("Compras")))
      );
    });
    const client = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, http),
    });
    const registry = AtomRegistry.make();
    const [slot, value] = workspaceMetadataInitialValue({
      client,
      value: prepared,
      timestamp: observedAt,
    });
    registry.set(slot, value);
    const profile = workspaceProfileQuery(client);
    const detach = registry.mount(profile);
    try {
      expect(yield* AtomRegistry.getResult(registry, profile)).toEqual(prepared);
      expect(reads).toBe(0);
      registry.refresh(profile);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(1)));
      const pending = registry.get(profile);
      expect(pending.waiting).toBe(true);
      expect(Option.getOrThrow(AsyncResult.value(pending))).toEqual(prepared);
      yield* Deferred.succeed(release, undefined);
      const current = yield* AtomRegistry.getResult(registry, profile, { suspendOnWaiting: true });
      expect(Option.getOrThrow(current.categories)[0]?.label).toBe("Compras");
      expect(reads).toBe(1);
    } finally {
      detach();
      registry.dispose();
    }
  })
);

it.live("keeps mounted taxonomy atoms stable through collection and an equivalent lookup", () =>
  Effect.gen(function* () {
    let reads = 0;
    const http = HttpClient.make((request) => {
      reads += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(request, metadataResponse("Mercado")));
    });
    const client = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, http),
    });
    const registry = AtomRegistry.make();
    const { source, view } = workspaceCategoriesQuery(client);
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
      const equivalent = workspaceCategoriesQuery(client);
      expect(equivalent.source).toBe(source);
      expect(equivalent.view).toBe(view);
      mounts.push(registry.mount(equivalent.view));
      yield* Effect.sleep("30 millis");
      expect(reads).toBe(1);
    } finally {
      vi.restoreAllMocks();
      for (const unmount of mounts) unmount();
      registry.dispose();
    }
  })
);
