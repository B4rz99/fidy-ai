import { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { recordOperationalHealth } from "./operations";
import { observeRetentionCost } from "../../d1-test-fixture";

it.effect(
  "stores private, bounded capability evidence with its observation time, not a public health response",
  () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Effect.sync(
          () =>
            new Miniflare({
              workers: [
                {
                  config: {
                    name: "health-view",
                    type: "worker",
                    compatibilityDate: "2026-09-08",
                    env: { DB: { id: "health-view", type: "d1" } },
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
                  "CREATE TABLE operational_health_view (operation TEXT PRIMARY KEY, state TEXT NOT NULL, observed_at_ms INTEGER NOT NULL)"
                )
                .run()
            );
            yield* Effect.tryPromise(() =>
              recordOperationalHealth({
                db,
                signals: [
                  { component: "capability", operation: "d1", state: "healthy" },
                  { component: "capability", operation: "providerConfig", state: "unavailable" },
                ],
                observedAtMs: 1_000_000,
              })
            );
            const stored = yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT operation, state, observed_at_ms FROM operational_health_view ORDER BY operation"
                )
                .all()
            );
            expect(stored.results).toEqual([
              { operation: "d1", state: "healthy", observed_at_ms: 1_000_000 },
              { operation: "providerConfig", state: "unavailable", observed_at_ms: 1_000_000 },
            ]);
            const measured = observeRetentionCost(db);
            const signals = [
              { component: "capability", operation: "d1", state: "healthy" },
            ] as const;
            yield* Effect.tryPromise(() =>
              recordOperationalHealth({ db: measured.database, signals, observedAtMs: 1_060_000 })
            );
            expect(measured.cost().rowsWritten).toBe(0);
            yield* Effect.tryPromise(() =>
              recordOperationalHealth({
                db: measured.database,
                signals: [{ component: "capability", operation: "d1", state: "unavailable" }],
                observedAtMs: 1_060_001,
              })
            );
            expect(
              yield* Effect.tryPromise(() =>
                db
                  .prepare("SELECT state FROM operational_health_view WHERE operation='d1'")
                  .first("state")
              )
            ).toBe("unavailable");
            yield* Effect.tryPromise(() =>
              recordOperationalHealth({ db: measured.database, signals, observedAtMs: 1_060_002 })
            );
            const before = measured.cost().rowsWritten;
            yield* Effect.tryPromise(() =>
              recordOperationalHealth({ db: measured.database, signals, observedAtMs: 1_360_002 })
            );
            expect(measured.cost().rowsWritten - before).toBe(1);
            yield* Effect.tryPromise(() =>
              recordOperationalHealth({
                db: measured.database,
                signals: [{ component: "capability", operation: "d1", state: "unavailable" }],
                observedAtMs: 1_000_000,
              })
            );
            expect(
              yield* Effect.tryPromise(() =>
                db
                  .prepare(
                    "SELECT state,observed_at_ms FROM operational_health_view WHERE operation='d1'"
                  )
                  .first()
              )
            ).toEqual({ state: "healthy", observed_at_ms: 1_360_002 });
          }),
        (instance) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
      )
    )
);
