import type { ErasureRegistryInitialization } from "../../apps/server/cloudflare/erasure/contract";
import { prepareLocalErasureRegistry } from "../../apps/server/cloudflare/erasure/operations";
import { ErasureUnavailable } from "../../apps/server/cloudflare/erasure-store/contract";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import { Hex } from "effect/encoding";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { WhatsAppBusinessPhoneNumberId } from "@fidy/server/whatsapp-contract";
import { ApprovedWorkersAiModel } from "@fidy/server/hosted-inference-contract";
import { EmailAddress } from "@fidy/server/email-authentication-contract";
import { resolveDeploymentConfiguration, resolveStateBackend } from "./deployment-configuration";
import { edgeSecurityPolicy } from "./edge-security";
import { freeTierWorkerObservability } from "./worker-observability";
import { browserOrigins, productionTopology } from "../../apps/server/cloudflare/runtime/contract";
import { resolveLocalCanonicalReadBearer } from "../../apps/server/cloudflare/runtime/operations";

const localRegistryStorage = (
  input: Readonly<{
    db: Cloudflare.D1.QueryDatabaseClient;
    read: Cloudflare.R2.ReadBucketClient;
    write: Cloudflare.R2.WriteBucketClient;
  }>
): ErasureRegistryInitialization<Alchemy.RuntimeContext> => ({
  query: (statement) => input.db.prepare(statement).first(),
  exists: (key) =>
    input.read.head(key).pipe(
      Effect.map((object) => object !== null),
      Effect.mapError(() => new ErasureUnavailable())
    ),
  empty: input.read.list({ limit: 1 }).pipe(
    Effect.map((page) => page.objects.length === 0),
    Effect.mapError(() => new ErasureUnavailable())
  ),
  install: (key, value) =>
    input.write.put(key, value, { onlyIf: { etagDoesNotMatch: "*" } }).pipe(
      Effect.map((object) => object !== null),
      Effect.mapError(() => new ErasureUnavailable())
    ),
});

