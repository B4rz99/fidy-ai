import { NodeFileSystem } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Data, Effect, Fiber, FileSystem, Result } from "effect";
import { Miniflare } from "miniflare";
import { rolldown } from "rolldown";
import { afterEach, describe, expect, it } from "vitest";
import {
  ResourceAdmissionAuthority,
  type ResourceAdmissionAuthorityService,
  type ResourceAdmissionCharge,
  ResourceAdmissionCharges,
  type ResourceAdmissionDimension,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  type ResourceAdmissionPolicy,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionRefused,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnavailable,
  ResourceAdmissionUnits,
} from "./resource-admission";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);
const workerScript = "export default { fetch() { return new Response('ok') } }";
const migrationUrl = new URL("./migrations/0002_resource_admission.sql", import.meta.url);
const workerFixtureUrl = new URL("./resource-admission-worker.fixture.ts", import.meta.url);
const activeMiniflare = new Set<Miniflare>();

// Miniflare exposes a Promise-native lifecycle at this integration boundary.

const makeMiniflare = (resourcePersistencePath?: string): Promise<Miniflare> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const miniflare = new Miniflare({
        resourcePersistencePath,
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: {
                DB: { id: "resource-admission-test", type: "d1" },
              },
              manifest: {
                mainModule: "index.mjs",
                modules: {
                  "index.mjs": { contents: workerScript, type: "esm" },
                },
              },
              name: "resource-admission-test-worker",
              type: "worker",
            },
          },
        ],
      });
      activeMiniflare.add(miniflare);
      yield* fromTestPromise(() => miniflare.ready);
      return miniflare;
    })
  );

const migrateDatabase = (database: D1Database): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const migration = (yield* fromTestPromise(() => Bun.file(migrationUrl).text())).replace(
        /^--.*$/gmu,
        ""
      );
      yield* fromTestPromise(() =>
        migration
          .trim()
          .split(/\n\s*\n/u)
          .reduce<Promise<unknown>>(
            (previous, statement) => previous.then(() => database.prepare(statement).run()),
            Promise.resolve()
          )
      );
    })
  );

const prepareDatabase = (miniflare: Miniflare): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* fromTestPromise(() => miniflare.getD1Database("DB"));
      yield* fromTestPromise(() => migrateDatabase(database));
      return database;
    })
  );

const policyKey = (value: string): ResourceAdmissionPolicyKey =>
  ResourceAdmissionPolicyKey.make(value);
const scopeKey = (value: string): ResourceAdmissionScopeKey =>
  ResourceAdmissionScopeKey.make(value);
const grantId = (value: string): ResourceAdmissionGrantId => ResourceAdmissionGrantId.make(value);
const epochMs = (value: number): ResourceAdmissionEpochMs => ResourceAdmissionEpochMs.make(value);

const rollingPolicy = (
  key: string,
  dimension: Exclude<ResourceAdmissionDimension, "outstanding_work">,
  ...settings: [] | [limit: number] | [limit: number, durationMs: number]
): ResourceAdmissionPolicy => ({
  dimension,
  durationMs: ResourceAdmissionDurationMs.make(settings[1] ?? 1_000),
  key: policyKey(key),
  kind: "rolling_window",
  limit: ResourceAdmissionLimit.make(settings[0] ?? 5),
});

const charge = (key: string, scope: string, units = 1): ResourceAdmissionCharge => ({
  policyKey: policyKey(key),
  scopeKey: scopeKey(scope),
  units: ResourceAdmissionUnits.make(units),
});

const makeAuthority = (
  database: D1Database,
  policies: readonly [ResourceAdmissionPolicy, ...ReadonlyArray<ResourceAdmissionPolicy>],
  clock: Readonly<{ readonly read: () => ResourceAdmissionEpochMs }>
): ResourceAdmissionAuthorityService =>
  ResourceAdmissionAuthority.make({
    database,
    nowEpochMs: clock.read,
    policies: ResourceAdmissionPolicies.make(policies),
  });

const admit = (
  authority: ResourceAdmissionAuthorityService,
  id: string,
  charges: readonly [ResourceAdmissionCharge, ...ReadonlyArray<ResourceAdmissionCharge>],
  ...input: [] | [statements: ReadonlyArray<D1PreparedStatement>]
): ReturnType<ResourceAdmissionAuthorityService["admit"]> =>
  authority.admit({
    charges: ResourceAdmissionCharges.make(charges),
    grantId: grantId(id),
    statements: input[0] ?? [],
  });

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromTestPromise(() =>
        Promise.all([...activeMiniflare].map((miniflare): Promise<void> => miniflare.dispose()))
      );
      activeMiniflare.clear();
    })
  )
);

