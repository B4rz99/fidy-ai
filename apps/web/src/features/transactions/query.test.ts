import { readFreshQuery } from "@/transport/fresh-query";
import { Clock, DateTime, Effect, Layer, Option, Schema } from "effect";
import { afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { AtomRegistry } from "effect/reactivity";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { makeFidyClient } from "@/transport/client";
import { transactionRouteHistory } from "./route-history";
import { TransactionSearch } from "./period";
import { transactionHistory } from "./history";
import { transactionFirstPage, transactionPageInitialValue } from "./query";

afterEach(() => vi.unstubAllGlobals());
it.live(
  "uses the handed-off page across asynchronous mount and equivalent period objects; another month and refresh read HTTP",
  () =>
    Effect.gen(function* () {
      const observedAt = yield* Clock.currentTimeMillis;
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
        initialValues: [
          transactionPageInitialValue({
            client,
            page: observation,
            timestamp: observedAt,
          }),
        ],
      });
      try {
        yield* Effect.sleep("5 millis");
        const period = {
          from: DateTime.makeUnsafe(DateTime.formatIso(from)),
          to: DateTime.makeUnsafe(DateTime.formatIso(to)),
          timeZone: "America/Bogota",
        };
        const query = transactionFirstPage({
          client,
          period,
        });
        const anotherActor = makeFidyClient({
          apiOrigin: "https://api.test.fidyapp.com",
          httpClient: transport,
        });
        expect(
          transactionFirstPage({
            client: anotherActor,
            period,
          })
        ).not.toBe(query);
        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        expect(reads).toBe(0);
        yield* Effect.sleep("450 millis");
        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        expect(reads).toBe(0);
        registry.refresh(query);
        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        expect(reads).toBe(1);
        const next = { from: to, to: DateTime.makeUnsafe("2026-12-01T05:00:00Z") };
        yield* AtomRegistry.getResult(
          registry,
          transactionFirstPage({
            client,
            period: next,
          }),
          {
            suspendOnWaiting: true,
          }
        );
        expect(reads).toBe(2);
      } finally {
        registry.dispose();
      }
    })
);

it.live(
  "bounds automatic location reads and retains ordinary continuation after finding the target",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", Object.assign(new EventTarget(), { Uint8Array }));
      const from = DateTime.makeUnsafe("2026-09-01T05:00:00Z");
      const to = DateTime.makeUnsafe("2026-10-01T05:00:00Z");
      const target = "25000000-0000-4000-8000-000000000021";
      const reads: Array<string> = [];
      let failPage = false;
      const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const cursor = Option.getOrElse(
            UrlParams.getFirst(request.urlParams, "cursor"),
            () => ""
          );
          const page = Number(cursor.slice(-2)) + 1;
          const id = `25000000-0000-4000-8000-${String(page).padStart(12, "0")}`;
          reads.push(id);
          if (failPage) {
            return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  {
                    id,
                    categoryId: "24000000-0000-4000-8000-000000000242",
                    money: { amount: "25000", currency: "COP" },
                    direction: "outflow",
                    occurredAt: "2026-09-30T12:00:00Z",
                    createdAt: "2026-11-02T12:00:00Z",
                    revision: 0,
                  },
                ],
                next: [
                  {
                    tool: "transactions.listTransactions",
                    hint: "Continue browsing your FinancialRecord.",
                    args: {
                      query: {
                        from: "2026-09-01T05:00:00Z",
                        to: "2026-10-01T05:00:00Z",
                        cursor: `2026-09-30T12:00:00.000Z|2026-11-02T12:00:00.000Z|${id}`,
                      },
                    },
                  },
                ],
              })
            )
          );
        })
      );
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: transport,
      });
      const firstPage = transactionFirstPage({ client, period: { from, to } });
      const history = transactionHistory({
        initialPages: 1,
        apiClient: client,
        firstPage,
        period: { from, to },
        locate: Option.some(target),
      });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(history.state);
      try {
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => {
            const state = registry.get(history.state);
            expect(state.continuation).toBe("available");
            if (state.query._tag !== "Ready") throw new Error("History is not ready");
            expect(state.query.value.data).toHaveLength(20);
          })
        );
        expect(reads).toHaveLength(20);
        registry.set(history.action, registry.get(history.state).more);
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => {
            const state = registry.get(history.state);
            if (state.query._tag !== "Ready") throw new Error("History is not ready");
            expect(state.query.value.data.at(-1)?.id).toBe(target);
            expect(state.continuation).toBe("available");
          })
        );
        expect(reads).toHaveLength(21);
        const captured = registry.get(history.state).more;
        registry.set(history.action, captured);
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toHaveLength(22)));
        registry.set(history.action, captured);
        yield* Effect.sleep("10 millis");
        expect(reads).toHaveLength(22);
        failPage = true;
        registry.set(history.action, registry.get(history.state).more);
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(registry.get(history.state).continuation).toBe("failure"))
        );
        expect(registry.get(history.state).location).toBe("Located");
      } finally {
        unmount();
        registry.dispose();
      }
    })
);

