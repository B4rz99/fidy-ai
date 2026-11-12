import { it } from "@effect/vitest";
import { createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { Array, Deferred, Effect, Layer, Option } from "effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect, vi } from "vitest";
import { makeFidyClient } from "@/transport/client";
import { retireQueryLifetime } from "@/transport/query-lifetime";
import { type DashboardReadAttempt, dashboardQuery } from "./query";

const view = {
  title: "Mi tablero",
  context: {
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    calculatedAt: "2026-10-11T12:00:00Z",
  },
  layout: {
    kind: "leaf",
    widget: {
      widget: {
        id: "24000000-0000-4000-8000-000000000255",
        type: "spending-chart",
        groupBy: "category",
        period: "this-month",
      },
      result: {
        appliedPeriod: {
          requested: "this-month",
          from: "2026-10-01T05:00:00Z",
          toExclusive: "2026-11-01T05:00:00Z",
          timeZone: "America/Bogota",
        },
        buckets: [],
      },
    },
  },
};
const requiredGate = (
  gates: readonly Deferred.Deferred<void>[],
  index: number
): Deferred.Deferred<void> => Option.getOrThrow(Array.get(gates, index));
const retireAuthentication = Effect.fnUntraced(function* (
  registry: AtomRegistry.AtomRegistry,
  attempts: readonly DashboardReadAttempt[],
  held: Deferred.Deferred<void>
) {
  retireQueryLifetime(registry);
  expect(attempts.every((attempt) => !attempt.completed())).toBe(true);
  yield* Deferred.succeed(held, undefined);
  yield* Effect.yieldNow;
  expect(attempts.every((attempt) => !attempt.completed())).toBe(true);
});
it.live("only the requested new Dashboard load certifies recovery, even with equal content", () =>
  Effect.gen(function* () {
    const events = Object.assign(new EventTarget(), { Uint8Array });
    vi.stubGlobal("window", events);
    const gates = yield* Effect.all([
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
    ]);
    let reads = 0;
    const client = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const index = reads++;
          const gate = gates[index];
          if (gate === undefined) return Effect.die("Unexpected Dashboard read");
          return Deferred.await(gate).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                index === 5
                  ? new Response(null, { status: 503 })
                  : Response.json({ data: view, next: [] })
              )
            )
          );
        })
      ),
    });
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/app/dashboard"] }),
    });
    const query = dashboardQuery({ apiClient: client, router });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(query.result);
    try {
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(1)));
      const first = requiredGate(gates, 0);
      yield* Deferred.succeed(first, undefined);
      const baseline = yield* AtomRegistry.getResult(registry, query.result).pipe(Effect.orDie);
      registry.refresh(query.result);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(2)));
      const attempt = query.refresh(registry);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(3)));
      const old = requiredGate(gates, 1);
      const fresh = requiredGate(gates, 2);
      yield* Deferred.succeed(old, undefined);
      expect(registry.get(query.result).waiting).toBe(true);
      yield* Deferred.succeed(fresh, undefined);
      const recovered = yield* AtomRegistry.getResult(registry, query.result, {
        suspendOnWaiting: true,
      }).pipe(Effect.orDie);
      expect(recovered.data).toEqual(baseline.data);
      expect(attempt.completed()).toBe(true);
      const superseded = query.refresh(registry);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(4)));
      registry.refresh(query.result);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(5)));
      const abandoned = requiredGate(gates, 3);
      const replacement = requiredGate(gates, 4);
      yield* Deferred.succeed(abandoned, undefined);
      expect(registry.get(query.result).waiting).toBe(true);
      yield* Deferred.succeed(replacement, undefined);
      const later = yield* AtomRegistry.getResult(registry, query.result, {
        suspendOnWaiting: true,
      }).pipe(Effect.orDie);
      expect(later.data).toEqual(baseline.data);
      expect(superseded.completed()).toBe(false);
      expect(attempt.completed()).toBe(true);
      const failed = query.refresh(registry);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(6)));
      const failure = requiredGate(gates, 5);
      yield* Deferred.succeed(failure, undefined);
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(registry.get(query.result).waiting).toBe(false))
      );
      const result = registry.get(query.result);
      expect(result._tag).toBe("Failure");
      expect(failed.completed()).toBe(false);
      expect(Option.map(AsyncResult.value(result), (value) => value.data)).toEqual(
        Option.some(baseline.data)
      );
      const retired = query.refresh(registry);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(7)));
      yield* retireAuthentication(registry, [attempt, retired], requiredGate(gates, 6));
      unmount();
      registry.dispose();
      const replacementRegistry = AtomRegistry.make();
      const detach = replacementRegistry.mount(query.result);
      try {
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(8)));
        const retiredGate = requiredGate(gates, 6);
        const replacementGate = requiredGate(gates, 7);
        yield* Deferred.succeed(retiredGate, undefined);
        expect(replacementRegistry.get(query.result).waiting).toBe(true);
        yield* Deferred.succeed(replacementGate, undefined);
        const current = yield* AtomRegistry.getResult(replacementRegistry, query.result, {
          suspendOnWaiting: true,
        }).pipe(Effect.orDie);
        expect(current.data).toEqual(baseline.data);
        expect(retired.completed()).toBe(false);
      } finally {
        detach();
        replacementRegistry.dispose();
      }
    } finally {
      unmount();
      registry.dispose();
      vi.unstubAllGlobals();
    }
  })
);
