import { erasureStoreHistory } from "../../erasure-store/operations";
import { maintenanceStoreHistory } from "../../maintenance/operations";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Config, Effect, FileSystem, Schema } from "effect";
import { Miniflare } from "miniflare";
import { native } from "../../user-store.test-fixture";

const criticalMigration = (message: string): boolean =>
  message.includes("component=sqlite operation=user state=migration-failed severity=critical");

const probe = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-native-migrations-" });

  const build = yield* native(() =>
    Bun.build({
      entrypoints: [new URL("../../store-migrations.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers"],
    })
  );

  const output = build.outputs[0];

  if (!build.success || output === undefined) {
    return yield* Effect.die(new Error("Native migration probe failed to build"));
  }

  const contents = yield* native(() => output.text());

  const activate = Effect.fnUntraced(function* (mode: string, release: string, now = 1000) {
    const messages: string[] = [];

    const mf = new Miniflare({
      handleStructuredLogs: (log): void => {
        messages.push(log.message);
      },
      unsafeInspectDurableObjects: true,
      resourcePersistencePath: directory,
      workers: [
        {
          config: {
            type: "worker",
            name: "schema",
            compatibilityDate: "2026-09-08",
            exports: { MigrationProbe: { type: "durable-object", storage: "sqlite" } },
            env: {
              NOW: { type: "text", value: String(now) },
              MODE: { type: "text", value: mode },
              RELEASE: { type: "text", value: release },
              PROBE: { type: "durable-object", worker: "schema", exportName: "MigrationProbe" },
            },
            manifest: {
              mainModule: "index.mjs",
              modules: {
                "index.mjs": { type: "esm", contents: contents + "\nexport default {};" },
              },
            },
          },
        },
      ],
    });

    yield* Effect.addFinalizer(() => native(() => mf.dispose()));

    const storage = yield* native(() =>
      mf.unsafeGetDurableObjectStorage("schema", "MigrationProbe", { name: "retained" })
    );

    const namespace = yield* native(() => mf.getDurableObjectNamespace("PROBE"));

    const request = native(() =>
      namespace
        .getByName("retained")
        .fetch("https://schema.test/read")
        .then(
          (reply) => reply.status,
          () => 503
        )
    );

    const exec = (statement: string): Effect.Effect<Awaited<ReturnType<typeof storage.exec>>> =>
      native(() => storage.exec(statement));

    const measure = native(() =>
      namespace
        .getByName("retained")
        .fetch("https://schema.test/metrics")
        .then((reply) => reply.json())
    );

    return { request, exec, measure, messages };
  });

  return activate;
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("upgrades an idle store across skipped releases while preserving retained data", () =>
    Effect.gen(function* () {
      const activate = yield* probe;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const old = yield* activate("oldest", "release1");
          expect(yield* old.request).toBe(200);
          expect(yield* old.exec("SELECT id FROM retained")).toEqual([{ id: 41 }]);
        })
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const current = yield* activate("latest", "release3");
          expect(yield* current.request).toBe(200);
          expect(yield* current.exec("SELECT value FROM result")).toEqual([{ value: 42 }]);
          expect(
            yield* current.exec("SELECT version FROM store_migrations ORDER BY version")
          ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
        })
      );
    })
  );
  test.effect("preserves a populated User across the Connection migration", () =>
    Effect.gen(function* () {
      const activate = yield* probe;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* activate("userBeforeConnections", "sample-review");
          expect(yield* store.request).toBe(200);
          yield* store.exec(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES('10000000-0000-4000-8000-000000000051','CO','es-CO','America/Bogota',0)"
          );
          yield* store.exec(
            "INSERT INTO categories(id,label,display_order) VALUES('category','Food',1)"
          );
          yield* store.exec(
            "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) SELECT 'movement',id,'100','COP','inflow','category',0,0 FROM users"
          );
          yield* store.exec(
            "INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at_ms) SELECT 'source',id,'movement','manual',service_market,locale,time_zone,'manual-v1',0 FROM users"
          );
          yield* store.exec(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) SELECT id,'pair',id,zeroblob(32),0,600000,600000,7776000000 FROM users"
          );
          yield* store.exec(
            "INSERT INTO audit_entries(id,user_id,record_type,session_id,operation,outcome,occurred_at_ms) SELECT 'history',id,'session_call',id,'transactions.createTransaction','success',0 FROM users"
          );
          yield* store.exec(
            "INSERT INTO canonical_request_receipts SELECT id,hex(zeroblob(32)),'operations.executeAtomicBatch',hex(zeroblob(32)),0,200,'1' FROM users"
          );
          yield* store.exec(
            "INSERT INTO canonical_receipt_parts SELECT id,hex(zeroblob(32)),0,'part' FROM users"
          );
          yield* store.exec(
            "INSERT INTO ingest_sample_decisions(candidate_id,user_id,revision,digest,issuer,operator,decided_at_ms,phase) SELECT 'sample',id,1,'digest','review','human',0,'rejected' FROM users"
          );
        })
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* activate("userCurrent", "connections");
          expect(yield* store.request).toBe(200);
          expect(
            yield* store.exec(
              "SELECT version,id FROM store_migrations WHERE version IN (19,20) ORDER BY version"
            )
          ).toEqual([
            { version: 19, id: "human-sample-review" },
            { version: 20, id: "user-connections" },
          ]);
          expect(
            yield* store.exec(
              "SELECT transaction_id AS movement,kind,operation,outcome,part,phase FROM source_attestations CROSS JOIN audit_entries CROSS JOIN canonical_receipt_parts CROSS JOIN ingest_sample_decisions"
            )
          ).toEqual([
            {
              movement: "movement",
              kind: "manual",
              operation: "transactions.createTransaction",
              outcome: "success",
              part: "part",
              phase: "rejected",
            },
          ]);
          expect(yield* store.exec("PRAGMA foreign_key_check")).toEqual([]);
        })
      );
    })
  );
  test.effect("preserves committed steps and a deterministic refusal across reconstruction", () =>
    Effect.gen(function* () {
      const activate = yield* probe;

      const startBrokenRelease = Effect.fnUntraced(function* (startup: string) {
        const broken = yield* activate("invalid", "broken");
        expect(yield* broken.request, startup).toBe(503);
        expect(broken.messages.some(criticalMigration)).toBe(true);
      }, Effect.scoped);

      const inspectBrokenRelease = Effect.fnUntraced(function* () {
        const broken = yield* activate("inspect", "inspection");
        expect(yield* broken.exec("SELECT id,label FROM retained")).toEqual([
          { id: 41, label: "preserved" },
        ]);
        expect(yield* broken.exec("SELECT name FROM sqlite_schema WHERE name='result'")).toEqual(
          []
        );
        expect(
          yield* broken.exec(
            "SELECT attempts,terminal FROM store_migration_attempts WHERE version=3 AND release='broken'"
          )
        ).toEqual([{ attempts: 1, terminal: 1 }]);
      }, Effect.scoped);

      yield* Effect.forEach(
        ["first", "restart"],
        Effect.fnUntraced(function* (startup) {
          yield* startBrokenRelease(startup);
          yield* inspectBrokenRelease();
        }),
        { discard: true }
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const fixed = yield* activate("latest", "corrected");
          expect(yield* fixed.request).toBe(200);
          expect(yield* fixed.exec("SELECT value FROM result")).toEqual([{ value: 42 }]);
        })
      );
    })
  );

  test.effect("waits one and five minutes between durably bounded transient attempts", () =>
    Effect.gen(function* () {
      const activate = yield* probe;

      const startBusyRelease = Effect.fnUntraced(function* (time: number) {
        const broken = yield* activate("busy", "same-release", time);
        expect(yield* broken.request).toBe(503);
      }, Effect.scoped);

      const inspectBusyRelease = Effect.fnUntraced(function* (attempts: number) {
        const diagnostic = yield* activate("inspect", "inspection");
        expect(
          yield* diagnostic.exec(
            "SELECT attempts,terminal FROM store_migration_attempts WHERE version=3"
          )
        ).toEqual([{ attempts, terminal: 0 }]);
        expect(
          yield* diagnostic.exec("SELECT version FROM store_migrations ORDER BY version")
        ).toEqual([{ version: 1 }, { version: 2 }]);
      }, Effect.scoped);

      yield* Effect.forEach(
        [
          [1000, 1],
          [60999, 1],
          [61000, 2],
          [360999, 2],
          [361000, 3],
          [999999, 3],
        ] as const,
        Effect.fnUntraced(function* ([time, attempts]) {
          yield* startBusyRelease(time);
          yield* inspectBusyRelease(attempts);
        }),
        { discard: true }
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const corrected = yield* activate("latest", "fixed", 999999);
          expect(yield* corrected.request).toBe(200);
          expect(yield* corrected.exec("SELECT value FROM result")).toEqual([{ value: 42 }]);
        })
      );
    })
  );
  test.effect("refuses uncharged attempts and never claims unexpected retained tables", () =>
    Effect.gen(function* () {
      const activate = yield* probe;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const guard = yield* activate("refuseGuard", "broken");
          expect(yield* guard.request).toBe(503);
        })
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const inspection = yield* activate("inspect", "host");
          expect(
            yield* inspection.exec("SELECT name FROM sqlite_schema WHERE name='retained'")
          ).toEqual([]);
          yield* inspection.exec("CREATE TABLE unexpected(content TEXT)");
          yield* inspection.exec("INSERT INTO unexpected VALUES('kept')");
        })
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const normal = yield* activate("latest", "corrected");
          expect(yield* normal.request).toBe(503);
        })
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const inspection = yield* activate("inspect", "host");
          expect(yield* inspection.exec("SELECT content FROM unexpected")).toEqual([
            { content: "kept" },
          ]);
          expect(yield* inspection.exec("SELECT version FROM store_migrations")).toEqual([]);
        })
      );
    })
  );
  test.effect("rejects missing, replaced and newer versions without downgrading the store", () =>
    Effect.gen(function* () {
      const activate = yield* probe;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const current = yield* activate("latest", "current");
          expect(yield* current.request).toBe(200);
        })
      );

      yield* Effect.forEach(
        ["missing", "mismatch", "oldest"],
        Effect.fnUntraced(function* (release) {
          const broken = yield* activate(release, "bad-release");
          expect(yield* broken.request).toBe(503);
        }, Effect.scoped),
        { discard: true }
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const compatible = yield* activate("latest", "compatible");
          expect(yield* compatible.request).toBe(200);
          expect(yield* compatible.exec("SELECT value FROM result")).toEqual([{ value: 42 }]);
        })
      );
    })
  );

  const independentHistories = [maintenanceStoreHistory, erasureStoreHistory];

  const testIndependentHistory = ({
    owner,
    steps,
  }: (typeof independentHistories)[number]): void => {
    test.effect(`initializes the independent ${owner} migration history`, () =>
      Effect.gen(function* () {
        const activate = yield* probe;
        const store = yield* activate(owner, "release");
        expect(yield* store.request).toBe(200);
        expect(
          yield* store.exec("SELECT owner,version,id FROM store_migrations ORDER BY version")
        ).toEqual(steps.map(({ version, id }) => ({ owner, version, id })));
      })
    );
  };

  independentHistories.forEach(testIndependentHistory);

  test.effect.runIf(
    Effect.runSync(Config.String("FIDY_STORE_MIGRATION_MEASURE").pipe(Config.withDefault("0"))) ===
      "1"
  )(
    "measures empty and retained 100,000-Transaction User activation",
    () =>
      Effect.gen(function* () {
        const activate = yield* probe;

        yield* Effect.forEach(
          ["userOldest", "userCurrent"],
          Effect.fnUntraced(function* (mode) {
            const store = yield* activate(mode, "measurement");
            const started = performance.now();

            const sizes = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                initialBytes: Schema.Int,
                peakBytes: Schema.Int,
                finalBytes: Schema.Int,
              })
            )(yield* store.measure);

            const durationMs = performance.now() - started;

            const transactions = yield* store.exec(
              "SELECT count(*) AS transactions FROM transactions"
            );

            expect(transactions).toEqual([{ transactions: mode === "userOldest" ? 0 : 100000 }]);
            expect(durationMs).toBeLessThan(15000);
            expect(sizes.peakBytes).toBeLessThan(512 * 1024 * 1024);
            const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
            process.stdout.write(
              `MIGRATION_ACTIVATION ${yield* encode({ mode, transactions, durationMs, ...sizes })}\n`
            );

            if (mode === "userOldest") {
              yield* store.exec(
                "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES('10000000-0000-4000-8000-000000000051','CO','es-CO','America/Bogota',0)"
              );
              yield* store.exec(
                "INSERT INTO categories(id,label,display_order) VALUES('10000000-0000-4000-8000-000000000001','Restaurantes',1)"
              );
              yield* store.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
              INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms)
              SELECT printf('81000000-0000-4000-8000-%012d',i),'10000000-0000-4000-8000-000000000051','1000','COP','outflow','10000000-0000-4000-8000-000000000001',i,i FROM n`);
            }
          }, Effect.scoped),
          { discard: true }
        );
      }),
    120000
  );
});
