// Miniflare integration setup requires temporary filesystem fixtures.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { Effect, Fiber, Result } from "effect";
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

const workerScript = "export default { fetch() { return new Response('ok') } }";
const migrationUrl = new URL("./migrations/0002_resource_admission.sql", import.meta.url);
const workerFixtureUrl = new URL("./resource-admission-worker.fixture.ts", import.meta.url);
const activeMiniflare = new Set<Miniflare>();
const persistencePaths = new Set<string>();

// Miniflare exposes a Promise-native lifecycle at this integration boundary.
// @effect-diagnostics-next-line asyncFunction:off
const makeMiniflare = async (resourcePersistencePath?: string): Promise<Miniflare> => {
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
  await miniflare.ready;
  return miniflare;
};

// @effect-diagnostics-next-line asyncFunction:off
const migrateDatabase = async (database: D1Database): Promise<void> => {
  const migration = (await readFile(migrationUrl, "utf8")).replace(/^--.*$/gmu, "");
  await migration
    .trim()
    .split(/\n\s*\n/u)
    .reduce<Promise<unknown>>(
      (previous, statement) => previous.then(() => database.prepare(statement).run()),
      Promise.resolve()
    );
};

// @effect-diagnostics-next-line asyncFunction:off
const prepareDatabase = async (miniflare: Miniflare): Promise<D1Database> => {
  const database = await miniflare.getD1Database("DB");
  await migrateDatabase(database);
  return database;
};

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

// @effect-diagnostics-next-line asyncFunction:off
afterEach(async () => {
  await Promise.all([...activeMiniflare].map((miniflare): Promise<void> => miniflare.dispose()));
  activeMiniflare.clear();
  await Promise.all(
    [...persistencePaths].map((path) => rm(path, { force: true, recursive: true }))
  );
  persistencePaths.clear();
});

