import { Clock, DateTime, Effect, FileSystem, Schema, type Scope } from "effect";
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
    ...["statement-test-queue", "forwarded-email-test-queue"].map((name) => ({
      type: "queue" as const,
      name,
      maxBatchSize: 10,
      maxBatchTimeout: 0,
      maxRetries: 3,
      retryDelay: 0,
      deadLetterQueue: "ingestion-dead-letters",
    })),
  ],
};

const billingBindings = {
  SAMPLE_BUCKET: { type: "r2" as const, name: "anonymous-samples" },
  PRIVATE_EMAIL: {
    type: "worker" as const,
    worker: "private-email-fixture",
    exportName: "PrivateEmailFixture",
  },
  STATEMENT_STAGING_BUCKET: { type: "r2" as const, name: "statements" },
  EMAIL_BUCKET: { type: "r2" as const, name: "forwarded-email" },
  STATEMENT_EXTRACTION_QUEUE: { type: "queue" as const, name: "statement-test-queue" },
  FORWARDED_EMAIL_QUEUE: { type: "queue" as const, name: "forwarded-email-test-queue" },
  STATEMENT_EXTRACTION_WORKFLOW: {
    type: "workflow" as const,
    name: "statement-test",
    worker: "core",
    exportName: "StatementExtractionWorkflowV1",
  },
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
  WOMPI_PUBLIC_KEY: { type: "text" as const, value: "pub_test_nativefixture" },
  WOMPI_PRIVATE_KEY: { type: "text" as const, value: "prv_test_nativefixture" },
  WOMPI_INTEGRITY_SECRET: {
    type: "text" as const,
    value: "test_integrity_nativefixture",
  },
};

const loginEmailTrigger = {
  triggers: [
    {
      type: "queue" as const,
      name: "login-email",
      maxBatchSize: 4,
      maxBatchTimeout: 0,
      maxRetries: 2,
      retryDelay: 0,
    },
  ],
};
const browserBindings = {
  BROWSER_PAIRING_EMAIL_QUEUE: { type: "queue", name: "login-email" },
  BROWSER_PAIRING_EMAIL_WORKFLOW: {
    type: "workflow",
    name: "login-email-flow",
    worker: "core",
    exportName: "BrowserPairingEmailWorkflowV1",
  },
  SAMPLE_BUCKET: { type: "r2", name: "anonymous-samples" },
  EMAIL_BUCKET: { type: "r2", name: "sample-controls-test" },
  STORAGE_OPERATOR_EMAIL: { type: "text", value: "storage@example.test" },
  STORAGE_OPERATOR_AUDIENCE: { type: "text", value: "fixture-storage" },
  STORAGE_REPAIR_ENABLED: { type: "text", value: "enabled" },
  SAMPLE_REVIEWER_EMAIL: { type: "text", value: "reviewer@example.test" },
  SAMPLE_REVIEW_AUDIENCE: { type: "text", value: "fixture-review" },
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
const manifests = Effect.fnUntraced(function* (module: string) {
  return yield* Effect.all([workerManifest("./public-worker.ts"), workerManifest(module)], {
    concurrency: 2,
  });
});

type NativeFixture =
  | "lost-read"
  | "clock"
  | "custody"
  | "erasure"
  | "capacity"
  | "connection"
  | "hosted"
  | "user"
  | "billing"
  | "browser"
  | "login"
  | "oauth";
const minuteMs = 60000;
const attemptLifetimeMs = 600000;
const empty: {
  bindings: NonNullable<MiniflareWorkerConfig["env"]>;
  owners: NonNullable<MiniflareWorkerConfig["exports"]>;
  configuration: Pick<MiniflareWorkerConfig, "triggers">;
} = { bindings: {}, owners: {}, configuration: {} };
export const nativeConnectionProfile = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
    contract: "bancolombia-sandbox-consent-2026-10-27",
    userId: "10000000-0000-4000-8000-000000000051",
    admission: {
      startsAt: DateTime.formatIso(DateTime.makeUnsafe(now - minuteMs)),
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + attemptLifetimeMs)),
    },
    financialId: "",
    accountOwner: { SchemeName: "CC", Identification: "fixture" },
    intent: {
      permissions: ["ReadAccountsBasic", "ReadTransactionsDetail"],
      historyPolicy: "bank-default",
      expiryPolicy: "bank-default",
    },
  }).pipe(Effect.orDie);
});
const connectionPlatformOptions = Effect.fnUntraced(function* (enabled: boolean) {
  if (!enabled) return empty;
  return {
    bindings: {
      CONNECTION_FIXTURE: {
        type: "durable-object" as const,
        worker: "core",
        exportName: "ConnectionProviderFixture",
      },
      CONNECTION_SYNCHRONIZATION_QUEUE_NAME: {
        type: "text" as const,
        value: "connection-sync",
      },
      CONNECTION_SYNCHRONIZATION_QUEUE: {
        type: "queue" as const,
        name: "connection-sync",
      },
      CONNECTION_SYNCHRONIZATION_WORKFLOW: {
        type: "workflow" as const,
        name: "connection-sync",
        worker: "core",
        exportName: "ConnectionSynchronizationWorkflow",
      },
      BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: {
        type: "text" as const,
        value: yield* nativeConnectionProfile,
      },
    },
    owners: {
      ConnectionProviderFixture: { type: "durable-object" as const, storage: "sqlite" as const },
    },
    configuration: {
      triggers: [
        {
          type: "queue" as const,
          name: "connection-sync",
          maxBatchSize: 4,
          maxBatchTimeout: 0,
          maxRetries: 2,
          retryDelay: 0,
        },
      ],
    },
  };
});

