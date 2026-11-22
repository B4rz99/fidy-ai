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
            exports: {
              CancellationProviderFixture: { type: "worker" as const },
              ProviderState: { type: "durable-object" as const, storage: "sqlite" as const },
            },
            env: {
              PROVIDER_STATE: {
                type: "durable-object" as const,
                worker: "wompi-fixture",
                exportName: "ProviderState",
              },
            },
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
  BILLING_COLLECTION_QUEUE: { type: "queue" as const, name: "billing-test" },
  BILLING_REFUND_WORKFLOW: {
    type: "workflow" as const,
    name: "billing-test-refunds",
    worker: "core",
    exportName: "BillingRefundWorkflowV1",
  },
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
  BETA_PRO_OPERATOR_EMAIL: { type: "text", value: "beta@example.test" },
  BETA_PRO_AUDIENCE: { type: "text", value: "fixture-beta" },
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

export const nativeOwnerBindings = {
  USER_STORE: { type: "durable-object", worker: "core", exportName: "UserStore" },
  PRICING: { type: "durable-object", worker: "core", exportName: "Pricing" },
  ERASURE: { type: "durable-object", worker: "core", exportName: "Erasure" },
  MAINTENANCE: { type: "durable-object", worker: "core", exportName: "Maintenance" },
  DIRECTORY: { type: "durable-object", worker: "core", exportName: "Directory" },
} as const;

