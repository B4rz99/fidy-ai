import { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { expect } from "vitest";
import { completeCanary, readCanaryHealth, receiveCanary, sendCanary } from "./operations";

it.live(
  "reports unexecuted Queue and Workflow canaries as unavailable, then separates their actual completions",
  () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Effect.sync(
          () =>
            new Miniflare({
              workers: [
                {
                  config: {
                    name: "canary",
                    type: "worker",
                    compatibilityDate: "2026-09-08",
                    env: { DB: { id: "canary", type: "d1" } },
                    manifest: {
                      mainModule: "index.mjs",
                      modules: {
                        "index.mjs": {
                          contents: "export default {fetch() {return new Response('ok')}}",
                          type: "esm",
                        },
                      },
                    },
                  },
                },
              ],
            })
        ),
        (instance) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() => instance.ready);
            const db = yield* Effect.tryPromise(() => instance.getD1Database("DB"));
            yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "CREATE TABLE operational_health_view(operation TEXT PRIMARY KEY,state TEXT NOT NULL,observed_at_ms INTEGER NOT NULL,last_succeeded_ms INTEGER)"
                )
                .run()
            );
            const now = yield* Clock.currentTimeMillis;
            expect(yield* Effect.tryPromise(() => readCanaryHealth({ db, now }))).toEqual([
              { component: "capability", operation: "queueExecution", state: "unavailable" },
              { component: "capability", operation: "workflowExecution", state: "unavailable" },
            ]);
            const created: string[] = [];
            const workflow = {
              create: (input: { id: string }): Promise<void> => {
                created.push(input.id);
                return Promise.resolve();
              },
              get: (): Promise<{ status: () => Promise<unknown> }> =>
                Promise.resolve({
                  status: () => Promise.resolve({ status: "complete" }),
                }),
            };
            for (const payload of [
              { version: 1, sentAtMs: "malformed" },
              { version: 1, sentAtMs: now + 1 },
              { version: 1, sentAtMs: now - 600_001 },
            ]) {
              yield* Effect.tryPromise(() =>
                expect(receiveCanary({ DB: db, workflow, now, payload })).rejects.toThrow(
                  "Invalid operational canary"
                )
              );
              yield* Effect.tryPromise(() =>
                expect(completeCanary({ db, now, payload })).rejects.toThrow(
                  "Invalid operational canary"
                )
              );
            }
            expect(created).toEqual([]);
            expect(yield* Effect.tryPromise(() => readCanaryHealth({ db, now }))).toEqual([
              { component: "capability", operation: "queueExecution", state: "unavailable" },
              { component: "capability", operation: "workflowExecution", state: "unavailable" },
            ]);
            yield* Effect.tryPromise(() =>
              receiveCanary({ DB: db, workflow, now, payload: { version: 1, sentAtMs: now - 500 } })
            );
            expect(created).toEqual([`operational-canary-${Math.floor((now - 500) / 300_000)}`]);
            expect(yield* Effect.tryPromise(() => readCanaryHealth({ db, now }))).toEqual([
              {
                component: "capability",
                operation: "queueExecution",
                state: "healthy",
                lastSucceededMs: now,
              },
              { component: "capability", operation: "workflowExecution", state: "unavailable" },
            ]);
            yield* Effect.tryPromise(() =>
              completeCanary({ db, payload: { version: 1, sentAtMs: now }, now })
            );
            expect((yield* Effect.tryPromise(() => readCanaryHealth({ db, now })))[1]).toEqual({
              component: "capability",
              operation: "workflowExecution",
              state: "healthy",
              lastSucceededMs: now,
            });
          }),
        (instance) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
      )
    )
);

it.effect("publishes once across the five minute ticks of a canary period", () =>
  Effect.gen(function* () {
    const sent: unknown[] = [];
    const queue = {
      send: (body: unknown): Promise<QueueSendResponse> => {
        sent.push(body);
        return Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
      },
    };
    for (const now of [3_005_000, 3_065_000, 3_125_000, 3_185_000, 3_245_000, 3_305_000]) {
      yield* Effect.tryPromise(() =>
        sendCanary({ queue, now, signal: new AbortController().signal })
      );
    }
    expect(sent).toEqual([
      { version: 1, sentAtMs: 3_000_000 },
      { version: 1, sentAtMs: 3_300_000 },
    ]);
  })
);
