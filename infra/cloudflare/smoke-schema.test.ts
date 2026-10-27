import { documentedSqlBlock } from "../../apps/server/cloudflare/schema-cutover.test-fixture";
import { Clock, Effect, Option, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Miniflare, type WorkerOptions } from "miniflare";
import { installTestSchema } from "../../apps/server/cloudflare/d1-test-fixture";
import { handleSmoke } from "../../apps/server/cloudflare/runtime/release-smoke/operations";
import {
  SyntheticBindings,
  smokeEnvironment,
  unavailableBucket,
  unavailableQueue,
} from "./incomplete-platform-fixture";

const rehearseSmokeCutover = Effect.fn(function* (db: D1Database) {
  const guide = yield* Effect.tryPromise(() =>
    Bun.file(new URL("../../docs/operations/database-cutover-1428.md", import.meta.url)).text()
  );
  const block = (name: string): ReadonlyArray<string> =>
    documentedSqlBlock({ guide, marker: "release-smoke-ledger-" + name });
  yield* Effect.tryPromise(() => db.batch(block("rollback").map((sql) => db.prepare(sql))));
  yield* Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO release_smoke_probes(rowid,probe_id,git_revision,expires_at_ms,status) VALUES(17,?,?,111,'queued'),(91,?,?,100,'passed')"
      )
      .bind("a".repeat(32), "c".repeat(40), "b".repeat(32), "d".repeat(40))
      .run()
  );
  const read = (): Promise<D1Result> =>
    db.prepare("SELECT rowid,* FROM release_smoke_probes ORDER BY rowid").all();
  const before = (yield* Effect.tryPromise(read)).results;
  const guard = (current: number): ReadonlyArray<D1PreparedStatement> =>
    block("guard").map((sql) => db.prepare(sql).bind(current));
  const drop = (): ReadonlyArray<D1PreparedStatement> =>
    block("drop").map((sql) => db.prepare(sql));
  yield* Effect.tryPromise(() => expect(db.batch([...guard(100), ...drop()])).rejects.toThrow());
  expect((yield* Effect.tryPromise(read)).results).toEqual(before);
  yield* Effect.tryPromise(() =>
    expect(
      db.batch([
        ...guard(112),
        ...drop(),
        db.prepare(
          "INSERT INTO sql_assertions(scope,accepted) VALUES('interrupt_smoke_retirement',0)"
        ),
      ])
    ).rejects.toThrow()
  );
  expect((yield* Effect.tryPromise(read)).results).toEqual(before);
  yield* Effect.tryPromise(() => db.batch([...guard(112), ...drop()]));
  const original = yield* Schema.decodeUnknownEffect(Schema.Json)(before);
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(original);
  yield* Effect.tryPromise(() =>
    db.batch([
      ...block("rollback").map((sql) => db.prepare(sql)),
      ...block("rollback-copy").map((sql) => db.prepare(sql).bind(encoded)),
    ])
  );
  expect((yield* Effect.tryPromise(read)).results).toEqual(before);
  yield* Effect.tryPromise(() => db.batch([...guard(112), ...drop()]));
});

const awaitSmokeCompletion = Effect.fn(function* (poll: () => Promise<Response>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = yield* Effect.tryPromise(poll);
    const body: unknown = yield* Effect.tryPromise(() => response.json());
    if (Schema.is(Schema.Struct({ status: Schema.Literal("passed") }))(body)) return;
    expect(response.status).toBe(200);
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die("Native smoke completion exceeded the local poll budget");
});