const fixtureModule = (mode: NativeFixture): string => {
  if (mode === "lost-read") return "./core-http/lost-read.test-fixture.ts";
  if (mode === "clock") return "./user-clock.test-fixture.ts";
  if (mode === "capacity") return "./capacity-worker.test-fixture.ts";
  if (mode === "erasure" || mode === "custody") return "./erasure-worker.test-fixture.ts";
  if (mode === "login") return "./login-email-worker.test-fixture.ts";
  if (mode === "connection") return "./connection-worker.test-fixture.ts";
  return "./core-worker.ts";
};
const fixtureWorkers = (
  mode: NativeFixture
): Readonly<{
  withBilling: boolean;
  withOidc: boolean;
  coreModule: string;
  ingressOptions: Pick<ConstructorParameters<typeof Miniflare>[0], "upstream">;
}> => ({
  withBilling: ["billing", "erasure", "custody"].includes(mode),
  withOidc: ["browser", "login", "custody"].includes(mode),
  coreModule: fixtureModule(mode),
  ingressOptions: ["oauth", "connection"].includes(mode)
    ? { upstream: "https://api.fidyapp.com" }
    : {},
});

const hostedFixture = Effect.fnUntraced(function* (mode: NativeFixture) {
  return mode === "hosted"
    ? [
        {
          config: {
            type: "worker" as const,
            name: "hosted-provider",
            compatibilityDate: "2026-09-08",
            exports: {
              HostedProviderFixture: { type: "worker" as const },
              HostedProviderControl: {
                type: "durable-object" as const,
                storage: "sqlite" as const,
              },
            },
            env: {
              CONTROL: {
                type: "durable-object" as const,
                worker: "hosted-provider",
                exportName: "HostedProviderControl",
              },
            },
            manifest: yield* workerManifest("./agent/provider.test-fixture.ts"),
          },
        },
      ]
    : [];
});
const hostedOpenAi = {
  dev: {
    outboundService: {
      type: "worker" as const,
      worker: "hosted-provider",
      exportName: "HostedProviderFixture",
    },
  },
  env: {
    HOSTED_WHATSAPP_QUEUE: { type: "queue" as const, name: "reminder-test" },
    WHATSAPP_BUSINESS_PORTFOLIO_ID: billingBindings.WHATSAPP_BUSINESS_PORTFOLIO_ID,
    WHATSAPP_SANDBOX_PHONE_NUMBER_ID: billingBindings.WHATSAPP_SANDBOX_PHONE_NUMBER_ID,
    KAPSO_WEBHOOK_SECRET: billingBindings.KAPSO_WEBHOOK_SECRET,
    OPENAI_API_KEY: { type: "text" as const, value: "fixture-openai" },
    HOSTED_AI_MODEL: { type: "text" as const, value: "gpt-6-luna" },
    PROACTIVITY_ENABLED: { type: "text" as const, value: "enabled" },
    KAPSO_API_KEY: { type: "text" as const, value: "test-kapso-key" },
    PROACTIVITY_TEMPLATE_JSON: {
      type: "text" as const,
      value:
        '{"name":"fidy_reminder","language":"es","approval":"approved","body":"Fidy te avisa: {{1}} Más en Fidy."}',
    },
    WEEKLY_DELIVERY_QUEUE: { type: "queue" as const, name: "reminder-test" },
    WEEKLY_DELIVERY_WORKFLOW: {
      type: "workflow" as const,
      name: "reminder-flow",
      worker: "core",
      exportName: "ProactivityDeliveryWorkflow",
    },
  },
  triggers: [
    {
      type: "queue" as const,
      name: "reminder-test",
      maxBatchSize: 4,
      maxBatchTimeout: 0,
      maxRetries: 2,
      retryDelay: 0,
    },
  ],
};
const fixtureProviders = Effect.fnUntraced(function* (mode: NativeFixture) {
  const { withBilling, withOidc } = fixtureWorkers(mode);
  return (yield* Effect.all([
    billingProvider(withBilling),
    privateEmailWorker(withBilling),
    oidcWorkers(withOidc),
    hostedFixture(mode),
  ])).flat();
});
const hostedOptions = (
  mode: NativeFixture
): {
  outbound: Pick<MiniflareWorkerConfig, "type"> | {};
  env: MiniflareWorkerConfig["env"];
  triggers: Pick<MiniflareWorkerConfig, "triggers"> | {};
} =>
  mode === "hosted"
    ? {
        outbound: { dev: hostedOpenAi.dev },
        env: hostedOpenAi.env,
        triggers: { triggers: hostedOpenAi.triggers },
      }
    : { outbound: {}, env: {}, triggers: {} };
