import { Clock, DateTime, Effect, Layer, Option } from "effect";
import { afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { AtomRegistry } from "effect/reactivity";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { makeFidyClient } from "@/transport/client";
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
        registry.set(history.action, "more");
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => {
            const state = registry.get(history.state);
            if (state.query._tag !== "Ready") throw new Error("History is not ready");
            expect(state.query.value.data.at(-1)?.id).toBe(target);
            expect(state.continuation).toBe("available");
          })
        );
        expect(reads).toHaveLength(21);
        registry.set(history.action, "more");
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toHaveLength(22)));
      } finally {
        unmount();
        registry.dispose();
      }
    })
);