export const nativeOwners = {
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

const apiFlags = ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"];

type WorkerDefinition = Readonly<{ config: MiniflareWorkerConfig }>;

const ingressWorker = ({
  ingress,
  deployment,
}: {
  ingress: Effect.Success<ReturnType<typeof workerManifest>>;
  deployment: Readonly<Record<string, string>>;
}): WorkerDefinition => ({
  config: {
    type: "worker" as const,
    name: "ingress",
    compatibilityDate: "2026-09-08",
    compatibilityFlags: apiFlags,
    manifest: ingress,
    env: {
      BROWSER_ORIGIN: { type: "text", value: deployment.BROWSER_ORIGIN ?? origin.value },
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
  | "addressed-read"
  | "custody"
  | "erasure"
  | "capacity"
  | "connection"
  | "health"
  | "fleet"
  | "hosted"
  | "user"
  | "billing"
  | "browser"
  | "login"
  | "oauth";

const minuteMs = 60000;

const attemptLifetimeMs = 600000;

type ConnectionProfile = {
  bindings: NonNullable<MiniflareWorkerConfig["env"]>;
  owners: NonNullable<MiniflareWorkerConfig["exports"]>;
  configuration: Pick<MiniflareWorkerConfig, "triggers">;
};

const empty: ConnectionProfile = { bindings: {}, owners: {}, configuration: {} };

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

const fixtureModules: Partial<Record<NativeFixture, string>> = {
  "lost-read": "./core-http/lost-read.test-fixture.ts",
  hosted: "./agent/hosted-alarm.test-fixture.ts",
  health: "./maintenance/native-monitor.test-fixture.ts",
  fleet: "./maintenance/native-fleet.test-fixture.ts",
  "addressed-read": "./transactions/addressed-read.test-fixture.ts",
  clock: "./user-clock.test-fixture.ts",
  capacity: "./capacity-worker.test-fixture.ts",
  erasure: "./erasure-worker.test-fixture.ts",
  custody: "./erasure-worker.test-fixture.ts",
  login: "./login-email-worker.test-fixture.ts",
  connection: "./connection-worker.test-fixture.ts",
};

const billingFeature = {
  outbound: providerOnlyOutbound,
  trigger: billingTrigger,
  bindings: billingBindings,
};

const oidcFeature = {
  outbound: browserOutbound,
  trigger: loginEmailTrigger,
  bindings: browserBindings,
};

const disabledFeature = { outbound: {}, trigger: {}, bindings: {} };

type FixtureWorkers = Readonly<{
  billing: typeof billingFeature | typeof disabledFeature;
  oidc: typeof oidcFeature | typeof disabledFeature;
  withBilling: boolean;
  withOidc: boolean;
  coreModule: string;
  ingressOptions: Pick<ConstructorParameters<typeof Miniflare>[0], "upstream">;
}>;

const fixtureWorkers = (mode: NativeFixture): FixtureWorkers => {
  const withBilling = ["billing", "erasure", "custody"].includes(mode);
  const withOidc = ["browser", "login", "custody"].includes(mode);

  return {
    withBilling,
    withOidc,
    billing: withBilling ? billingFeature : disabledFeature,
    oidc: withOidc ? oidcFeature : disabledFeature,
    coreModule: fixtureModules[mode] ?? "./core-worker.ts",
    ingressOptions: ["oauth", "connection"].includes(mode)
      ? { upstream: "https://api.fidyapp.com" }
      : {},
  };
};

const hostedFixture = Effect.fnUntraced(function* (mode: NativeFixture) {
  return ["hosted", "health"].includes(mode)
    ? [
        {
          config: {
            type: "worker" as const,
            name: "hosted-provider",
            compatibilityFlags: ["enable_request_signal", "request_signal_passthrough"],
            compatibilityDate: "2026-09-08",
            exports: {
              HostedProviderFixture: { type: "worker" as const },
              HostedProviderControl: {
                type: "durable-object" as const,
                storage: "sqlite" as const,
              },
            },
            env: {
              INGRESS: { type: "worker" as const, worker: "ingress" },
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
    WEEKLY_SUMMARY_TEMPLATE_JSON: {
      type: "text" as const,
      value:
        '{"name":"fidy_weekly_summary","language":"es","approval":"approved","body":"Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy."}',
    },
    WEEKLY_QUESTION_TEMPLATE_JSON: {
      type: "text" as const,
      value:
        '{"name":"fidy_weekly_question","language":"es","approval":"approved","body":"Fidy te avisa: {{1}} Más en Fidy."}',
    },
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
  ["hosted", "health"].includes(mode)
    ? {
        outbound: { dev: hostedOpenAi.dev },
        env: hostedOpenAi.env,
        triggers: { triggers: hostedOpenAi.triggers },
      }
    : { outbound: {}, env: {}, triggers: {} };

const textBindings = (
  deployment: Readonly<Record<string, string>>
): Record<string, { type: "text"; value: string }> =>
  Object.fromEntries(
    Object.entries(deployment).map(([key, value]) => [key, { type: "text" as const, value }])
  );

type LogCapture = { handleStructuredLogs: (log: { message: string }) => void };

const captureLogs = (enabled: boolean, logs: Array<string>): Partial<LogCapture> =>
  enabled ? capturedLogs(logs) : {};

const capturedLogs = (logs: Array<string>): LogCapture => ({
  handleStructuredLogs: (log) => {
    logs.push(log.message);
  },
});

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
    capture: fixtureWorkers(mode).withOidc || mode === "health",
    providers: [
      {
        config: {
          type: "worker" as const,
          name: "financial-client",
          compatibilityDate: "2026-09-08",
          manifest: yield* workerManifest("./financial-client.test-fixture.ts"),
          env: { INGRESS: { type: "worker" as const, worker: "ingress" } },
        },
      },
      ...(yield* fixtureProviders(mode)),
    ],
    hostedPlatform: hostedOptions(mode),
    connection: yield* connectionPlatformOptions(mode === "connection"),
  };
});

const createUserPlatform = Effect.fnUntraced(function* (mode: NativeFixture) {
  const { billing, oidc, coreModule, ingressOptions } = fixtureWorkers(mode);
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-user-store-" });
  const [ingress, core] = yield* manifests(coreModule);

  const { providers, hostedPlatform, connection, capture } = yield* fixtureFeatures(mode);

  const create = (
    ceiling: string,
    logs: Array<string>,
    deployment: Readonly<Record<string, string>>
  ): Miniflare =>
    new Miniflare({
      ...ingressOptions,
      ...captureLogs(capture, logs),
      unsafeInspectDurableObjects: true,
      resourcePersistencePath: directory,
      workers: [
        ingressWorker({ ingress, deployment }),
        {
          ...hostedPlatform.outbound,
          ...billing.outbound,
          ...oidc.outbound,
          config: {
            type: "worker",
            name: "core",
            ...hostedPlatform.triggers,
            ...connection.configuration,
            ...billing.trigger,
            ...oidc.trigger,
            compatibilityDate: "2026-09-08",
            compatibilityFlags: apiFlags,
            manifest: core,
            exports: { ...nativeOwners, ...connection.owners },
            env: {
              ...hostedPlatform.env,
              BROWSER_ORIGIN: origin,
              ...connection.bindings,
              ...oidc.bindings,
              CF_VERSION_METADATA: { type: "version-metadata" },
              SQLITE_STORE_CAPACITY_BYTES: { type: "text", value: ceiling },
              ...billing.bindings,
              ...textBindings(deployment),
              ...nativeOwnerBindings,
            },
          },
        },
        ...providers,
      ],
    });

  return (
    ceiling = "1000000000",
    logs: Array<string> = [],
    deployment: Readonly<Record<string, string>> = {}
  ): Effect.Effect<Miniflare, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => create(ceiling, logs, deployment)),
      (runtime) => native(() => runtime.dispose())
    );
});

export const nativeCustodyPlatform = createUserPlatform("custody");

export const nativePurgePlatform = createUserPlatform("erasure");

export const nativeLoginPlatform = createUserPlatform("login");

export const nativeBrowserPlatform = createUserPlatform("browser");

export const nativeConnectionPlatform = createUserPlatform("connection");

export const nativeCapacityPlatform = createUserPlatform("capacity");

export const nativeLostReadPlatform = createUserPlatform("lost-read");

export const nativeTransactionReadPlatform = createUserPlatform("addressed-read");

export const nativeClockPlatform = createUserPlatform("clock");

export const nativeUserPlatform = createUserPlatform("user");

export const nativeBillingPlatform = createUserPlatform("billing");

export const nativeOAuthPlatform = createUserPlatform("oauth");

export const nativeFleetPlatform = createUserPlatform("fleet");

export const nativeHealthPlatform = createUserPlatform("health");

export const nativeHostedPlatform = createUserPlatform("hosted");
