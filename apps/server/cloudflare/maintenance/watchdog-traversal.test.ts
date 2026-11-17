import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Config, Effect, FileSystem, Schema } from "effect";
import { Miniflare } from "miniflare";
import { expect } from "vitest";
import { native, workerManifest } from "../user-store.test-fixture";

const measureTick =
  Effect.runSync(Config.String("FIDY_MEASURE_WATCHDOG").pipe(Config.withDefault("0"))) === "1";
const name = "core-maintenance-v1";
const user = (number: number): string =>
  "22530000-0000-4000-8000-" + String(number).padStart(12, "0");
const firstUsers = Array.from({ length: 256 }, (_, index) => user(index + 1));
const Ledger = Schema.Struct({
  names: Schema.Array(Schema.String),
  peak: Schema.Int,
  aborted: Schema.Int,
  cancelled: Schema.Int,
});
const fleet = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const location = yield* fs.makeTempDirectoryScoped({ prefix: "watchdog-fleet-" });
  const fixture = yield* workerManifest("./maintenance/watchdog.test-fixture.ts");
  return Effect.fnUntraced(function* (mode: string) {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Miniflare({
            resourcePersistencePath: location,
            unsafeInspectDurableObjects: true,
            workers: [
              {
                config: {
                  name: "watchdog",
                  type: "worker",
                  compatibilityDate: "2026-09-08",
                  compatibilityFlags: ["nodejs_compat"],
                  manifest: {
                    mainModule: "entry.mjs",
                    modules: {
                      ...fixture.modules,
                      "entry.mjs": {
                        type: "esm",
                        contents: "export {WatchdogFixture} from './index.mjs'; export default {};",
                      },
                    },
                  },

                  exports: { WatchdogFixture: { type: "durable-object", storage: "sqlite" } },
                  env: {
                    MAINTENANCE: {
                      type: "durable-object",
                      worker: "watchdog",
                      exportName: "WatchdogFixture",
                    },
                    CF_VERSION_METADATA: { type: "version-metadata" },
                    SQLITE_STORE_CAPACITY_BYTES: { type: "text", value: "1000000000" },
                    MODE: { type: "text", value: mode },
                  },
                },
              },
            ],
          })
      ),
      (instance) => native(() => instance.dispose())
    );
    const namespace = yield* native(() =>
      runtime.getDurableObjectNamespace("MAINTENANCE", "watchdog")
    );
    const owner = namespace.getByName(name);
    yield* native(() => owner.fetch("https://store.invalid/release-readiness"));
    const storage = yield* native(() =>
      runtime.unsafeGetDurableObjectStorage("watchdog", "WatchdogFixture", { name })
    );
    return {
      exec: (
        ...args: Parameters<typeof storage.exec>
      ): Effect.Effect<Awaited<ReturnType<typeof storage.exec>>> =>
        native(() => storage.exec(...args)),
      tick: (scheduled: number): Effect.Effect<number> =>
        native(() =>
          owner.fetch("https://maintenance.invalid/watchdog", {
            method: "POST",
            headers: { "x-maintenance-scheduled-at": String(scheduled) },
          })
        ).pipe(Effect.map((response) => response.status)),
      ledger: native(() =>
        owner.fetch("https://fixture.invalid/ledger").then((response) => response.json())
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ledger))),
    };
  });
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "reconstructs mid-traversal, isolates a lost reply and a failed owner, and wraps to registrations behind the cursor",
    () =>
      Effect.gen(function* () {
        const create = yield* fleet();
        const scheduled = yield* Clock.currentTimeMillis;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* create("lost");
            yield* fixture.exec(
              "WITH RECURSIVE ids(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM ids WHERE i<257) INSERT INTO lifetime_registry(user_id) SELECT printf('22530000-0000-4000-8000-%012d',i) FROM ids"
            );
            expect(yield* fixture.tick(scheduled)).toBe(204);
            const ledger = yield* fixture.ledger;
            expect(ledger.names.slice(0, 3)).toEqual([
              "directory-v1",
              "pricing",
              "erasure-registry-v1",
            ]);
            expect(ledger.names.slice(3)).toEqual(firstUsers);
            expect(ledger.peak).toBe(5);
            expect(ledger.aborted).toBe(1);
            expect(
              yield* fixture.exec(
                "SELECT attempted,observed,failed,unknown,repaired,wraps FROM watchdog_progress"
              )
            ).toEqual([
              { attempted: 259, observed: 257, failed: 1, unknown: 1, repaired: 0, wraps: 0 },
            ]);
          })
        );
        const fixture = yield* create("fast");
        expect(yield* fixture.tick(scheduled)).toBe(204);
        expect((yield* fixture.ledger).names).toHaveLength(0);
        yield* fixture.exec(
          "INSERT INTO lifetime_registry(user_id) VALUES(?),(?)",
          user(0),
          user(258)
        );
        // Advance the persisted minute gate instead of sleeping a minute on each side of the restart.
        yield* fixture.exec("UPDATE watchdog_progress SET minute=minute-1");
        expect(yield* fixture.tick(scheduled + 60000)).toBe(204);
        expect((yield* fixture.ledger).names.slice(3)).toEqual([user(257), user(258)]);
        yield* fixture.exec("UPDATE watchdog_progress SET minute=minute-1");
        expect(yield* fixture.tick(scheduled + 120000)).toBe(204);
        expect((yield* fixture.ledger).names.slice(8, 10)).toEqual([user(0), user(1)]);
      }),
    15000
  );
  test.effect("stops admission when an unexpected response body cannot finish cancellation", () =>
    Effect.gen(function* () {
      const create = yield* fleet();
      const fixture = yield* create("held-body");
      yield* fixture.exec(
        "INSERT INTO lifetime_registry(user_id) VALUES(?),(?),(?)",
        user(1),
        user(2),
        user(3)
      );
      const start = yield* Clock.currentTimeMillis;
      expect(yield* fixture.tick(start)).toBe(204);
      const elapsed = (yield* Clock.currentTimeMillis) - start;
      expect(elapsed).toBeLessThan(1400);
      const ledger = yield* fixture.ledger;
      expect(ledger.cancelled).toBe(1);
      expect(ledger.names.slice(3)).toEqual([user(1), user(2)]);
      expect(
        yield* fixture.exec(
          "SELECT admitted,attempted,observed,unknown,failed FROM watchdog_progress"
        )
      ).toEqual([{ admitted: 5, attempted: 5, observed: 3, unknown: 1, failed: 1 }]);
      yield* fixture.exec("UPDATE watchdog_progress SET minute=minute-1");
      expect(yield* fixture.tick(start + 60000)).toBe(503);
      expect((yield* fixture.ledger).names.slice(3)).toEqual([user(1), user(2)]);
    })
  );
  if (measureTick) {
    test.effect(
      "bounds a tick under sustained slow reply cleanup",
      () =>
        Effect.gen(function* () {
          const create = yield* fleet();
          const fixture = yield* create("slow-cleanup");
          yield* fixture.exec(
            "WITH RECURSIVE ids(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM ids WHERE i<256) INSERT INTO lifetime_registry(user_id) SELECT printf('22530000-0000-4000-8000-%012d',i) FROM ids"
          );
          const start = yield* Clock.currentTimeMillis;
          expect(yield* fixture.tick(start)).toBe(204);
          const elapsed = (yield* Clock.currentTimeMillis) - start;
          const ledger = yield* fixture.ledger;
          const counts = yield* fixture.exec(
            "SELECT admitted,attempted,observed,failed,unknown,repaired,wraps FROM watchdog_progress"
          );
          yield* Effect.logInfo({ elapsed, peak: ledger.peak, aborted: ledger.aborted, counts });
          expect(ledger.names.length).toBeGreaterThan(200);
          expect(ledger.names.length).toBeLessThan(259);
          expect(elapsed).toBeLessThan(56000);
          expect(ledger.peak).toBe(5);
          expect(ledger.aborted).toBe(ledger.names.length);
          expect(counts).toEqual([
            {
              admitted: ledger.names.length,
              attempted: ledger.names.length,
              observed: 0,
              failed: 0,
              unknown: ledger.names.length,
              repaired: 0,
              wraps: 0,
            },
          ]);
        }),
      65000
    );
  }
});
