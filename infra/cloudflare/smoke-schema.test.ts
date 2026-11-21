import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Miniflare, type WorkerOptions } from "miniflare";
import type { SharedBindings } from "../../apps/server/cloudflare/storage-bootstrap/contract";
import { NodeFileSystem } from "@effect/platform-node";
import { nativeUserPlatform } from "../../apps/server/cloudflare/user-store.test-fixture";
import { handleSmoke } from "../../apps/server/cloudflare/runtime/release-smoke/operations";
import type { SmokeEnvironment } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import {
  SyntheticBindings,
  smokeEnvironment,
  unavailableQueue,
} from "./incomplete-platform-fixture";

const awaitSmokeCompletion = (
  poll: () => Promise<Response>,
  attempt = 0
): Effect.Effect<void, Cause.UnknownError> =>
  attempt >= 200
    ? Effect.die("Native smoke completion exceeded the local poll budget")
    : Effect.gen(function* () {
        const response = yield* Effect.tryPromise(poll);
        const body: unknown = yield* Effect.tryPromise(() => response.json());

        if (Schema.is(Schema.Struct({ status: Schema.Literal("passed") }))(body)) return;
        expect(response.status).toBe(200);
        yield* Effect.sleep("10 millis");

        return yield* awaitSmokeCompletion(poll, attempt + 1);
      });

const executorFor = (
  release: SmokeEnvironment,
  retained: boolean
): Readonly<{
  revision: string;
  version: string;
  queueName: string;
  coreSettings: Pick<SmokeEnvironment, "NATIVE_STORAGE_ADMISSION" | "NATIVE_FIXTURE_MEMBER">;
}> => {
  const revision = "de04a192c3836be0efb488b170a7b93b9f98f28f";

  return retained
    ? {
        revision,
        version: "54c5d73f-2682-4626-85bc-f8462914b1d4",
        queueName: "fidy-native-smoke-" + revision,
        coreSettings: {
          NATIVE_STORAGE_ADMISSION: "closed",
          NATIVE_FIXTURE_MEMBER: "performance-2",
        },
      }
    : {
        revision: release.RELEASE_GIT_SHA,
        version: "11111111-1111-4111-8111-111111111111",
        queueName: release.RELEASE_GIT_SHA,
        coreSettings: {},
      };
};

