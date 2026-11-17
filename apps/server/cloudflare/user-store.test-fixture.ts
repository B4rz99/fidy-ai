import { Effect, FileSystem, type Scope } from "effect";
import { Miniflare } from "miniflare";
import { browserOrigins } from "./runtime/contract";

export const native = <Value>(run: () => Promise<Value>): Effect.Effect<Value> =>
  Effect.tryPromise(run).pipe(Effect.orDie);

export const workerManifest = Effect.fn(function* (module: string) {
  const result = yield* native(() =>
    Bun.build({
      entrypoints: [new URL(module, import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers", "node:*"],
    })
  );
  const output = result.outputs[0];
  if (!result.success || output === undefined) {
    return yield* Effect.die(new Error("Native Worker build failed"));
  }
  const contents = yield* native(() => output.text());
  return { mainModule: "index.mjs", modules: { "index.mjs": { type: "esm" as const, contents } } };
});

const billingProvider = Effect.fnUntraced(function* (withBilling: boolean) {
  return withBilling
    ? [
        {
          config: {
            type: "worker" as const,
            name: "wompi-fixture",
            compatibilityDate: "2026-09-08",
            exports: { CancellationProviderFixture: { type: "worker" as const } },
            env: { PROVIDER_STATE: { type: "d1" as const, id: "wompi-cancellation-fixture" } },
            manifest: yield* workerManifest("./subscription/wompi-cancellation.test-fixture.ts"),
          },
        },
      ]
    : [];
});

const providerOnlyOutbound = {
  dev: {
    outboundService: {
      type: "worker" as const,
      worker: "wompi-fixture",
      exportName: "CancellationProviderFixture",
    },
  },
};

const billingTrigger = {
  triggers: [
    {
      type: "queue" as const,
      name: "billing-test",
      maxBatchSize: 4,
      maxBatchTimeout: 0,
      maxRetries: 2,
      retryDelay: 0,
    },
  ],
};

const billingBindings = {
  DB: { type: "d1" as const, id: "unused-legacy" },
  BILLING_COLLECTION_QUEUE: { type: "queue" as const, name: "billing-test" },
  BILLING_COLLECTION_WORKFLOW: {
    type: "workflow" as const,
    name: "billing-cancellation",
    worker: "core",
    exportName: "BillingCollectionWorkflowV1",
  },
  WOMPI_ENVIRONMENT: { type: "text" as const, value: "sandbox" },
  WOMPI_PUBLIC_KEY: { type: "text" as const, value: "pub_test_fixture" },
  WOMPI_PRIVATE_KEY: { type: "text" as const, value: "prv_test_fixture" },
  WOMPI_INTEGRITY_SECRET: {
    type: "text" as const,
    value: "test_integrity_fixture",
  },
};

/** Production ingress and Core in separate workerd isolates. SQL inspection belongs to the host fixture only. */
const createUserPlatform = Effect.fnUntraced(function* (withBilling: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-user-store-" });
  const [ingress, core] = yield* Effect.all(
    [workerManifest("./public-worker.ts"), workerManifest("./core-worker.ts")],
    { concurrency: 2 }
  );
  const origin = { type: "text", value: browserOrigins.production } as const;
  const provider = yield* billingProvider(withBilling);
  const create = (ceiling: string): Miniflare =>
    new Miniflare({
      unsafeInspectDurableObjects: true,
      resourcePersistencePath: directory,
      workers: [
        {
          config: {
            type: "worker",
            name: "ingress",
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            manifest: ingress,
            env: {
              BROWSER_ORIGIN: origin,
              PAT_ADMISSION_KEY: { type: "text", value: "test-only-admission-key-with-32-bytes" },
              CORE: { type: "worker", worker: "core" },
            },
          },
        },
        {
          ...(withBilling ? providerOnlyOutbound : {}),
          config: {
            type: "worker",
            name: "core",
            ...(withBilling ? billingTrigger : {}),
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            manifest: core,
            exports: {
              UserStore: { type: "durable-object", storage: "sqlite" },
              Directory: { type: "durable-object", storage: "sqlite" },
            },
            env: {
              BROWSER_ORIGIN: origin,
              CF_VERSION_METADATA: { type: "version-metadata" },
              SQLITE_STORE_CAPACITY_BYTES: { type: "text", value: ceiling },
              ...(withBilling ? billingBindings : {}),
              USER_STORE: { type: "durable-object", worker: "core", exportName: "UserStore" },
              DIRECTORY: { type: "durable-object", worker: "core", exportName: "Directory" },
            },
          },
        },
        ...provider,
      ],
    });
  return (ceiling = "1000000000"): Effect.Effect<Miniflare, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => create(ceiling)),
      (runtime) => native(() => runtime.dispose())
    );
});

export const nativeUserPlatform = createUserPlatform(false);
export const nativeBillingPlatform = createUserPlatform(true);