const initializeLocalErasureRegistry = Effect.fn(function* (
  input: Readonly<{ database: Cloudflare.D1.Database; bucket: Cloudflare.R2.Bucket }>
) {
  const Initialize = Alchemy.Action(
    "InitializeLocalErasureRegistry",
    Effect.gen(function* () {
      const db = yield* Cloudflare.D1.QueryDatabase(input.database);
      const read = yield* Cloudflare.R2.ReadBucket(input.bucket);
      const write = yield* Cloudflare.R2.WriteBucket(input.bucket);
      return Effect.fn(function* () {
        yield* prepareLocalErasureRegistry({
          ...localRegistryStorage({ db, read, write }),
        });
        return { required: "true" };
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Cloudflare.D1.QueryDatabaseLocal,
          Cloudflare.R2.ReadBucketLocal,
          Cloudflare.R2.WriteBucketLocal
        )
      )
    )
  );
  const initialized = yield* Initialize({});
  return initialized.required;
});

const releaseGitRevision = Config.String("RELEASE_GIT_SHA").pipe(Config.withDefault(""));
const contractDigest = Config.String("CONTRACT_DIGEST").pipe(Config.withDefault(""));
const hostedAiModel = Config.schema(ApprovedWorkersAiModel, "HOSTED_AI_MODEL");
const kapsoWebhookSecret = Config.Redacted("KAPSO_WEBHOOK_SECRET");
const kapsoApiKey = Config.Redacted("KAPSO_API_KEY");
const microsoftClientId = Config.String("MICROSOFT_CLIENT_ID");
const microsoftClientSecret = Config.Redacted("MICROSOFT_CLIENT_SECRET");
const googleClientId = Config.String("GOOGLE_CLIENT_ID");
const googleClientSecret = Config.Redacted("GOOGLE_CLIENT_SECRET");
const resendApiKey = Config.Redacted("RESEND_API_KEY");
const wompiEnvironment = Config.String("WOMPI_ENVIRONMENT");
const wompiPublicKey = Config.String("WOMPI_PUBLIC_KEY");
const wompiPrivateKey = Config.Redacted("WOMPI_PRIVATE_KEY");
const wompiIntegritySecret = Config.Redacted("WOMPI_INTEGRITY_SECRET");
const wompiEventSecret = Config.Redacted("WOMPI_EVENT_SECRET");
const daviplataActivated = Config.String("WOMPI_DAVIPLATA_ACTIVATED").pipe(
  Config.withDefault("disabled")
);
const daviplataOtpSendUrl = Config.String("WOMPI_DAVIPLATA_OTP_SEND_URL").pipe(
  Config.withDefault("")
);
const daviplataOtpConfirmUrl = Config.String("WOMPI_DAVIPLATA_OTP_CONFIRM_URL").pipe(
  Config.withDefault("")
);
const patAdmissionKey = Config.Redacted("PAT_ADMISSION_KEY");
const smokeProof = Config.Redacted("SMOKE_PROOF");
const recoveryIsolation = Config.Literals(["", "isolated"], "RECOVERY_ISOLATION").pipe(
  Config.withDefault("")
);
const accessIssuer = Config.String("CLOUDFLARE_ACCESS_ISSUER");
const recoveryOperatorEmail = Config.schema(EmailAddress, "RECOVERY_OPERATOR_EMAIL");
const whatsAppBusinessPortfolioId = Config.String("WHATSAPP_BUSINESS_PORTFOLIO_ID");
const whatsAppSandboxPhoneNumberId = Config.schema(
  Schema.Union([Schema.Literal(""), WhatsAppBusinessPhoneNumberId]),
  "WHATSAPP_SANDBOX_PHONE_NUMBER_ID"
).pipe(Config.withDefault(""));

const resolveKapsoBindings = (
  development: boolean
): Effect.Effect<
  Readonly<{
    apiKey: Redacted.Redacted<string>;
    webhookSecret: Redacted.Redacted<string>;
    portfolioId: string;
    sandboxPhoneNumberId: string;
  }>,
  Config.ConfigError
> =>
  Effect.gen(function* () {
    const apiKey = yield* development
      ? kapsoApiKey.pipe(Config.withDefault(Redacted.make("")))
      : kapsoApiKey;
    const webhookSecret = yield* development
      ? kapsoWebhookSecret.pipe(Config.withDefault(Redacted.make("")))
      : kapsoWebhookSecret;
    const portfolioId = yield* development
      ? whatsAppBusinessPortfolioId.pipe(Config.withDefault(""))
      : whatsAppBusinessPortfolioId;
    const sandboxPhoneNumberId = yield* whatsAppSandboxPhoneNumberId;
    return { apiKey, webhookSecret, portfolioId, sandboxPhoneNumberId };
  });

const resolveResendKey = (development: boolean): typeof resendApiKey =>
  development ? resendApiKey.pipe(Config.withDefault(Redacted.make(""))) : resendApiKey;
const admissionKeyBytes = 32;
const resolvePatAdmissionKey = (development: boolean): typeof patAdmissionKey =>
  development
    ? patAdmissionKey.pipe(
        Config.withDefault(
          Redacted.make(Hex.encode(crypto.getRandomValues(new Uint8Array(admissionKeyBytes))))
        )
      )
    : patAdmissionKey;

const resolveAccessConfig = Effect.fn(function* (development: boolean) {
  if (development) return { issuer: "", audience: "", erasureAudience: "" };
  const issuer = yield* accessIssuer;
  const operatorEmail = yield* recoveryOperatorEmail;
  const identity = yield* Cloudflare.Access.IdentityProvider("RecoveryIdentity", {
    name: "Fidy recovery email PIN",
    type: "onetimepin",
  });
  const operators = yield* Cloudflare.Access.Group("RecoveryOperators", {
    name: "recovery-operator",
    include: [{ email: { email: operatorEmail } }],
  });
  const application = yield* Cloudflare.Access.Application("SupportRecoveryAccess", {
    type: "self_hosted",
    name: "Fidy support recovery",
    domain: "api.fidyapp.com/internal/support-recovery",
    sessionDuration: "15m",
    appLauncherVisible: false,
    allowedIdps: [identity.identityProviderId],
    autoRedirectToIdentity: true,
    policies: [
      {
        name: "recovery-operator",
        decision: "allow",
        precedence: 1,
        sessionDuration: "15m",
        include: [{ group: operators.groupId }],
      },
    ],
  });
  const erasureApplication = yield* Cloudflare.Access.Application("TitularErasureAccess", {
    type: "self_hosted",
    name: "Fidy Titular erasure",
    domain: "api.fidyapp.com/internal/titular-erasure",
    sessionDuration: "15m",
    appLauncherVisible: false,
    allowedIdps: [identity.identityProviderId],
    autoRedirectToIdentity: true,
    policies: [
      {
        name: "titular-erasure-operator",
        decision: "allow",
        precedence: 1,
        sessionDuration: "15m",
        include: [{ email: { email: "obarboza@fidyapp.com" } }],
      },
    ],
  });
  return { issuer, audience: application.aud, erasureAudience: erasureApplication.aud };
});

const resolveBrowserOrigin = (production: boolean): string =>
  production ? edgeSecurityPolicy.browserOrigin : browserOrigins.local;

const deploymentConfigError = (error: { readonly reason: string }): Config.ConfigError =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      cause: error,
      message: `Invalid Cloudflare deployment configuration: ${error.reason}`,
    })
  );