describe("Cloudflare resource admission", () => {
  // @effect-diagnostics-next-line asyncFunction:off
  it("admits only the burst limit across concurrent Worker instances", async () => {
    const bundle = await rolldown({
      input: workerFixtureUrl.pathname,
      platform: "browser",
      resolve: { conditionNames: ["workerd", "worker", "browser"] },
    });
    const build = await bundle.generate({ format: "esm" });
    await bundle.close();
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
    await miniflare.ready;
    const bindings = await miniflare.getBindings<{ readonly DB: D1Database }>(
      "admission-instance-one"
    );
    await migrateDatabase(bindings.DB);
    const workers = [
      await miniflare.getWorker("admission-instance-one"),
      await miniflare.getWorker("admission-instance-two"),
    ] as const;

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        workers[index % 2 === 0 ? 0 : 1].fetch(`https://admission.test/?id=burst-${index}`)
      )
    );

    expect(responses.filter(({ status }) => status === 201)).toHaveLength(5);
    expect(responses.filter(({ status }) => status === 429)).toHaveLength(35);
  }, 15_000);

  // @effect-diagnostics-next-line asyncFunction:off
  it("waits for an uncancellable D1 batch to settle before interruption completes", async () => {
    const miniflare = await makeMiniflare();
    const database = await prepareDatabase(miniflare);
    const batchStarted = Promise.withResolvers<void>();
    const batchCompletion = Promise.withResolvers<void>();
    let batchSettled = false;
    let interruptionSettled = false;
    const controlledDatabase = new Proxy(database, {
      get: (target, property): unknown =>
        property === "batch"
          ? (): Promise<ReadonlyArray<D1Result<unknown>>> => {
              batchStarted.resolve();
              return batchCompletion.promise.then(() => {
                batchSettled = true;
                return [];
              });
            }
          : Reflect.get(target, property, target),
    });
    const authority = makeAuthority(
      controlledDatabase,
      [rollingPolicy("operation:interruption:v1", "operation", 1)],
      { read: () => epochMs(10_000) }
    );
    const fiber = Effect.runFork(
      admit(authority, "interrupted-admission", [
        charge("operation:interruption:v1", "operation:interruption"),
      ])
    );

    await batchStarted.promise;
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interruptionSettled = true;
    });
    await Promise.resolve();

    expect(interruptionSettled).toBe(false);
    expect(batchSettled).toBe(false);
    batchCompletion.resolve();
    await interruption;
    expect(batchSettled).toBe(true);
  });

  // @effect-diagnostics-next-line asyncFunction:off
  it("independently charges every installed admission dimension", async () => {
    const miniflare = await makeMiniflare();
    const database = await prepareDatabase(miniflare);
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
    await Effect.runPromise(admit(authority, "all-dimensions-first", charges));

    const results = await Promise.all(
      charges.map((oneCharge, index) =>
        Effect.runPromise(Effect.result(admit(authority, `dimension-${index}`, [oneCharge])))
      )
    );

    expect(results).toHaveLength(5);
    expect(
      results.every(
        (result) => Result.isFailure(result) && result.failure instanceof ResourceAdmissionRefused
      )
    ).toBe(true);
  });

  // @effect-diagnostics-next-line asyncFunction:off
  it("makes a grant and its proof or outbox publication one atomic D1 commit", async () => {
    const miniflare = await makeMiniflare();
    const database = await prepareDatabase(miniflare);
    await database
      .prepare(
        `CREATE TABLE test_outbox (
          id TEXT PRIMARY KEY NOT NULL,
          admission_grant_id TEXT NOT NULL REFERENCES resource_admission_grants(id)
        ) STRICT`
      )
      .run();
    const authority = makeAuthority(database, [rollingPolicy("source:atomic:v1", "source", 1)], {
      read: () => epochMs(10_000),
    });

    await Effect.runPromise(
      admit(
        authority,
        "atomic-admitted",
        [charge("source:atomic:v1", "source:atomic")],
        [
          database
            .prepare("INSERT INTO test_outbox (id, admission_grant_id) VALUES (?, ?)")
            .bind("work-admitted", "atomic-admitted"),
        ]
      )
    );
    const refused = await Effect.runPromise(
      Effect.result(
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
      )
    );
    const rows = await database
      .prepare("SELECT id, admission_grant_id FROM test_outbox ORDER BY id")
      .all<{ readonly id: string; readonly admission_grant_id: string }>();

    expect(Result.isFailure(refused)).toBe(true);
    expect(rows.results).toEqual([{ admission_grant_id: "atomic-admitted", id: "work-admitted" }]);
  });

  // @effect-diagnostics-next-line asyncFunction:off
  it("rolls admission back when an atomically composed statement fails", async () => {
    const miniflare = await makeMiniflare();
    const database = await prepareDatabase(miniflare);
    await database.exec("CREATE TABLE unique_proof (id TEXT PRIMARY KEY NOT NULL) STRICT;");
    await database.prepare("INSERT INTO unique_proof (id) VALUES (?)").bind("duplicate").run();
    const authority = makeAuthority(
      database,
      [rollingPolicy("operation:rollback:v1", "operation", 1)],
      { read: () => epochMs(10_000) }
    );

    const failed = await Effect.runPromise(
      Effect.result(
        admit(
          authority,
          "rolled-back-grant",
          [charge("operation:rollback:v1", "operation:rollback")],
          [database.prepare("INSERT INTO unique_proof (id) VALUES (?)").bind("duplicate")]
        )
      )
    );
    const retry = await Effect.runPromise(
      admit(authority, "successful-after-rollback", [
        charge("operation:rollback:v1", "operation:rollback"),
      ])
    );
    const markerNamedStoreFailure = await Effect.runPromise(
      Effect.result(
        admit(
          authority,
          "marker-named-store-failure",
          [charge("operation:rollback:v1", "operation:marker-store-failure")],
          [database.prepare("INSERT INTO resource_admission_refused (id) VALUES ('x')")]
        )
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
  });

  // @effect-diagnostics-next-line asyncFunction:off
  it("preserves rolling and calendar decisions at their exact window boundaries", async () => {
    const miniflare = await makeMiniflare();
    const database = await prepareDatabase(miniflare);
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

    await Effect.runPromise(
      admit(authority, "rolling-first", [charge("source:boundary:v1", "source:rolling-boundary")])
    );
    now = epochMs(1_999);
    const rollingBefore = await Effect.runPromise(
      Effect.result(
        admit(authority, "rolling-before", [
          charge("source:boundary:v1", "source:rolling-boundary"),
        ])
      )
    );
    now = epochMs(2_000);
    const rollingAt = await Effect.runPromise(
      admit(authority, "rolling-at", [charge("source:boundary:v1", "source:rolling-boundary")])
    );
    now = epochMs(2_999);
    await Effect.runPromise(
      admit(authority, "calendar-first", [
        charge("operation:calendar:v1", "operation:calendar-boundary"),
      ])
    );
    now = epochMs(3_000);
    const calendarAt = await Effect.runPromise(
      admit(authority, "calendar-at", [
        charge("operation:calendar:v1", "operation:calendar-boundary"),
      ])
    );

    expect(Result.isFailure(rollingBefore)).toBe(true);
    expect(rollingAt.grantId).toBe("rolling-at");
    expect(calendarAt.grantId).toBe("calendar-at");
  });

  // @effect-diagnostics-next-line asyncFunction:off
  it("releases outstanding work without refunding time-window or spend admission", async () => {
    const miniflare = await makeMiniflare();
    const database = await prepareDatabase(miniflare);
    await database.exec("CREATE TABLE release_transition (id TEXT PRIMARY KEY NOT NULL) STRICT;");
    await database.prepare("INSERT INTO release_transition (id) VALUES ('duplicate')").run();
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
    await Effect.runPromise(
      admit(authority, "release-first", [
        charge("model-work:outstanding:v1", "user:f1d1a002:model-work"),
        charge("workers-ai:spend:v1", "spend:workers-ai:user:f1d1a002"),
      ])
    );
    const failedRelease = await Effect.runPromise(
      Effect.result(
        authority.releaseOutstandingWork({
          grantId: grantId("release-first"),
          statements: [
            database.prepare("INSERT INTO release_transition (id) VALUES ('partial')"),
            database.prepare("INSERT INTO release_transition (id) VALUES ('duplicate')"),
          ],
        })
      )
    );
    const stillOccupied = await Effect.runPromise(
      Effect.result(
        admit(authority, "release-still-occupied", [
          charge("model-work:outstanding:v1", "user:f1d1a002:model-work"),
        ])
      )
    );
    const eventAfterFailure = await database
      .prepare(
        `SELECT released_at_epoch_ms IS NULL AS is_unreleased
         FROM resource_admission_events
         WHERE grant_id = 'release-first' AND dimension = 'outstanding_work'`
      )
      .first<{ readonly is_unreleased: number }>();
    const transitionRows = await database
      .prepare("SELECT id FROM release_transition ORDER BY id")
      .all<{ readonly id: string }>();

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
    await Effect.runPromise(
      authority.releaseOutstandingWork({ grantId: grantId("release-first"), statements: [] })
    );

    const outstandingOnly = await Effect.runPromise(
      admit(authority, "release-outstanding-reused", [
        charge("model-work:outstanding:v1", "user:f1d1a002:model-work"),
      ])
    );
    const spendAgain = await Effect.runPromise(
      Effect.result(
        admit(authority, "release-spend-not-refunded", [
          charge("workers-ai:spend:v1", "spend:workers-ai:user:f1d1a002"),
        ])
      )
    );

    expect(outstandingOnly.grantId).toBe("release-outstanding-reused");
    expect(Result.isFailure(spendAgain)).toBe(true);
  });

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

  // @effect-diagnostics-next-line asyncFunction:off
  it("retains admitted usage when the Worker runtime restarts", async () => {
    const persistencePath = await mkdtemp(join(tmpdir(), "fidy-admission-"));
    persistencePaths.add(persistencePath);
    const firstRuntime = await makeMiniflare(persistencePath);
    const firstDatabase = await prepareDatabase(firstRuntime);
    const policy = rollingPolicy("stable-user:restart:v1", "stable_user", 1);
    const firstAuthority = makeAuthority(firstDatabase, [policy], {
      read: () => epochMs(10_000),
    });
    await Effect.runPromise(
      admit(firstAuthority, "before-restart", [charge("stable-user:restart:v1", "user:restart")])
    );
    await firstRuntime.dispose();
    activeMiniflare.delete(firstRuntime);

    const replacementRuntime = await makeMiniflare(persistencePath);
    const replacementDatabase = await replacementRuntime.getD1Database("DB");
    const replacementAuthority = makeAuthority(replacementDatabase, [policy], {
      read: () => epochMs(10_000),
    });
    const afterRestart = await Effect.runPromise(
      Effect.result(
        admit(replacementAuthority, "after-restart", [
          charge("stable-user:restart:v1", "user:restart"),
        ])
      )
    );

    expect(Result.isFailure(afterRestart)).toBe(true);
    if (Result.isFailure(afterRestart)) {
      expect(afterRestart.failure).toBeInstanceOf(ResourceAdmissionRefused);
    }
  });
});
