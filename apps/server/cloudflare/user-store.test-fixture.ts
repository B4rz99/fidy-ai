import { Effect, FileSystem, type Scope } from "effect";
import { Miniflare, type MiniflareWorkerConfig } from "miniflare";
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

const browserOutbound = {
  dev: {
    outboundService: {
      type: "worker" as const,
      worker: "browser-oidc-fixture",
      exportName: "BrowserOidcFixture",
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
  WOMPI_EVENT_SECRET: { type: "text" as const, value: "test_events_callback_fixture" },
  HOSTED_WHATSAPP_QUEUE: { type: "queue" as const, name: "billing-test" },
  WHATSAPP_BUSINESS_PORTFOLIO_ID: { type: "text" as const, value: "123456789012345" },
  KAPSO_WEBHOOK_SECRET: { type: "text" as const, value: "callback-fixture-secret" },
  KAPSO_API_KEY: { type: "text" as const, value: "fixture" },
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: { type: "text" as const, value: "987654321012345" },
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

const browserBindings = {
  FIXTURE_PROVIDER: {
    type: "worker",
    worker: "browser-oidc-fixture",
    exportName: "BrowserOidcFixture",
  },
  RESEND_API_KEY: { type: "text" as const, value: "fixture-resend-key" },
  CLOUDFLARE_ACCESS_ISSUER: {
    type: "text" as const,
    value: "https://fixture.cloudflareaccess.com",
  },
  CLOUDFLARE_ACCESS_AUDIENCE: { type: "text" as const, value: "fixture-support" },
  KAPSO_API_KEY: { type: "text", value: "test-kapso-key" },
  KAPSO_WEBHOOK_SECRET: { type: "text", value: "test-kapso-secret" },
  WHATSAPP_BUSINESS_PORTFOLIO_ID: { type: "text", value: "portfolio" },
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: { type: "text", value: "123456789012345" },
  GOOGLE_CLIENT_ID: { type: "text", value: "test-browser-client" },
  GOOGLE_CLIENT_SECRET: { type: "text", value: "local-provider-fixture" },
  GOOGLE_REDIRECT_URI: {
    type: "text",
    value: "https://api.fidyapp.com/providers/google/callback",
  },
  MICROSOFT_CLIENT_ID: { type: "text", value: "test-browser-client" },
  MICROSOFT_CLIENT_SECRET: { type: "text", value: "local-provider-fixture" },
  MICROSOFT_REDIRECT_URI: {
    type: "text",
    value: "https://api.fidyapp.com/providers/microsoft/callback",
  },
} as const;
const nativeOwnerBindings = {
  USER_STORE: { type: "durable-object", worker: "core", exportName: "UserStore" },
  PRICING: { type: "durable-object", worker: "core", exportName: "Pricing" },
  ERASURE: { type: "durable-object", worker: "core", exportName: "Erasure" },
  MAINTENANCE: { type: "durable-object", worker: "core", exportName: "Maintenance" },
  DIRECTORY: { type: "durable-object", worker: "core", exportName: "Directory" },
} as const;
const nativeOwners = {
  UserStore: { type: "durable-object", storage: "sqlite" },
  Pricing: { type: "durable-object", storage: "sqlite" },
  Erasure: { type: "durable-object", storage: "sqlite" },
  Maintenance: { type: "durable-object", storage: "sqlite" },
  Directory: { type: "durable-object", storage: "sqlite" },
} as const;

const oidcWorkers = Effect.fnUntraced(function* (enabled: boolean) {
  return enabled
    ? [
        {
          config: {
            type: "worker" as const,
            name: "browser-oidc-fixture",
            compatibilityDate: "2026-09-08",
            exports: { BrowserOidcFixture: { type: "worker" as const } },
            manifest: yield* workerManifest("./directory/oidc.test-fixture.ts"),
          },
        },
      ]
    : [];
});

const origin = { type: "text", value: browserOrigins.production } as const;
const ingressWorker = (
  ingress: Effect.Success<ReturnType<typeof workerManifest>>
): Readonly<{ config: MiniflareWorkerConfig }> => ({
  config: {
    type: "worker" as const,
    name: "ingress",
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    manifest: ingress,
    env: {
      BROWSER_ORIGIN: origin,
      PAT_ADMISSION_KEY: {
        type: "text" as const,
        value: "test-only-admission-key-with-32-bytes",
      },
      CORE: { type: "worker" as const, worker: "core" },
    },
  },
});
const manifests = Effect.all(
  [workerManifest("./public-worker.ts"), workerManifest("./core-worker.ts")],
  { concurrency: 2 }
);

/** Production ingress and Core in separate workerd isolates. SQL inspection belongs to the host fixture only. */
const createUserPlatform = Effect.fnUntraced(function* (
  withBilling: boolean,
  withOidc: boolean = false,
  ingressOrigin?: string
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-user-store-" });
  const [ingress, core] = yield* manifests;

  const provider = yield* billingProvider(withBilling);
  const oidc = yield* oidcWorkers(withOidc);
  const create = (ceiling: string, logs: Array<string>): Miniflare =>
    new Miniflare({
      ...(ingressOrigin === undefined ? {} : { upstream: ingressOrigin }),
      ...(withOidc
        ? {
            handleStructuredLogs: (log: { message: string }) => {
              logs.push(log.message);
            },
          }
        : {}),
      unsafeInspectDurableObjects: true,
      resourcePersistencePath: directory,
      workers: [
        ingressWorker(ingress),
        {
          ...(withBilling ? providerOnlyOutbound : {}),
          ...(withOidc ? browserOutbound : {}),
          config: {
            type: "worker",
            name: "core",
            ...(withBilling ? billingTrigger : {}),
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            manifest: core,
            exports: nativeOwners,
            env: {
              BROWSER_ORIGIN: origin,
              ...(withOidc ? browserBindings : {}),
              CF_VERSION_METADATA: { type: "version-metadata" },
              SQLITE_STORE_CAPACITY_BYTES: { type: "text", value: ceiling },
              ...(withBilling ? billingBindings : {}),
              ...nativeOwnerBindings,
            },
          },
        },
        ...provider,
        ...oidc,
      ],
    });
  return (
    ceiling = "1000000000",
    logs: Array<string> = []
  ): Effect.Effect<Miniflare, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => create(ceiling, logs)),
      (runtime) => native(() => runtime.dispose())
    );
});

export const nativeBrowserPlatform = createUserPlatform(false, true);
export const nativeUserPlatform = createUserPlatform(false);
export const nativeBillingPlatform = createUserPlatform(true);

/** Preserve the public hostname across Miniflare's loopback HTTP bridge for MCP Host validation. */
export const nativeOAuthPlatform = createUserPlatform(false, false, "https://api.fidyapp.com");
