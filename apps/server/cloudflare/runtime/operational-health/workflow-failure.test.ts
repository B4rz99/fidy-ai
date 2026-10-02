import { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { captureWorkflowFailure } from "./operations";

it.effect(
  "records a Workflow execution failure without changing its rejection or retaining its details",
  () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Effect.sync(
          () =>
            new Miniflare({
              workers: [
                {
                  config: {
                    name: "failed-workflow",
                    type: "worker",
                    compatibilityDate: "2026-09-08",
                    env: { DB: { id: "failed-workflow", type: "d1" } },
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
                  "CREATE TABLE operational_event_buckets (kind TEXT NOT NULL, bucket_ms INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, bucket_ms))"
                )
                .run()
            );
            const error = new Error("private user financial details");
            yield* Effect.tryPromise(() =>
              expect(captureWorkflowFailure({ work: Promise.reject(error), db })).rejects.toBe(
                error
              )
            );
            const rows = yield* Effect.tryPromise(() =>
              db.prepare("SELECT kind, count FROM operational_event_buckets").all()
            );
            expect(rows.results).toEqual([{ kind: "workflow_failure", count: 1 }]);
            const stalled: D1Database = new Proxy(db, {
              get(target, key, receiver): unknown {
                if (key !== "prepare") return Reflect.get(target, key, receiver);
                return (sql: string): D1PreparedStatement =>
                  new Proxy(db.prepare(sql), {
                    get(statement, method, context): unknown {
                      if (method !== "bind") return Reflect.get(statement, method, context);
                      return (
                        ...args: Parameters<D1PreparedStatement["bind"]>
                      ): D1PreparedStatement =>
                        new Proxy(statement.bind(...args), {
                          get(bound, operation, boundContext): unknown {
                            return operation === "run"
                              ? () => Promise.withResolvers<never>().promise
                              : Reflect.get(bound, operation, boundContext);
                          },
                        });
                    },
                  });
              },
            });
            const original = new Error("must preserve original rejection");
            yield* Effect.tryPromise(() =>
              expect(
                captureWorkflowFailure({ work: Promise.reject(original), db: stalled })
              ).rejects.toBe(original)
            );
          }),
        (instance) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
      )
    )
);
