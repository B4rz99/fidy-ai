import { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import tailWorker from "../operational-tail-worker";

it.live(
  "persists only bounded event counters and a heartbeat without retaining request or exception data",
  () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Effect.sync(
          () =>
            new Miniflare({
              workers: [
                {
                  config: {
                    name: "operational-tail",
                    type: "worker",
                    compatibilityDate: "2026-09-08",
                    env: { DB: { id: "operational-tail", type: "d1" } },
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
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.tryPromise(() =>
              tailWorker.tail(
                [
                  {
                    outcome: "exception",
                    eventTimestamp: now,
                    exceptions: [{ message: "private-email@example.com" }],
                  },
                  {
                    outcome: "ok",
                    eventTimestamp: now,
                    event: {
                      request: {
                        url: "https://api.fidyapp.com/providers/wompi/billing-events?userId=private",
                      },
                      response: { status: 401 },
                    },
                  },
                  {
                    outcome: "ok",
                    eventTimestamp: now,
                    event: {
                      request: {
                        url: "https://api.fidyapp.com/providers/wompi/billing-events?userId=private",
                      },
                      response: { status: 200 },
                    },
                  },
                ],
                { DB: db }
              )
            );
            const rows = yield* Effect.tryPromise(() =>
              db.prepare("SELECT kind, count FROM operational_event_buckets ORDER BY kind").all()
            );
            expect(rows.results).toEqual([
              { kind: "callback_rejection", count: 1 },
              { kind: "heartbeat", count: 1 },
              { kind: "worker_exception", count: 1 },
            ]);
            const rendered = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
              rows.results
            );
            expect(rendered).not.toContain("private");
            yield* Effect.tryPromise(() =>
              tailWorker.tail(Array(33).fill({ outcome: "ok", eventTimestamp: now }), { DB: db })
            );
            expect(
              yield* Effect.tryPromise(() =>
                db
                  .prepare(
                    "SELECT kind FROM operational_event_buckets WHERE kind = 'tail_overflow'"
                  )
                  .first()
              )
            ).toEqual({ kind: "tail_overflow" });
          }),
        (instance) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
      )
    )
);