const provisionEdgeSecurity = Effect.gen(function* () {
  const zone = yield* Cloudflare.Zone.Zone("ProductionZone", {
    name: "fidyapp.com",
  }).pipe(Alchemy.AdoptPolicy.adopt(true));
  yield* Cloudflare.Zone.Setting("StrictTransportSecurity", {
    zoneId: zone.zoneId,
    settingId: "security_header",
    value: edgeSecurityPolicy.hsts,
  });
  const { customFirewall, httpDdos, managedFirewall, rateLimits } = edgeSecurityPolicy.rulesets;

  yield* Cloudflare.Ruleset.Ruleset(customFirewall.logicalId, {
    description: "Fidy host and public-ingress method allowlist",
    phase: customFirewall.phase,
    rules: [...customFirewall.rules],
    zone,
  });
  yield* Cloudflare.Ruleset.Ruleset(managedFirewall.logicalId, {
    description: "Fidy managed application WAF baseline",
    phase: managedFirewall.phase,
    rules: [...managedFirewall.rules],
    zone,
  });
  yield* Cloudflare.Ruleset.Ruleset(httpDdos.logicalId, {
    description: "Fidy always-on non-interactive HTTP DDoS baseline",
    phase: httpDdos.phase,
    rules: [...httpDdos.rules],
    zone,
  });
  yield* Cloudflare.Ruleset.Ruleset(rateLimits.logicalId, {
    description: "Fidy operation-aware public edge limits",
    phase: rateLimits.phase,
    rules: [...rateLimits.rules],
    zone,
  });
});

const state = Layer.unwrap(
  Effect.gen(function* () {
    const development = yield* Alchemy.ALCHEMY_DEV;
    const stage = yield* Alchemy.Stage;
    const backend = resolveStateBackend({ development, stage });

    if (backend === "cloudflare") return Cloudflare.state();
    if (backend === "local") return Alchemy.localState();
    return Alchemy.inMemoryState();
  }).pipe(Effect.orDie)
);

