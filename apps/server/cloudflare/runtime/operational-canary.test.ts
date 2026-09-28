import { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { expect } from "vitest";
import { completeCanary, readCanaryHealth, receiveCanary } from "./operational-canary";

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
                  "CREATE TABLE operational_canary (kind TEXT PRIMARY KEY, last_succeeded_ms INTEGER NOT NULL)"
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
            yield* Effect.tryPromise(() =>
              expect(
                receiveCanary({
                  DB: db,
                  workflow,
                  now,
                  payload: { version: 1, sentAtMs: "malformed" },
                })
              ).rejects.toThrow()
            );
            expect(created).toEqual([]);
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
