import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { reviewPageContextQuery } from "./source-context";
import { reviewNavigationQuery } from "./navigation-query";
import { reviewWorkspaceQueries } from "./query";

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
      const empty = reviewPageContextQuery({ client, filter: "pending", page: 0, ids: [] });
      expect((yield* AtomRegistry.getResult(registry, empty)).data.items).toEqual([]);
      expect(reads).toBe(0);
      const selected = reviewPageContextQuery({
        client,
        filter: "pending",
        page: 0,
        ids: ["10000000-0000-4000-8000-000000000001"],
      });
      yield* AtomRegistry.getResult(registry, selected);
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