const releasePersistence = (fs: FileSystem.FileSystem, path: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* fromTestPromise(() =>
      Promise.all([...activeMiniflare].map((instance) => instance.dispose()))
    );
    activeMiniflare.clear();
    yield* fs.remove(path, { force: true, recursive: true }).pipe(Effect.orDie);
  });

const verifyPersistedRestart = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const persistencePath = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "fidy-admission-" }),
    (path) => releasePersistence(fs, path)
  );
  const firstRuntime = yield* fromTestPromise(() => makeMiniflare(persistencePath));
  const firstDatabase = yield* fromTestPromise(() => prepareDatabase(firstRuntime));
  const policy = rollingPolicy("stable-user:restart:v1", "stable_user", 1);
  const firstAuthority = makeAuthority(firstDatabase, [policy], { read: () => epochMs(10_000) });
  yield* admit(firstAuthority, "before-restart", [
    charge("stable-user:restart:v1", "user:restart"),
  ]);
  yield* fromTestPromise(() => firstRuntime.dispose());
  activeMiniflare.delete(firstRuntime);

  const replacementRuntime = yield* fromTestPromise(() => makeMiniflare(persistencePath));
  const replacementDatabase = yield* fromTestPromise(() => replacementRuntime.getD1Database("DB"));
  const replacementAuthority = makeAuthority(replacementDatabase, [policy], {
    read: () => epochMs(10_000),
  });
  const afterRestart = yield* Effect.result(
    admit(replacementAuthority, "after-restart", [charge("stable-user:restart:v1", "user:restart")])
  );
  expect(Result.isFailure(afterRestart)).toBe(true);
  if (Result.isFailure(afterRestart)) {
    expect(afterRestart.failure).toBeInstanceOf(ResourceAdmissionRefused);
  }
});