const textBindings = (
  deployment: Readonly<Record<string, string>>
): Record<string, { type: "text"; value: string } | { type: "json"; value: { id: string } }> =>
  Object.fromEntries(
    Object.entries(deployment).map(([key, value]) => [
      key,
      key === "CF_VERSION_METADATA"
        ? { type: "json", value: { id: value } }
        : { type: "text", value },
    ])
  );
const captureLogs = (
  logs: Array<string>
): { handleStructuredLogs: (log: { message: string }) => void } => ({
  handleStructuredLogs: (log) => {
    logs.push(log.message);
  },
});
/** Production ingress and Core in separate workerd isolates. SQL inspection belongs to the host fixture only. */
const privateEmailWorker = Effect.fnUntraced(function* (withBilling: boolean) {
  const emailFixture = withBilling
    ? [
        {
          config: {
            type: "worker" as const,
            name: "private-email-fixture",
            exports: { PrivateEmailFixture: { type: "worker" as const } },
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            env: {
              ...nativeOwnerBindings,
              QUEUE_DIAGNOSTICS: { type: "r2" as const, name: "ingestion-dead-letters" },
            },
            triggers: [
              {
                type: "queue" as const,
                name: "ingestion-dead-letters",
                maxBatchSize: 1,
                maxBatchTimeout: 0,
              },
            ],
            manifest: yield* workerManifest("./ingestion/private-email.test-fixture.ts"),
          },
        },
      ]
    : [];
  return emailFixture;
});
const fixtureFeatures = Effect.fnUntraced(function* (mode: NativeFixture) {
  return {
    providers: yield* fixtureProviders(mode),
    hostedPlatform: hostedOptions(mode),
    connection: yield* connectionPlatformOptions(mode === "connection"),
  };
});
const scopedPlatform =
  (
    create: (
      ceiling: string,
      logs: string[],
      deployment: Readonly<Record<string, string>>
    ) => Miniflare
  ): ((
    ceiling?: string,
    logs?: string[],
    deployment?: Readonly<Record<string, string>>
  ) => Effect.Effect<Miniflare, never, Scope.Scope>) =>
  (
    ceiling = "1000000000",
    logs: Array<string> = [],
    deployment: Readonly<Record<string, string>> = {}
  ): Effect.Effect<Miniflare, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => create(ceiling, logs, deployment)),
      (runtime) => native(() => runtime.dispose())
    );
const createUserPlatform = Effect.fnUntraced(function* (mode: NativeFixture) {
  const { withBilling, withOidc, coreModule, ingressOptions } = fixtureWorkers(mode);
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-user-store-" });
  const [ingress, core] = yield* manifests(coreModule);

  const { providers, hostedPlatform, connection } = yield* fixtureFeatures(mode);
  const create = (
    ceiling: string,
    logs: Array<string>,
    deployment: Readonly<Record<string, string>>
  ): Miniflare =>
    new Miniflare({
      ...ingressOptions,
      ...(withOidc ? captureLogs(logs) : {}),
      unsafeInspectDurableObjects: true,
      resourcePersistencePath: directory,
      workers: [
        ingressWorker(ingress),
        {
          ...hostedPlatform.outbound,
          ...(withBilling ? providerOnlyOutbound : {}),
          ...(withOidc ? browserOutbound : {}),
          config: {
            type: "worker",
            name: "core",
            ...hostedPlatform.triggers,
            ...connection.configuration,
            ...(withBilling ? billingTrigger : {}),
            ...(withOidc ? loginEmailTrigger : {}),
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            manifest: core,
            exports: { ...nativeOwners, ...connection.owners },
            env: {
              ...hostedPlatform.env,
              BROWSER_ORIGIN: origin,
              ...connection.bindings,
              ...(withOidc ? browserBindings : {}),
              CF_VERSION_METADATA: { type: "version-metadata" },
              SQLITE_STORE_CAPACITY_BYTES: { type: "text", value: ceiling },
              ...(withBilling ? billingBindings : {}),
              ...textBindings(deployment),

              ...nativeOwnerBindings,
            },
          },
        },
        ...providers,
      ],
    });
  return scopedPlatform(create);
});

export const nativeCustodyPlatform = createUserPlatform("custody");
export const nativePurgePlatform = createUserPlatform("erasure");
export const nativeLoginPlatform = createUserPlatform("login");
export const nativeBrowserPlatform = createUserPlatform("browser");
export const nativeConnectionPlatform = createUserPlatform("connection");
export const nativeCapacityPlatform = createUserPlatform("capacity");
export const nativeLostReadPlatform = createUserPlatform("lost-read");
export const nativeClockPlatform = createUserPlatform("clock");
export const nativeUserPlatform = createUserPlatform("user");
export const nativeBillingPlatform = createUserPlatform("billing");

/** Preserve the public hostname across Miniflare's loopback HTTP bridge for MCP Host validation. */
export const nativeOAuthPlatform = createUserPlatform("oauth");

export const nativeHostedPlatform = createUserPlatform("hosted");