it.live("refuses a candidate whose protected-read dependencies are absent from existing D1", () =>
  Effect.gen(function* () {
    const bundle = yield* Effect.tryPromise(() =>
      Bun.build({
        entrypoints: [
          new URL("../../apps/server/cloudflare/release-smoke-worker.ts", import.meta.url).pathname,
        ],
        target: "browser",
        external: ["cloudflare:workers"],
      })
    );
    const output = bundle.outputs[0];
    if (!bundle.success || output === undefined) {
      return yield* Effect.die("Native smoke build failed");
    }
    const script = yield* Effect.tryPromise(() => output.text());
    const release = smokeEnvironment();
    const executorVersion = "11111111-1111-4111-8111-111111111111";
    const priorRevision = "f".repeat(40);
    const nativeWorker = (revision: string, version: string): WorkerOptions => ({
      config: {
        name: revision,
        type: "worker",
        compatibilityDate: "2026-09-08",
        env: {
          DB: { type: "d1", id: "smoke-schema" },
          SMOKE_LIMITER: {
            type: "rate-limit",
            namespace: "1493",
            simple: { limit: 8, period: 60 },
          },
          SMOKE_QUEUE: { type: "queue", name: revision },
          SMOKE_QUEUE_NAME: { type: "text", value: revision },
          SMOKE_WORKFLOW: {
            type: "workflow",
            name: revision,
            worker: revision,
            exportName: "ReleaseSmokeWorkflowV2",
          },
          CF_VERSION_METADATA: { type: "json", value: { id: version } },
          RELEASE_GIT_SHA: { type: "text", value: revision },
          CONTRACT_DIGEST: { type: "text", value: release.CONTRACT_DIGEST },
        },
        triggers: [
          {
            type: "queue",
            name: revision,
            maxBatchSize: 1,
            maxBatchTimeout: 0,
            maxConcurrency: 4,
            maxRetries: 3,
          },
        ],
        manifest: {
          mainModule: "index.mjs",
          modules: {
            "runtime.mjs": { type: "esm", contents: script },
            "index.mjs": {
              contents: 'export { default, ReleaseSmokeWorkflowV2 } from "./runtime.mjs";',
              type: "esm",
            },
          },
        },
      },
    });
    const mf = new Miniflare({
      workers: [
        nativeWorker(release.RELEASE_GIT_SHA, executorVersion),
        nativeWorker(priorRevision, "22222222-2222-4222-8222-222222222222"),
      ],
    });
    yield* Effect.addFinalizer(() => Effect.tryPromise(() => mf.dispose()).pipe(Effect.orDie));
    yield* Effect.tryPromise(() => mf.ready);
    const db = yield* Effect.tryPromise(() => mf.getD1Database("DB", release.RELEASE_GIT_SHA));
    yield* Effect.tryPromise(() => installTestSchema({ db }));
    yield* rehearseSmokeCutover(db);
    const bindings = yield* Effect.tryPromise(() =>
      mf.getBindings<{ SMOKE_WORKFLOW: Workflow; SMOKE_QUEUE: Queue; SMOKE_LIMITER: RateLimit }>(
        release.RELEASE_GIT_SHA
      )
    );
    let publications = 0;
    let offered: unknown;
    const environment = smokeEnvironment({
      DB: db,
      SMOKE_LIMITER: bindings.SMOKE_LIMITER,
      SMOKE_QUEUE_NAME: release.RELEASE_GIT_SHA,
      SMOKE_WORKFLOW: bindings.SMOKE_WORKFLOW,
      SMOKE_BUCKET: SyntheticBindings.withMethods(unavailableBucket, {
        put: (): Promise<void> => Promise.resolve(),
        get: (): Promise<object> => Promise.resolve({}),
      }),
      SMOKE_QUEUE: SyntheticBindings.withMethods(unavailableQueue, {
        send: (work: unknown): Promise<void> => {
          offered = work;
          publications++;
          return Promise.resolve();
        },
      }),
      USER_TRANSACTION_COORDINATOR: {
        getByName: (): { fetch: () => Promise<Response> } => ({
          fetch: (): Promise<Response> => Promise.resolve(new Response()),
        }),
      },
    });
    const probe = (id: string, bindings = environment): Promise<Response> =>
      handleSmoke({
        bankAuthentication: Option.none(),
        environment: bindings,
        request: new Request("https://core.internal/internal/release-smoke", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-fidy-smoke-proof": environment.SMOKE_PROOF,
          },
          body: JSON.stringify({
            protocolVersion: 1,
            probeId: id.repeat(32),
            expectedPublicVersionId: bindings.CF_VERSION_METADATA.id,
            expectedCoreVersionId: bindings.CF_VERSION_METADATA.id,
            expectedGitRevision: bindings.RELEASE_GIT_SHA,
            expectedContractDigest: bindings.CONTRACT_DIGEST,
          }),
        }),
      });
    expect((yield* Effect.tryPromise(() => probe("a"))).status).toBe(202);
    expect(publications).toBe(1);
    const poll = (overrides = environment): Promise<Response> =>
      handleSmoke({
        bankAuthentication: Option.none(),
        environment: overrides,
        request: new Request(
          "https://core.internal/internal/release-smoke?probeId=" + "a".repeat(32),
          {
            headers: { "x-fidy-smoke-proof": environment.SMOKE_PROOF },
          }
        ),
      });
    expect(
      yield* Effect.tryPromise(() => poll().then((response) => response.json()))
    ).toMatchObject({ status: "pending" });
    const now = yield* Clock.currentTimeMillis;
    // Native Queue transport invokes the dedicated executor, not candidate Core by hand.
    yield* Effect.tryPromise(() => bindings.SMOKE_QUEUE.send(offered));
    yield* Effect.tryPromise(() => bindings.SMOKE_QUEUE.send(offered));
    yield* awaitSmokeCompletion(() => poll());
    const core = {
      gitRevision: release.RELEASE_GIT_SHA,
      contractDigest: release.CONTRACT_DIGEST,
      workerVersionId: release.CF_VERSION_METADATA.id,
    };
    const completed = {
      probeId: "a".repeat(32),
      coreVersionId: core.workerVersionId,
      executor: { ...core, workerVersionId: executorVersion },
      expiresAtMs: now + 300000,
    };
    for (const output of [
      { ...completed, probeId: "b".repeat(32) },
      { ...completed, executor: { ...completed.executor, gitRevision: "f".repeat(40) } },
      { ...completed, executor: { ...completed.executor, contractDigest: "f".repeat(64) } },
      { ...completed, coreVersionId: executorVersion },
      { ...completed, expiresAtMs: now - 1 },
      { ...completed, expiresAtMs: now + 600000 },
      {},
    ]) {
      const stale = yield* Effect.tryPromise(() =>
        poll({
          ...environment,
          SMOKE_WORKFLOW: SyntheticBindings.withMethods(bindings.SMOKE_WORKFLOW, {
            get: (): Promise<object> =>
              Promise.resolve({
                status: (): Promise<object> => Promise.resolve({ status: "complete", output }),
              }),
          }),
        })
      );
      expect(stale.status).toBe(503);
      expect(stale.headers.get("x-fidy-smoke-failure")).toBe("probe_state");
    }
    // A subsequent release does not move or overwrite the preceding native execution path.
    const prior = yield* Effect.tryPromise(() =>
      mf.getBindings<{ SMOKE_WORKFLOW: Workflow; SMOKE_QUEUE: Queue }>(priorRevision)
    );
    const priorEnvironment = {
      ...environment,
      RELEASE_GIT_SHA: priorRevision,
      CF_VERSION_METADATA: { id: "33333333-3333-4333-8333-333333333333" },
      SMOKE_QUEUE: prior.SMOKE_QUEUE,
      SMOKE_QUEUE_NAME: priorRevision,
      SMOKE_WORKFLOW: prior.SMOKE_WORKFLOW,
    };
    expect((yield* Effect.tryPromise(() => probe("a", priorEnvironment))).status).toBe(202);
    yield* awaitSmokeCompletion(() => poll(priorEnvironment));
    expect(
      yield* Effect.tryPromise(() => poll().then((response) => response.json()))
    ).toMatchObject({ status: "passed", core });
    const readOnly = yield* Effect.tryPromise(() =>
      probe("c", {
        ...environment,
        DB: SyntheticBindings.withMethods(db, {
          batch: (): Promise<never> => Promise.reject(new Error("synthetic native write refusal")),
        }),
      })
    );
    expect(readOnly.status).toBe(503);
    expect(readOnly.headers.get("x-fidy-smoke-failure")).toBe("schema");
    expect(publications).toBe(1);
    yield* Effect.tryPromise(() => db.prepare("DROP VIEW payment_source_context").run());
    const refused = yield* Effect.tryPromise(() => probe("b"));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("x-fidy-smoke-failure")).toBe("schema");
    expect(publications).toBe(1);
    for (let attempt = 0; attempt < 8; attempt++) {
      yield* Effect.tryPromise(() => bindings.SMOKE_LIMITER.limit({ key: "release-smoke" }));
    }
    const limited = yield* Effect.tryPromise(() =>
      probe("d", {
        ...environment,
        DB: SyntheticBindings.withMethods(db, {
          prepare: (): never => {
            throw new Error("Admission must precede D1 effects");
          },
        }),
      })
    );
    expect(limited.status).toBe(503);
    expect(limited.headers.get("x-fidy-smoke-failure")).toBe("admission");
    expect(publications).toBe(1);

    expect(yield* Effect.tryPromise(() => refused.text())).not.toContain("payment_source_context");
  })
);