const nativeSmokeJourney = Effect.fnUntraced(function* (retainExecutor: boolean) {
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

  const {
    revision: executorRevision,
    version: executorVersion,
    queueName,
    coreSettings,
  } = executorFor(release, retainExecutor);

  const priorRevision = "f".repeat(40);

  const nativeWorker = (revision: string, version: string, queue: string): WorkerOptions => ({
    config: {
      name: revision,
      type: "worker",
      compatibilityDate: "2026-09-08",
      env: {
        SMOKE_BUCKET: { type: "r2", name: "native-smoke" },
        SMOKE_LIMITER: {
          type: "rate-limit",
          namespace: "1493",
          simple: { limit: 8, period: 60 },
        },
        SMOKE_QUEUE: { type: "queue", name: queue },
        SMOKE_QUEUE_NAME: { type: "text", value: queue },
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
          name: queue,
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
      nativeWorker(executorRevision, executorVersion, queueName),
      nativeWorker(priorRevision, "22222222-2222-4222-8222-222222222222", priorRevision),
    ],
  });

  yield* Effect.addFinalizer(() => Effect.tryPromise(() => mf.dispose()).pipe(Effect.orDie));
  yield* Effect.tryPromise(() => mf.ready);
  const owners = yield* (yield* nativeUserPlatform)();

  const ownersBindings = yield* Effect.tryPromise(() =>
    owners.getBindings<Required<SharedBindings>>("core")
  );

  const bindings = yield* Effect.tryPromise(() =>
    mf.getBindings<{
      SMOKE_BUCKET: R2Bucket;
      SMOKE_WORKFLOW: Workflow;
      SMOKE_QUEUE: Queue;
      SMOKE_LIMITER: RateLimit;
    }>(executorRevision)
  );

  let publications = 0;
  let bankCalls = 0;
  let offered: unknown;

  const environment = smokeEnvironment({
    ...coreSettings,
    USER_STORE: ownersBindings.USER_STORE,
    DIRECTORY: ownersBindings.DIRECTORY,
    PRICING: ownersBindings.PRICING,
    MAINTENANCE: ownersBindings.MAINTENANCE,
    ERASURE: ownersBindings.ERASURE,
    SMOKE_LIMITER: bindings.SMOKE_LIMITER,
    SMOKE_QUEUE_NAME: queueName,
    SMOKE_WORKFLOW: bindings.SMOKE_WORKFLOW,
    SMOKE_BUCKET: bindings.SMOKE_BUCKET,
    SMOKE_QUEUE: SyntheticBindings.withMethods(unavailableQueue, {
      send: (work: unknown): Promise<void> => {
        offered = work;
        publications++;

        return Promise.resolve();
      },
    }),
  });

  const probe = (id: string, bindings = environment): Promise<Response> =>
    handleSmoke({
      bankAuthentication: Option.some(
        Effect.sync(() => {
          bankCalls += 1;
        })
      ),
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
  expect(bankCalls).toBe(0);
  expect(offered).toMatchObject({
    gitRevision: executorRevision,
    coreVersionId: environment.CF_VERSION_METADATA.id,
    contractDigest: environment.CONTRACT_DIGEST,
  });

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

  expect(yield* Effect.tryPromise(() => poll().then((response) => response.json()))).toMatchObject({
    status: "pending",
  });
  const markerKey = `_release-smoke/${executorRevision}/smoke-v2-${environment.CF_VERSION_METADATA.id}-${"a".repeat(32)}`;
  expect(
    yield* Effect.tryPromise(() =>
      bindings.SMOKE_BUCKET.get(markerKey).then((marker) => marker?.text())
    )
  ).toBe(environment.CONTRACT_DIGEST);
  const now = yield* Clock.currentTimeMillis;
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
    executor: { ...core, gitRevision: executorRevision, workerVersionId: executorVersion },
    expiresAtMs: now + 300000,
  };

  const otherExecutorVersion = "44444444-4444-4444-8444-444444444444";

  const staleOutputs = [
    { ...completed, probeId: "b".repeat(32) },
    { ...completed, executor: { ...completed.executor, gitRevision: "f".repeat(40) } },
    { ...completed, executor: { ...completed.executor, contractDigest: "f".repeat(64) } },
    { ...completed, coreVersionId: executorVersion },
    { ...completed, expiresAtMs: now - 1 },
    { ...completed, expiresAtMs: now + 600000 },
  ];

  const retainedExecutorOutput = {
    ...completed,
    executor: { ...completed.executor, workerVersionId: otherExecutorVersion },
  };

  yield* Effect.forEach(
    retainExecutor ? [...staleOutputs, retainedExecutorOutput, {}] : [...staleOutputs, {}],
    Effect.fnUntraced(function* (output) {
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
    }),
    { discard: true }
  );

  yield* Effect.forEach(
    retainExecutor
      ? [
          { NATIVE_STORAGE_ADMISSION: "open" },
          { NATIVE_FIXTURE_MEMBER: "performance-1" },
          { SMOKE_QUEUE_NAME: "fidy-native-smoke-" + release.RELEASE_GIT_SHA },
        ]
      : [],
    Effect.fnUntraced(function* (disabled) {
      const rejected = yield* Effect.tryPromise(() => poll({ ...environment, ...disabled }));
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get("x-fidy-smoke-failure")).toBe("probe_state");
    }),
    { discard: true }
  );

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
  expect(yield* Effect.tryPromise(() => poll().then((response) => response.json()))).toMatchObject({
    status: "passed",
    core,
  });

  const readOnly = yield* Effect.tryPromise(() =>
    probe("c", {
      ...environment,
      USER_STORE: {
        getByName: (): Pick<Fetcher, "fetch"> => ({
          fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 503 })),
        }),
      },
    })
  );

  expect(readOnly.status).toBe(503);
  expect(readOnly.headers.get("x-fidy-smoke-failure")).toBe("schema");
  expect(publications).toBe(1);

  const refused = yield* Effect.tryPromise(() =>
    probe("b", {
      ...environment,
      DIRECTORY: {
        getByName: (): Pick<Fetcher, "fetch"> => ({
          fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 503 })),
        }),
      },
    })
  );

  expect(refused.status).toBe(503);
  expect(refused.headers.get("x-fidy-smoke-failure")).toBe("schema");
  expect(publications).toBe(1);

  yield* Effect.forEach(
    Array.from({ length: 8 }),
    () => Effect.tryPromise(() => bindings.SMOKE_LIMITER.limit({ key: "release-smoke" })),
    { discard: true }
  );

  const limited = yield* Effect.tryPromise(() =>
    probe("d", {
      ...environment,
      USER_STORE: {
        getByName: () => {
          throw new Error("Admission must precede native owner effects");
        },
      },
    })
  );

  expect(limited.status).toBe(503);
  expect(limited.headers.get("x-fidy-smoke-failure")).toBe("admission");
  expect(publications).toBe(1);

  expect(yield* Effect.tryPromise(() => refused.text())).not.toContain("payment_source_context");
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "verifies native storage and version-scoped Queue and Workflow completion before accepting a candidate",
    () => nativeSmokeJourney(false)
  );
  test.effect(
    "attests the closed candidate Core through the exact retained Queue and Workflow executor",
    () => nativeSmokeJourney(true)
  );
});