describe("Cloudflare resource admission", () => {
  it(
    "admits only the burst limit across concurrent Worker instances",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const bundle = yield* fromTestPromise(() =>
            rolldown({
              input: workerFixtureUrl.pathname,
              platform: "browser",
              resolve: { conditionNames: ["workerd", "worker", "browser"] },
            })
          );
          const build = yield* fromTestPromise(() => bundle.generate({ format: "esm" }));
          yield* fromTestPromise(() => bundle.close());
          const output = build.output.find((candidate) => candidate.type === "chunk");
          if (output === undefined) throw new Error("Worker fixture build produced no output");
          const script = output.code;
          const miniflare = new Miniflare({
            workers: [
              {
                config: {
                  compatibilityDate: "2026-09-08",
                  env: { DB: { id: "resource-admission-test", type: "d1" } },
                  manifest: {
                    mainModule: "index.mjs",
                    modules: { "index.mjs": { contents: script, type: "esm" } },
                  },
                  name: "admission-instance-one",
                  type: "worker",
                },
              },
              {
                config: {
                  compatibilityDate: "2026-09-08",
                  env: { DB: { id: "resource-admission-test", type: "d1" } },
                  manifest: {
                    mainModule: "index.mjs",
                    modules: { "index.mjs": { contents: script, type: "esm" } },
                  },
                  name: "admission-instance-two",
                  type: "worker",
                },
              },
            ],
          });
          activeMiniflare.add(miniflare);
          yield* fromTestPromise(() => miniflare.ready);
          const bindings = yield* fromTestPromise(() =>
            miniflare.getBindings<{ readonly DB: D1Database }>("admission-instance-one")
          );
          yield* fromTestPromise(() => migrateDatabase(bindings.DB));
          const workers = [
            yield* fromTestPromise(() => miniflare.getWorker("admission-instance-one")),
            yield* fromTestPromise(() => miniflare.getWorker("admission-instance-two")),
          ] as const;

          const requests = Array.from({ length: 40 }, (_, index) =>
            workers[index % 2 === 0 ? 0 : 1].fetch(`https://admission.test/?id=burst-${index}`)
          );
          const responses = yield* fromTestPromise(() => Promise.all(requests));

          expect(responses.filter(({ status }) => status === 201)).toHaveLength(5);
          expect(responses.filter(({ status }) => status === 429)).toHaveLength(35);
        })
      ),
    15_000
  );

  it("waits for an uncancellable D1 batch to settle before interruption completes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const miniflare = yield* fromTestPromise(() => makeMiniflare());
        const database = yield* fromTestPromise(() => prepareDatabase(miniflare));
        const batchStarted = Promise.withResolvers<void>();
        const batchCompletion = Promise.withResolvers<void>();
        let batchSettled = false;
        let interruptionSettled = false;
        const settleBatch = (): ReadonlyArray<D1Result<unknown>> => {
          batchSettled = true;
          return [];
        };
        const controlledBatch = (): Promise<ReadonlyArray<D1Result<unknown>>> => {
          batchStarted.resolve();
          return batchCompletion.promise.then(settleBatch);
        };
        const controlledDatabase = new Proxy(database, {
          get: (target, property): unknown =>
            property === "batch" ? controlledBatch : Reflect.get(target, property, target),
        });
        const authority = makeAuthority(
          controlledDatabase,
          [rollingPolicy("operation:interruption:v1", "operation", 1)],
          { read: () => epochMs(10_000) }
        );
        const fiber = yield* Effect.forkChild(
          admit(authority, "interrupted-admission", [
            charge("operation:interruption:v1", "operation:interruption"),
          ])
        );

        yield* fromTestPromise(() => batchStarted.promise);
        const markInterrupted = (): void => {
          interruptionSettled = true;
        };
        const interruption = yield* Effect.forkChild(
          Fiber.interrupt(fiber).pipe(Effect.tap(() => Effect.sync(markInterrupted)))
        );
        yield* fromTestPromise(() => Promise.resolve());

        expect(interruptionSettled).toBe(false);
        expect(batchSettled).toBe(false);
        batchCompletion.resolve();
        yield* Fiber.join(interruption);
        expect(batchSettled).toBe(true);
      })
    ));

  it("independently charges every installed admission dimension", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const miniflare = yield* fromTestPromise(() => makeMiniflare());
        const database = yield* fromTestPromise(() => prepareDatabase(miniflare));
        const policies = [
          rollingPolicy("stable-user:all:v1", "stable_user", 1),
          rollingPolicy("source:all:v1", "source", 1),
          rollingPolicy("operation:all:v1", "operation", 1),
          {
            dimension: "outstanding_work",
            key: policyKey("outstanding:all:v1"),
            kind: "outstanding",
            leaseMs: ResourceAdmissionDurationMs.make(60_000),
            limit: ResourceAdmissionLimit.make(1),
          },
          rollingPolicy("spend:all:v1", "spend", 10),
        ] as const;
        const authority = makeAuthority(database, policies, { read: () => epochMs(20_000) });
        const charges = [
          charge("stable-user:all:v1", "user:f1d1a001"),
          charge("source:all:v1", "source:7a9f"),
          charge("operation:all:v1", "operation:statement-ingestion"),
          charge("outstanding:all:v1", "user:f1d1a001:statement-ingestion"),
          charge("spend:all:v1", "spend:workers-ai:user:f1d1a001", 10),
        ] as const;
        yield* admit(authority, "all-dimensions-first", charges);

        const results = yield* Effect.all(
          charges.map((oneCharge, index) =>
            Effect.result(admit(authority, `dimension-${index}`, [oneCharge]))
          ),
          { concurrency: "unbounded" }
        );

        expect(results).toHaveLength(5);
        expect(
          results.every(
            (result) =>
              Result.isFailure(result) && result.failure instanceof ResourceAdmissionRefused
          )
        ).toBe(true);
      })
    ));

  it("makes a grant and its proof or outbox publication one atomic D1 commit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const miniflare = yield* fromTestPromise(() => makeMiniflare());
        const database = yield* fromTestPromise(() => prepareDatabase(miniflare));
        yield* fromTestPromise(() =>
          database
            .prepare(
              `CREATE TABLE test_outbox (
          id TEXT PRIMARY KEY NOT NULL,
          admission_grant_id TEXT NOT NULL REFERENCES resource_admission_grants(id)
        ) STRICT`
            )
            .run()
        );
        const authority = makeAuthority(
          database,
          [rollingPolicy("source:atomic:v1", "source", 1)],
          {
            read: () => epochMs(10_000),
          }
        );

        yield* admit(
          authority,
          "atomic-admitted",
          [charge("source:atomic:v1", "source:atomic")],
          [
            database
              .prepare("INSERT INTO test_outbox (id, admission_grant_id) VALUES (?, ?)")
              .bind("work-admitted", "atomic-admitted"),
          ]
        );

        const refused = yield* Effect.result(
          admit(
            authority,
            "atomic-refused",
            [charge("source:atomic:v1", "source:atomic")],
            [
              database
                .prepare("INSERT INTO test_outbox (id, admission_grant_id) VALUES (?, ?)")
                .bind("work-refused", "atomic-refused"),
            ]
          )
        );

        const rows = yield* fromTestPromise(() =>
          database
            .prepare("SELECT id, admission_grant_id FROM test_outbox ORDER BY id")
            .all<{ readonly id: string; readonly admission_grant_id: string }>()
        );

        expect(Result.isFailure(refused)).toBe(true);
        expect(rows.results).toEqual([
          { admission_grant_id: "atomic-admitted", id: "work-admitted" },
        ]);
      })
    ));

  it("rolls admission back when an atomically composed statement fails", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const miniflare = yield* fromTestPromise(() => makeMiniflare());
        const database = yield* fromTestPromise(() => prepareDatabase(miniflare));
        yield* fromTestPromise(() =>
          database.exec("CREATE TABLE unique_proof (id TEXT PRIMARY KEY NOT NULL) STRICT;")
        );
        yield* fromTestPromise(() =>
          database.prepare("INSERT INTO unique_proof (id) VALUES (?)").bind("duplicate").run()
        );
        const authority = makeAuthority(
          database,
          [rollingPolicy("operation:rollback:v1", "operation", 1)],
          { read: () => epochMs(10_000) }
        );

        const failed = yield* Effect.result(
          admit(
            authority,
            "rolled-back-grant",
            [charge("operation:rollback:v1", "operation:rollback")],
            [database.prepare("INSERT INTO unique_proof (id) VALUES (?)").bind("duplicate")]
          )
        );

        const retry = yield* admit(authority, "successful-after-rollback", [
          charge("operation:rollback:v1", "operation:rollback"),
        ]);

        const markerNamedStoreFailure = yield* Effect.result(
          admit(
            authority,
            "marker-named-store-failure",
            [charge("operation:rollback:v1", "operation:marker-store-failure")],
            [database.prepare("INSERT INTO resource_admission_refused (id) VALUES ('x')")]
          )
        );

        expect(Result.isFailure(failed)).toBe(true);
        if (Result.isFailure(failed)) {
          expect(failed.failure).toBeInstanceOf(ResourceAdmissionUnavailable);
        }
        expect(retry.grantId).toBe("successful-after-rollback");
        expect(Result.isFailure(markerNamedStoreFailure)).toBe(true);
        if (Result.isFailure(markerNamedStoreFailure)) {
          expect(markerNamedStoreFailure.failure).toBeInstanceOf(ResourceAdmissionUnavailable);
        }
      })
    ));

  it("preserves rolling and calendar decisions at their exact window boundaries", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const miniflare = yield* fromTestPromise(() => makeMiniflare());
        const database = yield* fromTestPromise(() => prepareDatabase(miniflare));
        let now = epochMs(1_000);
        const authority = makeAuthority(
          database,
          [
            rollingPolicy("source:boundary:v1", "source", 1),
            {
              dimension: "operation",
              durationMs: ResourceAdmissionDurationMs.make(1_000),
              key: policyKey("operation:calendar:v1"),
              kind: "calendar_window",
              limit: ResourceAdmissionLimit.make(1),
              originEpochMs: epochMs(0),
            },
          ],

          { read: () => now }
        );

        yield* admit(authority, "rolling-first", [
          charge("source:boundary:v1", "source:rolling-boundary"),
        ]);

        now = epochMs(1_999);
        const rollingBefore = yield* Effect.result(
          admit(authority, "rolling-before", [
            charge("source:boundary:v1", "source:rolling-boundary"),
          ])
        );

        now = epochMs(2_000);
        const rollingAt = yield* admit(authority, "rolling-at", [
          charge("source:boundary:v1", "source:rolling-boundary"),
        ]);

        now = epochMs(2_999);
        yield* admit(authority, "calendar-first", [
          charge("operation:calendar:v1", "operation:calendar-boundary"),
        ]);

        now = epochMs(3_000);
        const calendarAt = yield* admit(authority, "calendar-at", [
          charge("operation:calendar:v1", "operation:calendar-boundary"),
        ]);

        expect(Result.isFailure(rollingBefore)).toBe(true);
        expect(rollingAt.grantId).toBe("rolling-at");
        expect(calendarAt.grantId).toBe("calendar-at");
      })
    ));

  it("releases outstanding work without refunding time-window or spend admission", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const miniflare = yield* fromTestPromise(() => makeMiniflare());
        const database = yield* fromTestPromise(() => prepareDatabase(miniflare));
        yield* fromTestPromise(() =>
          database.exec("CREATE TABLE release_transition (id TEXT PRIMARY KEY NOT NULL) STRICT;")
        );
        yield* fromTestPromise(() =>
          database.prepare("INSERT INTO release_transition (id) VALUES ('duplicate')").run()
        );
        let now = epochMs(30_000);
        const authority = makeAuthority(
          database,
          [
            {
              dimension: "outstanding_work",
              key: policyKey("model-work:outstanding:v1"),
              kind: "outstanding",
              leaseMs: ResourceAdmissionDurationMs.make(60_000),
              limit: ResourceAdmissionLimit.make(1),
            },
            rollingPolicy("workers-ai:spend:v1", "spend", 1),
          ],

          { read: () => now }
        );
        yield* admit(authority, "release-first", [
          charge("model-work:outstanding:v1", "user:f1d1a002:model-work"),
          charge("workers-ai:spend:v1", "spend:workers-ai:user:f1d1a002"),
        ]);

        const failedRelease = yield* Effect.result(
          authority.releaseOutstandingWork({
            grantId: grantId("release-first"),
            statements: [
              database.prepare("INSERT INTO release_transition (id) VALUES ('partial')"),
              database.prepare("INSERT INTO release_transition (id) VALUES ('duplicate')"),
            ],
          })
        );

        const stillOccupied = yield* Effect.result(
          admit(authority, "release-still-occupied", [
            charge("model-work:outstanding:v1", "user:f1d1a002:model-work"),
          ])
        );

        const eventAfterFailure = yield* fromTestPromise(() =>
          database
            .prepare(
              `SELECT released_at_epoch_ms IS NULL AS is_unreleased
         FROM resource_admission_events
         WHERE grant_id = 'release-first' AND dimension = 'outstanding_work'`
            )
            .first<{ readonly is_unreleased: number }>()
        );
        const transitionRows = yield* fromTestPromise(() =>
          database
            .prepare("SELECT id FROM release_transition ORDER BY id")
            .all<{ readonly id: string }>()
        );

        expect(Result.isFailure(failedRelease)).toBe(true);
        if (Result.isFailure(failedRelease)) {
          expect(failedRelease.failure).toBeInstanceOf(ResourceAdmissionUnavailable);
        }
        expect(Result.isFailure(stillOccupied)).toBe(true);
        if (Result.isFailure(stillOccupied)) {
          expect(stillOccupied.failure).toBeInstanceOf(ResourceAdmissionRefused);
        }
        expect(eventAfterFailure?.is_unreleased).toBe(1);
        expect(transitionRows.results).toEqual([{ id: "duplicate" }]);

        now = epochMs(now + 1);
        yield* authority.releaseOutstandingWork({
          grantId: grantId("release-first"),
          statements: [],
        });

        const outstandingOnly = yield* admit(authority, "release-outstanding-reused", [
          charge("model-work:outstanding:v1", "user:f1d1a002:model-work"),
        ]);

        const spendAgain = yield* Effect.result(
          admit(authority, "release-spend-not-refunded", [
            charge("workers-ai:spend:v1", "spend:workers-ai:user:f1d1a002"),
          ])
        );

        expect(outstandingOnly.grantId).toBe("release-outstanding-reused");
        expect(Result.isFailure(spendAgain)).toBe(true);
      })
    ));

  it("rejects charge collections above the atomic bound", () => {
    const excessiveCharges = [
      charge("operation:bounded-0:v1", "operation:bounded-0"),
      ...Array.from({ length: 16 }, (_, index) =>
        charge(`operation:bounded-${index + 1}:v1`, `operation:bounded-${index + 1}`)
      ),
    ] as const;

    expect(() => ResourceAdmissionCharges.make(excessiveCharges)).toThrow();
  });

  it("rejects repeated policy keys in one charge collection", () => {
    expect(() =>
      ResourceAdmissionCharges.make([
        charge("operation:duplicate:v1", "operation:bounded-a"),
        charge("operation:duplicate:v1", "operation:bounded-b"),
      ])
    ).toThrow();
  });

  it("rejects repeated keys in the installed policy inventory", () => {
    const policy = rollingPolicy("operation:duplicate:v1", "operation", 1);

    expect(() => ResourceAdmissionPolicies.make([policy, policy])).toThrow();
  });

  it("rejects an oversized admission scope key", () => {
    expect(() => ResourceAdmissionScopeKey.make("x".repeat(257))).toThrow();
  });

  it("rejects non-positive admission units", () => {
    expect(() => ResourceAdmissionUnits.make(0)).toThrow();
  });

  it("rejects a negative decision timestamp", () => {
    expect(() => ResourceAdmissionEpochMs.make(-1)).toThrow();
  });

  it("rejects a non-positive policy duration", () => {
    expect(() => ResourceAdmissionDurationMs.make(0)).toThrow();
  });

  effectIt.layer(NodeFileSystem.layer)((it) => {
    it.effect("retains admitted usage when the Worker runtime restarts", () =>
      Effect.scoped(verifyPersistedRestart)
    );
  });
});