export default Alchemy.Stack(
  "FidyCloudflare",
  {
    providers: Cloudflare.providers(),
    state,
  },
  Effect.gen(function* () {
    const development = yield* Alchemy.ALCHEMY_DEV;
    const stage = yield* Alchemy.Stack.useSync((stack) => stack.stage);
    const releaseMetadata = yield* Effect.fromResult(
      resolveDeploymentConfiguration({
        contractDigest: development ? "" : yield* contractDigest,
        development,
        gitRevision: development ? "" : yield* releaseGitRevision,
        stage,
      })
    ).pipe(Effect.mapError(deploymentConfigError));
    const production = !development;
    const isolation = production ? yield* recoveryIsolation : "";
    const kapsoBindings = yield* resolveKapsoBindings(development);
    const accessConfig = yield* resolveAccessConfig(development);

    yield* provisionEdgeSecurity.pipe(Effect.when(Effect.succeed(production)));

    const database = yield* Cloudflare.D1.Database("Database", {
      migrations: "../../apps/server/cloudflare/migrations",
      readReplication: { mode: "disabled" },
    });
    const statementStagingBucket = yield* Cloudflare.R2.Bucket("StatementStagingBucket");
    const emailBucket = yield* Cloudflare.R2.Bucket("ForwardedEmailBucket");
    const erasureBucket = yield* Cloudflare.R2.Bucket("TitularErasureBucket");
    const erasureRequired = development
      ? yield* initializeLocalErasureRegistry({ database, bucket: erasureBucket })
      : "true";
    const emailQueue = yield* Cloudflare.Queues.Queue("ForwardedEmailQueue");
    yield* Cloudflare.Worker("ForwardedEmail", {
      main: "../../apps/server/cloudflare/ingestion/email-worker.ts",
      observability: freeTierWorkerObservability,
      compatibility: { date: "2026-09-08" },
      crons: ["*/5 * * * *"],
      env: {
        DB: database,
        EMAIL_BUCKET: emailBucket,
        ERASURE_BUCKET: erasureBucket,
        ERASURE_REQUIRED: erasureRequired,
        EMAIL_QUEUE: emailQueue,
        RELEASE_GIT_SHA: releaseMetadata.gitRevision,
      },
      workersDev: false,
    });

    const statementExtractionQueue = yield* Cloudflare.Queues.Queue("StatementExtractionQueue");
    const statementExtractionWorkflow = Cloudflare.Workflow("StatementExtractionWorkflowV1", {
      className: "StatementExtractionWorkflowV1",
    });

    const asyncDeadLetters = yield* Cloudflare.Queues.Queue("AsyncDeadLetters");
    const operationalCanaryQueue = yield* Cloudflare.Queues.Queue("OperationalCanaryQueue");
    const operationalCanaryWorkflow = Cloudflare.Workflow("OperationalCanaryWorkflowV1", {
      className: "OperationalCanaryWorkflowV1",
    });
    const smokeBucket = yield* Cloudflare.R2.Bucket("ReleaseSmokeBucket");
    // Release-owned resources cannot dispatch a candidate envelope into the stable Core consumer.
    // Deferred retirement keeps the previous release's path intact until promotion passes.
    const smokeQueue = yield* Cloudflare.Queues.Queue(
      `ReleaseSmokeQueue-${releaseMetadata.gitRevision}`
    );
    const smokeWorkflow = Cloudflare.Workflow(
      `ReleaseSmokeWorkflowV2-${releaseMetadata.gitRevision}`,
      {
        className: "ReleaseSmokeWorkflowV2",
      }
    );
    const billingCollectionQueue = yield* Cloudflare.Queues.Queue("BillingCollectionQueue");
    const billingCollectionWorkflow = Cloudflare.Workflow("BillingCollectionWorkflowV1", {
      className: "BillingCollectionWorkflowV1",
    });
    const billingRefundWorkflow = Cloudflare.Workflow("BillingRefundWorkflowV1", {
      className: "BillingRefundWorkflowV1",
    });
    const hostedWhatsAppQueue = yield* Cloudflare.Queues.Queue("HostedWhatsAppQueue");
    const weeklyDeliveryQueue = yield* Cloudflare.Queues.Queue("WeeklyDeliveryQueue");
    const weeklyDeliveryWorkflow = Cloudflare.Workflow("WeeklyDeliveryWorkflow", {
      className: "ProactivityDeliveryWorkflow",
    });
    const browserPairingEmailQueue = yield* Cloudflare.Queues.Queue("BrowserPairingEmailQueue");
    const browserPairingEmailWorkflow = Cloudflare.Workflow("BrowserPairingEmailWorkflowV1", {
      className: "BrowserPairingEmailWorkflowV1",
    });
    const emailReplacementQueue = yield* Cloudflare.Queues.Queue("EmailReplacementQueue");
    const emailReplacementWorkflow = Cloudflare.Workflow("EmailReplacementWorkflowV1", {
      className: "EmailReplacementWorkflowV1",
    });
    const smokeExecutor = yield* Cloudflare.Worker(`ReleaseSmoke-${releaseMetadata.gitRevision}`, {
      main: "../../apps/server/cloudflare/release-smoke-worker.ts",
      observability: freeTierWorkerObservability,
      compatibility: { date: "2026-09-08" },
      workersDev: false,
      env: {
        DB: database,
        CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
        SMOKE_QUEUE_NAME: smokeQueue.queueName,
        SMOKE_WORKFLOW: smokeWorkflow,
        RELEASE_GIT_SHA: releaseMetadata.gitRevision,
        CONTRACT_DIGEST: releaseMetadata.contractDigest,
      },
    });
    const core = yield* Cloudflare.Worker("Core", {
      main: "../../apps/server/cloudflare/core-worker.ts",
      version: production
        ? {
            traffic: 0,
            tag: releaseMetadata.gitRevision,
            message: isolation === "isolated" ? "isolated" : "release",
          }
        : undefined,
      observability: freeTierWorkerObservability,
      compatibility: { date: "2026-09-08" },
      crons: ["* * * * *"],
      dev: {
        host: "127.0.0.1",
        port: productionTopology.core.localPort,
        strictPort: true,
      },
      env: {
        RECOVERY_ISOLATION: isolation,
        BANCOLOMBIA_SANDBOX_CLIENT_ID: yield* Config.String("BANCOLOMBIA_SANDBOX_CLIENT_ID").pipe(
          Config.withDefault("")
        ),
        BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: yield* Config.Redacted(
          "BANCOLOMBIA_SANDBOX_CONSENT_PROFILE"
        ).pipe(Config.withDefault(Redacted.make(""))),
        BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: yield* Config.Redacted(
          "BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM"
        ).pipe(Config.withDefault(Redacted.make(""))),
        AI: Cloudflare.Workers.AI(),
        CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
        SMOKE_LIMITER: Cloudflare.RateLimit("ReleaseSmokeAdmission", {
          namespaceId: 1493,
          simple: { limit: 8, period: 60 },
        }),
        SMOKE_PROOF: yield* development
          ? smokeProof.pipe(Config.withDefault(Redacted.make("")))
          : smokeProof,
        SMOKE_BUCKET: smokeBucket,
        SMOKE_QUEUE: smokeQueue,
        SMOKE_QUEUE_NAME: smokeQueue.queueName,
        SMOKE_WORKFLOW: Cloudflare.Workflow("ReleaseSmokeReference", {
          className: "ReleaseSmokeWorkflowV2",
          scriptName: smokeExecutor.workerName,
        }),
        CONTRACT_DIGEST: releaseMetadata.contractDigest,
        [productionTopology.core.d1Binding]: database,
        EMAIL_BUCKET: emailBucket,
        ERASURE_BUCKET: erasureBucket,
        ERASURE_REQUIRED: erasureRequired,
        STATEMENT_STAGING_BUCKET: statementStagingBucket,
        STATEMENT_EXTRACTION_QUEUE: statementExtractionQueue,
        HOSTED_WHATSAPP_QUEUE: hostedWhatsAppQueue,
        WEEKLY_DELIVERY_QUEUE: weeklyDeliveryQueue,
        WEEKLY_DELIVERY_WORKFLOW: weeklyDeliveryWorkflow,
        WEEKLY_SUMMARY_ENABLED: yield* Config.String("WEEKLY_SUMMARY_ENABLED").pipe(
          Config.withDefault("disabled")
        ),
        WEEKLY_SUMMARY_TEMPLATE_JSON: yield* Config.String("WEEKLY_SUMMARY_TEMPLATE_JSON").pipe(
          Config.withDefault("")
        ),
        WEEKLY_QUESTION_TEMPLATE_JSON: yield* Config.String("WEEKLY_QUESTION_TEMPLATE_JSON").pipe(
          Config.withDefault("")
        ),
        PROACTIVITY_ENABLED: yield* Config.String("PROACTIVITY_ENABLED").pipe(
          Config.withDefault("disabled")
        ),
        PROACTIVITY_TEMPLATE_JSON: yield* Config.String("PROACTIVITY_TEMPLATE_JSON").pipe(
          Config.withDefault("")
        ),
        PROACTIVITY_ASK_AFTER: yield* Config.String("PROACTIVITY_ASK_AFTER").pipe(
          Config.withDefault("4")
        ),
        PROACTIVITY_PAUSE_AFTER: yield* Config.String("PROACTIVITY_PAUSE_AFTER").pipe(
          Config.withDefault("2")
        ),
        STATEMENT_EXTRACTION_WORKFLOW: statementExtractionWorkflow,
        USER_TRANSACTION_COORDINATOR: Cloudflare.DurableObject("UserTransactionCoordinator", {
          className: "UserTransactionCoordinator",
        }),
        HOSTED_AI_MODEL: yield* hostedAiModel,
        KAPSO_API_KEY: kapsoBindings.apiKey,
        KAPSO_WEBHOOK_SECRET: kapsoBindings.webhookSecret,
        ASYNC_HEALTH_ENABLED: "enabled",
        ASYNC_DEAD_LETTERS: asyncDeadLetters,
        OPERATIONAL_CANARY_QUEUE: operationalCanaryQueue,
        OPERATIONAL_CANARY_QUEUE_NAME: operationalCanaryQueue.queueName,
        OPERATIONAL_CANARY_WORKFLOW: operationalCanaryWorkflow,
        FORWARDED_EMAIL_QUEUE: emailQueue,
        BILLING_COLLECTION_QUEUE: billingCollectionQueue,
        BILLING_COLLECTION_WORKFLOW: billingCollectionWorkflow,
        BILLING_REFUND_WORKFLOW: billingRefundWorkflow,
        ERASURE_SUPPORT_AUDIENCE: accessConfig.erasureAudience,
        BILLING_SUPPORT_AUDIENCE: yield* Config.String("BILLING_SUPPORT_AUDIENCE").pipe(
          Config.withDefault("")
        ),
        BROWSER_PAIRING_EMAIL_QUEUE: browserPairingEmailQueue,
        BROWSER_PAIRING_EMAIL_WORKFLOW: browserPairingEmailWorkflow,
        EMAIL_REPLACEMENT_QUEUE: emailReplacementQueue,
        EMAIL_REPLACEMENT_HEALTH_QUEUE: emailReplacementQueue,
        EMAIL_REPLACEMENT_WORKFLOW: emailReplacementWorkflow,
        RESEND_API_KEY: yield* resolveResendKey(development),
        GOOGLE_CLIENT_ID: yield* development
          ? googleClientId.pipe(Config.withDefault(""))
          : googleClientId,
        GOOGLE_CLIENT_SECRET: yield* development
          ? googleClientSecret.pipe(Config.withDefault(Redacted.make("")))
          : googleClientSecret,
        GOOGLE_REDIRECT_URI: production
          ? "https://api.fidyapp.com/providers/google/callback"
          : "http://localhost:8787/providers/google/callback",
        MICROSOFT_CLIENT_ID: yield* development
          ? microsoftClientId.pipe(Config.withDefault(""))
          : microsoftClientId,
        MICROSOFT_CLIENT_SECRET: yield* development
          ? microsoftClientSecret.pipe(Config.withDefault(Redacted.make("")))
          : microsoftClientSecret,
        MICROSOFT_REDIRECT_URI: production
          ? "https://api.fidyapp.com/providers/microsoft/callback"
          : "http://localhost:8787/providers/microsoft/callback",
        BROWSER_ORIGIN: resolveBrowserOrigin(production),
        WOMPI_ENVIRONMENT: yield* development
          ? wompiEnvironment.pipe(Config.withDefault("sandbox"))
          : wompiEnvironment,
        WOMPI_PUBLIC_KEY: yield* development
          ? wompiPublicKey.pipe(Config.withDefault(""))
          : wompiPublicKey,
        WOMPI_PRIVATE_KEY: yield* development
          ? wompiPrivateKey.pipe(Config.withDefault(Redacted.make("")))
          : wompiPrivateKey,
        WOMPI_INTEGRITY_SECRET: yield* development
          ? wompiIntegritySecret.pipe(Config.withDefault(Redacted.make("")))
          : wompiIntegritySecret,
        WOMPI_DAVIPLATA_ACTIVATED: yield* daviplataActivated,
        WOMPI_DAVIPLATA_OTP_SEND_URL: yield* daviplataOtpSendUrl,
        WOMPI_DAVIPLATA_OTP_CONFIRM_URL: yield* daviplataOtpConfirmUrl,
        WOMPI_EVENT_SECRET: yield* development
          ? wompiEventSecret.pipe(Config.withDefault(Redacted.make("")))
          : wompiEventSecret,
        CLOUDFLARE_ACCESS_ISSUER: accessConfig.issuer,
        CLOUDFLARE_ACCESS_AUDIENCE: accessConfig.audience,
        WHATSAPP_BUSINESS_PORTFOLIO_ID: kapsoBindings.portfolioId,
        WHATSAPP_SANDBOX_PHONE_NUMBER_ID: kapsoBindings.sandboxPhoneNumberId,
        RELEASE_GIT_SHA: releaseMetadata.gitRevision,
      },
      workersDev: productionTopology.core.workersDev,
    });

    const bancolombiaCertificate = yield* Config.String("BANCOLOMBIA_SANDBOX_CERTIFICATE_ID").pipe(
      Config.withDefault("")
    );
    if (production && bancolombiaCertificate.length > 0) {
      yield* Config.schema(
        Schema.String.check(Schema.isUUID()),
        "BANCOLOMBIA_SANDBOX_CERTIFICATE_ID"
      );
      yield* core.bind`bancolombia-sandbox-mtls`({
        bindings: [
          {
            type: "mtls_certificate",
            name: "BANCOLOMBIA_SANDBOX_MTLS",
            certificateId: bancolombiaCertificate,
          },
        ],
      });
    }

    yield* Cloudflare.Queues.Consumer("OperationalCanaryConsumer", {
      queueId: operationalCanaryQueue.queueId,
      scriptName: core.workerName,
      deadLetterQueue: asyncDeadLetters.queueName,
      settings: { batchSize: 1, maxRetries: 3 },
    });
    yield* Cloudflare.Queues.Consumer(`ReleaseSmokeConsumer-${releaseMetadata.gitRevision}`, {
      queueId: smokeQueue.queueId,
      scriptName: smokeExecutor.workerName,
      deadLetterQueue: asyncDeadLetters.queueName,
      settings: { batchSize: 1, maxRetries: 3 },
    });
    yield* Cloudflare.Queues.Consumer("ForwardedEmailConsumer", {
      queueId: emailQueue.queueId,
      scriptName: core.workerName,
      deadLetterQueue: asyncDeadLetters.queueName,
      settings: { batchSize: 10, maxRetries: 3 },
    });

    yield* Cloudflare.Queues.Consumer("StatementExtractionConsumer", {
      queueId: statementExtractionQueue.queueId,
      scriptName: core.workerName,
      deadLetterQueue: asyncDeadLetters.queueName,
      settings: { batchSize: 10, maxRetries: 3 },
    });

    yield* Cloudflare.Queues.Consumer("BillingCollectionConsumer", {
      queueId: billingCollectionQueue.queueId,
      scriptName: core.workerName,
      deadLetterQueue: asyncDeadLetters.queueName,
      settings: { batchSize: 10, maxRetries: 3 },
    });

    yield* Cloudflare.Queues.Consumer("BrowserPairingEmailConsumer", {
      queueId: browserPairingEmailQueue.queueId,
      scriptName: core.workerName,
      deadLetterQueue: asyncDeadLetters.queueName,
      settings: { batchSize: 10, maxRetries: 3 },
    });
    yield* Cloudflare.Queues.Consumer("EmailReplacementConsumer", {
      queueId: emailReplacementQueue.queueId,
      scriptName: core.workerName,
      deadLetterQueue: asyncDeadLetters.queueName,
      settings: { batchSize: 10, maxRetries: 3 },
    });

    yield* Cloudflare.Queues.Consumer("WeeklyDeliveryConsumer", {
      queueId: weeklyDeliveryQueue.queueId,
      scriptName: core.workerName,
      deadLetterQueue: asyncDeadLetters.queueName,
      settings: { batchSize: 10, maxRetries: 3 },
    });

    yield* Cloudflare.Queues.Consumer("HostedWhatsAppConsumer", {
      queueId: hostedWhatsAppQueue.queueId,
      scriptName: core.workerName,
      deadLetterQueue: asyncDeadLetters.queueName,
      settings: { batchSize: 10, maxRetries: 3 },
    });

    const ingress = yield* Cloudflare.Worker("Ingress", {
      main: "../../apps/server/cloudflare/public-worker.ts",
      version: production ? { traffic: 0, tag: releaseMetadata.gitRevision } : undefined,
      observability: freeTierWorkerObservability,
      compatibility: { date: "2026-09-08" },
      dev: {
        host: "127.0.0.1",
        port: productionTopology.ingress.localPort,
        strictPort: true,
      },
      domain: production ? productionTopology.ingress.hostname : undefined,
      env: {
        RECOVERY_ISOLATION: isolation,
        BROWSER_ORIGIN: resolveBrowserOrigin(production),
        CONTRACT_DIGEST: releaseMetadata.contractDigest,
        CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
        SMOKE_PROOF: yield* development
          ? smokeProof.pipe(Config.withDefault(Redacted.make("")))
          : smokeProof,
        [productionTopology.ingress.coreBinding]: core,
        LOCAL_CANONICAL_READ_BEARER: resolveLocalCanonicalReadBearer(development),
        PAT_ADMISSION_KEY: yield* resolvePatAdmissionKey(development),
        RELEASE_GIT_SHA: releaseMetadata.gitRevision,
      },
      workersDev: production ? productionTopology.ingress.workersDev : true,
    });

    const web = yield* Cloudflare.Website.StaticSite("Web", {
      name: productionTopology.web.workerName,
      observability: freeTierWorkerObservability,
      command: "bun run build:production",
      cwd: "../../apps/web",
      outdir: "dist",
      env: {
        CONTRACT_DIGEST: releaseMetadata.contractDigest,
        RELEASE_GIT_SHA: releaseMetadata.gitRevision,
      },
      dev: {
        command: `bun run dev -- --host 127.0.0.1 --port ${productionTopology.web.localPort} --strictPort`,
        cwd: "../../apps/web",
        env: {
          VITE_API_ORIGIN: `http://127.0.0.1:${productionTopology.ingress.localPort}`,
        },
      },
      assets: {
        htmlHandling: "none",
        notFoundHandling: "single-page-application",
      },
      domain: production
        ? {
            name: productionTopology.web.hostname,
            redirects: [...productionTopology.web.redirects],
          }
        : undefined,
      workersDev: production ? productionTopology.web.workersDev : true,
    }).pipe(Alchemy.AdoptPolicy.adopt(production && productionTopology.web.adoptExistingWorker));

    const site = yield* Cloudflare.Website.StaticSite("Site", {
      name: productionTopology.site.workerName,
      observability: freeTierWorkerObservability,
      command: "bun run build:production",
      cwd: "../../apps/site",
      outdir: "dist",
      env: { RELEASE_GIT_SHA: releaseMetadata.gitRevision },
      dev: {
        command: `bun run dev -- --host 127.0.0.1 --port ${productionTopology.site.localPort}`,
        cwd: "../../apps/site",
      },
      assets: { htmlHandling: "drop-trailing-slash", notFoundHandling: "404-page" },
      domain: production ? productionTopology.site.hostname : undefined,
      workersDev: production ? productionTopology.site.workersDev : true,
    });

    return {
      siteUrl: site.url,
      apiUrl: ingress.url,
      webUrl: web.url,
    };
  })
);