it.live(
  "reset rereads the addressed effective Transaction before selecting its corrected month; failed lookup never means absence",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", Object.assign(new EventTarget(), { Uint8Array }));
      const addressed = "25000000-0000-4000-8000-000000000011";
      const replacement = "25000000-0000-4000-8000-000000000012";
      let current = { id: addressed, occurredAt: "2026-09-30T12:00:00Z" };
      let failLookup = false;
      const requests: Array<string> = [];
      const row = (): Record<string, unknown> => ({
        ...current,
        categoryId: "24000000-0000-4000-8000-000000000242",
        money: { amount: "25000", currency: "COP" },
        direction: "outflow",
        createdAt: "2026-11-02T12:00:00Z",
        revision: 1,
      });
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const lookup = request.url.endsWith(`/${addressed}`);
            requests.push(
              lookup
                ? "lookup"
                : Option.getOrElse(
                    UrlParams.getFirst(request.urlParams, "from"),
                    () => "missing period"
                  )
            );
            if (lookup && failLookup) {
              return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  lookup
                    ? {
                        data: {
                          ...row(),
                          presentation: { kind: "independent" },
                          reconciliation: { kind: "independent" },
                          sources: [],
                        },
                        next: [],
                      }
                    : { data: [row()], next: [] }
                )
              )
            );
          })
        ),
      });
      const history = transactionRouteHistory({
        client,
        search: yield* Schema.decodeEffect(TransactionSearch)({ transaction: addressed }),
        timeZone: "America/Bogota",
        now: DateTime.makeUnsafe("2026-11-10T12:00:00Z"),
        initialPages: 1,
      });
      expect(requests).toEqual([]);
      const registry = AtomRegistry.make();
      const unmount = registry.mount(history.state);
      try {
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(registry.get(history.state).location).toBe("Located"))
        );
        expect(requests).toEqual(["lookup", "2026-09-01T05:00:00.000Z"]);
        current = { id: replacement, occurredAt: "2026-10-02T12:00:00Z" };
        registry.set(history.action, "reset");
        expect(registry.get(history.state).location).not.toBe("Located");
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(registry.get(history.state).location).toBe("Located"))
        );
        const state = registry.get(history.state);
        expect(Option.getOrThrow(state.locate)).toBe(replacement);
        expect(DateTime.formatIso(state.period.from)).toBe("2026-10-01T05:00:00.000Z");
        expect(requests).toEqual([
          "lookup",
          "2026-09-01T05:00:00.000Z",
          "lookup",
          "2026-10-01T05:00:00.000Z",
        ]);
        failLookup = true;
        registry.set(history.action, "reset");
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(registry.get(history.firstPage)._tag).toBe("Failure"))
        );
        expect(registry.get(history.state).location).toBe("LookupFailed");
        const retained = registry.get(history.state).query;
        if (retained._tag !== "Ready") throw new Error("Missing retained history");
        expect(Option.isSome(retained.refreshFailure)).toBe(true);
        expect(retained.value.data[0]?.id).toBe(replacement);
        expect(requests).toHaveLength(5);
        failLookup = false;
        registry.set(history.action, registry.get(history.state).retry);
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(registry.get(history.state).location).toBe("Located"))
        );
        expect(requests).toHaveLength(7);
      } finally {
        unmount();
        registry.dispose();
      }
    })
);

