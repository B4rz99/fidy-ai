import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ApprovedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { resolveDeploymentConfiguration, resolveStateBackend } from "./deployment-configuration";
import { edgeSecurityPolicy } from "./edge-security";
import { browserOrigins, productionTopology, resolveLocalCanonicalReadBearer } from "./topology";

const releaseGitRevision = Config.String("RELEASE_GIT_SHA").pipe(Config.withDefault(""));
const contractDigest = Config.String("CONTRACT_DIGEST").pipe(Config.withDefault(""));
const hostedAiModel = Config.schema(ApprovedWorkersAiModel, "HOSTED_AI_MODEL");
const kapsoWebhookSecret = Config.Redacted("KAPSO_WEBHOOK_SECRET");
const kapsoApiKey = Config.Redacted("KAPSO_API_KEY");
const resendApiKey = Config.Redacted("RESEND_API_KEY");
const wompiEnvironment = Config.String("WOMPI_ENVIRONMENT");
const wompiPublicKey = Config.String("WOMPI_PUBLIC_KEY");
const wompiPrivateKey = Config.Redacted("WOMPI_PRIVATE_KEY");
const wompiIntegritySecret = Config.Redacted("WOMPI_INTEGRITY_SECRET");
const accessIssuer = Config.String("CLOUDFLARE_ACCESS_ISSUER");
const accessAudience = Config.String("CLOUDFLARE_ACCESS_AUDIENCE");
const whatsAppBusinessPortfolioId = Config.String("WHATSAPP_BUSINESS_PORTFOLIO_ID");

const resolveKapsoBindings = (
  development: boolean
): Effect.Effect<
  Readonly<{
    apiKey: Redacted.Redacted<string>;
    webhookSecret: Redacted.Redacted<string>;
    portfolioId: string;
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
    return { apiKey, webhookSecret, portfolioId };
  });

const resolveResendKey = (development: boolean): typeof resendApiKey =>
  development ? resendApiKey.pipe(Config.withDefault(Redacted.make(""))) : resendApiKey;

const resolveAccessConfig = (
  development: boolean
): Effect.Effect<Readonly<{ issuer: string; audience: string }>, Config.ConfigError> =>
  Effect.gen(function* () {
    const issuer = yield* development ? accessIssuer.pipe(Config.withDefault("")) : accessIssuer;
    const audience = yield* development
      ? accessAudience.pipe(Config.withDefault(""))
      : accessAudience;
    return { issuer, audience };
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
  // eslint-disable-next-line complexity -- Provisioning collects independent Worker bindings and resources.
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
    const kapsoBindings = yield* resolveKapsoBindings(development);
    const accessConfig = yield* resolveAccessConfig(development);

    yield* provisionEdgeSecurity.pipe(Effect.when(Effect.succeed(production)));

    const database = yield* Cloudflare.D1.Database("Database", {
      migrations: "./migrations",
      readReplication: { mode: "disabled" },
    });

    const onboardingEmailQueue = yield* Cloudflare.Queues.Queue("OnboardingEmailQueue");
    const onboardingEmailWorkflow = Cloudflare.Workflow("OnboardingEmailWorkflowV1", {
      className: "OnboardingEmailWorkflowV1",
    });
    const browserPairingEmailQueue = yield* Cloudflare.Queues.Queue("BrowserPairingEmailQueue");
    const browserPairingEmailWorkflow = Cloudflare.Workflow("BrowserPairingEmailWorkflowV1", {
      className: "BrowserPairingEmailWorkflowV1",
    });
    const core = yield* Cloudflare.Worker("Core", {
      main: "./core-worker.ts",
      compatibility: { date: "2026-09-08" },
      crons: ["* * * * *"],
      dev: {
        host: "127.0.0.1",
        port: productionTopology.core.localPort,
        strictPort: true,
      },
      env: {
        AI: Cloudflare.Workers.AI(),
        CONTRACT_DIGEST: releaseMetadata.contractDigest,
        [productionTopology.core.d1Binding]: database,
        HOSTED_AI_MODEL: yield* hostedAiModel,
        KAPSO_API_KEY: kapsoBindings.apiKey,
        KAPSO_WEBHOOK_SECRET: kapsoBindings.webhookSecret,
        ONBOARDING_EMAIL_QUEUE: onboardingEmailQueue,
        ONBOARDING_EMAIL_WORKFLOW: onboardingEmailWorkflow,
        BROWSER_PAIRING_EMAIL_QUEUE: browserPairingEmailQueue,
        BROWSER_PAIRING_EMAIL_WORKFLOW: browserPairingEmailWorkflow,
        RESEND_API_KEY: yield* resolveResendKey(development),
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
        CLOUDFLARE_ACCESS_ISSUER: accessConfig.issuer,
        CLOUDFLARE_ACCESS_AUDIENCE: accessConfig.audience,
        WHATSAPP_BUSINESS_PORTFOLIO_ID: kapsoBindings.portfolioId,
        RELEASE_GIT_SHA: releaseMetadata.gitRevision,
      },
      workersDev: productionTopology.core.workersDev,
    });

    yield* Cloudflare.Queues.Consumer("OnboardingEmailConsumer", {
      queueId: onboardingEmailQueue.queueId,
      scriptName: core.workerName,
      settings: { batchSize: 10, maxRetries: 3 },
    });
    yield* Cloudflare.Queues.Consumer("BrowserPairingEmailConsumer", {
      queueId: browserPairingEmailQueue.queueId,
      scriptName: core.workerName,
      settings: { batchSize: 10, maxRetries: 3 },
    });

    const ingress = yield* Cloudflare.Worker("Ingress", {
      main: "./public-worker.ts",
      compatibility: { date: "2026-09-08" },
      dev: {
        host: "127.0.0.1",
        port: productionTopology.ingress.localPort,
        strictPort: true,
      },
      domain: production ? productionTopology.ingress.hostname : undefined,
      env: {
        BROWSER_ORIGIN: resolveBrowserOrigin(production),
        [productionTopology.ingress.coreBinding]: core,
        LOCAL_CANONICAL_READ_BEARER: resolveLocalCanonicalReadBearer(development),
        RELEASE_GIT_SHA: releaseMetadata.gitRevision,
      },
      workersDev: production ? productionTopology.ingress.workersDev : true,
    });

    const web = yield* Cloudflare.Website.StaticSite("Web", {
      name: productionTopology.web.workerName,
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

    return {
      apiUrl: ingress.url,
      webUrl: web.url,
    };
  })
);
