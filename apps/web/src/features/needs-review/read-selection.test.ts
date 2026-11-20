import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { prepareKnownReviewPage, reviewPageContextSource } from "./page-context-query";
import { reviewNavigationQuery } from "./navigation-query";
import { prepareReviewWorkspace, reviewWorkspaceQueries } from "./query";

it.live("does not fetch source context for an empty page", () =>
  Effect.gen(function* () {
    let reads = 0;
    const http = HttpClient.make((request) => {
      reads++;
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ data: { items: [] }, next: [] }))
      );
    });
    const client = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, http),
    });
    const registry = AtomRegistry.make();
    try {
      const empty = reviewPageContextSource({ client, filter: "pending", page: 0, ids: [] });
      expect((yield* AtomRegistry.getResult(registry, registry.get(empty))).data.items).toEqual([]);
      expect(reads).toBe(0);
      const selected = reviewPageContextSource({
        client,
        filter: "pending",
        page: 0,
        ids: ["10000000-0000-4000-8000-000000000001"],
      });
      yield* AtomRegistry.getResult(registry, registry.get(selected));
      expect(reads).toBe(1);
    } finally {
      registry.dispose();
    }
  })
);

it.live("reads navigation counts from the mounted workspace selection", () =>
  Effect.gen(function* () {
    let reads = 0;
    const http = HttpClient.make((request) => {
      reads++;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ data: { pendingCount: 3, total: 0, items: [] }, next: [] })
        )
      );
    });
    const client = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(HttpClient.HttpClient, http),
    });
    const registry = AtomRegistry.make();
    try {
      const selection = { filter: "history", page: 25 } as const;
      const workspace = reviewWorkspaceQueries({ client, ...selection });
      const navigation = reviewNavigationQuery({ client, selection: Option.some(selection) });
      const unmount = registry.mount(workspace.active);
      try {
        yield* AtomRegistry.getResult(registry, workspace.active);
        expect((yield* AtomRegistry.getResult(registry, navigation)).data.pendingCount).toBe(3);
        expect(reads).toBe(1);
      } finally {
        unmount();
      }
    } finally {
      registry.dispose();
    }
  })
);

it.live(
  "shares the private excerpts prepared for a populated review page with its mounted inbox",
  () =>
    Effect.gen(function* () {
      const id = "10000000-0000-4000-8000-000000000001";
      const deadline = "2099-01-02T00:00:00Z";
      const paths: string[] = [];
      const http = HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        const data = path.endsWith("/context")
          ? { items: [{ id, reference: "Fila 51", expiresAt: deadline, excerpt: "Compra" }] }
          : {
              pendingCount: 51,
              total: 51,
              items: [
                {
                  id,
                  source: "statement",
                  status: "pending",
                  reason: "mapping-unavailable",
                  revision: 0,
                  timeZone: "America/Bogota",
                  createdAt: "2026-01-01T00:00:00Z",
                  expiresAt: deadline,
                },
              ],
            };
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data, next: [] }))
        );
      });
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });
      const registry = AtomRegistry.make();
      try {
        const selection = { filter: "pending", page: 50 } as const;
        yield* Effect.tryPromise(() =>
          prepareReviewWorkspace({
            ...selection,
            apiClient: client,
            registry,
            signal: new AbortController().signal,
          })
        );
        const expected = ["/ingestion/review-workspace", "/ingestion/review-workspace/context"];
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(paths).toEqual(expected)));
        const mounted = reviewPageContextSource({ client, ...selection, ids: [id] });
        const response = yield* AtomRegistry.getResult(registry, registry.get(mounted));
        expect(response.data.items[0]?.excerpt).toEqual(Option.some("Compra"));
        expect(paths).toEqual(expected);
      } finally {
        registry.dispose();
      }
    })
);

it.live(
  "rereads a changed page when an activated excerpt response belongs to the preceding membership",
  () =>
    Effect.gen(function* () {
      const oldId = "10000000-0000-4000-8000-000000000001";
      const currentId = "10000000-0000-4000-8000-000000000002";
      let id = oldId;
      let requests = 0;
      const http = HttpClient.make((request) => {
        requests++;
        const items = [
          { id, reference: "Fila 51", expiresAt: "2099-01-02T00:00:00Z", excerpt: id },
        ];
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ data: { items }, next: [] }))
        );
      });
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(HttpClient.HttpClient, http),
      });
      const selection = { client, filter: "pending", page: 50 } as const;
      const registry = AtomRegistry.make();
      try {
        yield* Effect.tryPromise(() => prepareKnownReviewPage({ ...selection, registry }));
        id = currentId;
        const query = reviewPageContextSource({ ...selection, ids: [currentId] });
        const result = yield* AtomRegistry.getResult(registry, registry.get(query));
        expect(result.data.items.map((entry) => entry.excerpt)).toEqual([Option.some(currentId)]);
        expect(requests).toBe(2);
      } finally {
        registry.dispose();
      }
    })
);