it.live("reset history preserves the five-second mounted focus revalidation policy", () =>
  Effect.gen(function* () {
    const window = Object.assign(new EventTarget(), { Uint8Array });
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", { visibilityState: "visible" });
    let reads = 0;
    const client = makeFidyClient({
      apiOrigin: "https://api.test.fidyapp.com",
      httpClient: Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          reads += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ data: [], next: [] }))
          );
        })
      ),
    });
    const history = transactionRouteHistory({
      client,
      search: { month: "2026-10" },
      timeZone: "America/Bogota",
      now: DateTime.makeUnsafe("2026-11-10T12:00:00Z"),
      initialPages: 1,
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(history.state);
    try {
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(registry.get(history.state).query._tag).toBe("Ready"))
      );
      registry.set(history.action, "reset");
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(2)));
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(registry.get(history.state).query._tag).toBe("Ready"))
      );
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => {
          const current = registry.get(history.firstPage);
          expect(current._tag).toBe("Success");
          expect(current.waiting).toBe(false);
        })
      );
      const timestamp = yield* Clock.currentTimeMillis;
      const clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(timestamp + 4000);
      window.dispatchEvent(new Event("visibilitychange"));
      yield* Effect.sleep("10 millis");
      expect(reads).toBe(2);
      clock.mockReturnValue(timestamp + 6000);
      window.dispatchEvent(new Event("visibilitychange"));
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(3)));
    } finally {
      unmount();
      registry.dispose();
      vi.restoreAllMocks();
    }
  })
);

it.live(
  "strict history recovery starts a canonical read even when its fresh page equals the retained page",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", Object.assign(new EventTarget(), { Uint8Array }));
      let reads = 0;
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            reads += 1;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ data: [], next: [] }))
            );
          })
        ),
      });
      const registry = AtomRegistry.make();
      const query = transactionFirstPage({
        client,
        period: {
          from: DateTime.makeUnsafe("2026-10-01T05:00:00Z"),
          to: DateTime.makeUnsafe("2026-11-01T05:00:00Z"),
        },
      });
      try {
        yield* AtomRegistry.getResult(registry, query);
        expect(reads).toBe(1);
        expect(yield* readFreshQuery({ registry, query })).toBe(true);
        expect(reads).toBe(2);
        expect(
          (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).data
        ).toEqual([]);
      } finally {
        registry.dispose();
      }
    })
);

it.live(
  "route recovery preserves exact fresh loaders across continuation refresh and destination resets",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", Object.assign(new EventTarget(), { Uint8Array }));
      let reads = 0;
      const client = makeFidyClient({
        apiOrigin: "https://api.test.fidyapp.com",
        httpClient: Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            reads += 1;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ data: [], next: [] }))
            );
          })
        ),
      });
      const history = transactionRouteHistory({
        client,
        search: {},
        timeZone: "America/Bogota",
        now: DateTime.makeUnsafe("2026-11-10T12:00:00Z"),
        initialPages: 1,
      });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(history.state);
      try {
        yield* AtomRegistry.getResult(registry, history.firstPage).pipe(Effect.orDie);
        expect(reads).toBe(1);
        for (const expected of [2, 4]) {
          registry.set(history.action, "refresh-pages");
          expect(yield* readFreshQuery({ registry, query: history.firstPage })).toBe(true);
          expect(reads).toBe(expected);
          if (expected === 2) {
            registry.set(history.action, "reset");
            yield* AtomRegistry.getResult(registry, history.firstPage, {
              suspendOnWaiting: true,
            }).pipe(Effect.orDie);
            expect(reads).toBe(3);
          }
        }
      } finally {
        unmount();
        registry.dispose();
      }
    })
);
