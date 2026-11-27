import { marketingSite } from "./marketing-site";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Config, Effect, Layer, Schema } from "effect";
import { productionTopology } from "../../apps/server/cloudflare/runtime/contract";
import { resolveStateBackend } from "./deployment-configuration";
import { installationNames, storageNamespaces } from "./storage-installation";
import { freeTierWorkerObservability } from "./worker-observability";
import {
  type NativeRelease,
  bindPlannedText,
  ingressBindings,
  nativeReleaseContext,
  operatingBindings,
  privateAccessBindings,
  providerBindings,
} from "./native-application-bindings";
import {
  type NativeQueues,
  installConsumers,
  nativeBuckets,
  nativeQueues,
  nativeWorkflows,
} from "./native-application-resources";

export const nativeState = Layer.unwrap(
  Effect.gen(function* () {
    const development = yield* Alchemy.ALCHEMY_DEV,
      stage = yield* Alchemy.Stage;

    const backend = resolveStateBackend({ development, stage });

    if (backend === "cloudflare") return Cloudflare.state();

    if (backend === "local") return Alchemy.localState();

    return Alchemy.inMemoryState();
  }).pipe(Effect.catchTag("ConfigError", Effect.die))
);

const workerPolicy = {
  compatibility: { date: "2026-09-08" },
  observability: freeTierWorkerObservability,
  workersDev: false,
} as const;

const apiCompatibility = {
  ...workerPolicy.compatibility,
  flags: ["enable_request_signal", "request_signal_passthrough"],
};

const domain = (release: NativeRelease, hostname: string): Cloudflare.WorkerProps["domain"] =>
  release.development ? undefined : hostname;

const bindSandboxCertificate = Effect.fn(function* (core: Cloudflare.Worker) {
  const certificate = yield* Config.String("BANCOLOMBIA_SANDBOX_CERTIFICATE_ID").pipe(
    Config.withDefault("")
  );

  if (certificate !== "") {
    yield* Schema.decodeEffect(Schema.String.check(Schema.isUUID()))(certificate).pipe(
      Effect.orDie
    );
    yield* core.bind`bancolombia-sandbox-mtls`({
      bindings: [
        {
          type: "mtls_certificate",
          name: "BANCOLOMBIA_SANDBOX_MTLS",
          certificateId: certificate,
        },
      ],
    });
  }
});

const coreWorker = Effect.fn(function* ({
  release,
  queues,
  buckets,
}: {
  release: NativeRelease;
  queues: NativeQueues;
  buckets: Effect.Success<typeof nativeBuckets>;
}) {
  const {
    BETA_PRO_AUDIENCE,
    SAMPLE_REVIEW_AUDIENCE,
    CLOUDFLARE_ACCESS_AUDIENCE,
    ERASURE_SUPPORT_AUDIENCE,
    ...access
  } = yield* privateAccessBindings(release);

  const core = yield* Cloudflare.Worker("Core", {
    ...workerPolicy,
    compatibility: apiCompatibility,
    name: installationNames.Core,
    main: "../../apps/server/cloudflare/core-worker.ts",
    crons: ["* * * * *"],
    dev: { host: "127.0.0.1", port: productionTopology.core.localPort, strictPort: true },
    env: {
      ...release.shared,
      ...buckets,
      ...queues,
      ...(yield* nativeWorkflows),
      ...(yield* storageNamespaces),
      ...(yield* operatingBindings),
      ...access,
      ...(yield* providerBindings(release)),
    },
  });

  yield* bindPlannedText(core, {
    BETA_PRO_AUDIENCE,
    SAMPLE_REVIEW_AUDIENCE,
    CLOUDFLARE_ACCESS_AUDIENCE,
    ERASURE_SUPPORT_AUDIENCE,
    CONNECTION_SYNCHRONIZATION_QUEUE_NAME: queues.CONNECTION_SYNCHRONIZATION_QUEUE.queueName,
    OPERATIONAL_CANARY_QUEUE_NAME: queues.OPERATIONAL_CANARY_QUEUE.queueName,
  });

  if (!release.development) yield* bindSandboxCertificate(core);

  return core;
});

const webApplication = Effect.fn(function* (release: NativeRelease) {
  return yield* Cloudflare.Website.StaticSite("Web", {
    name: installationNames.Web,
    observability: freeTierWorkerObservability,
    command: "bun run build:production",
    cwd: "../../apps/web",
    outdir: "dist",
    env: {
      CONTRACT_DIGEST: release.release.contractDigest,
      RELEASE_GIT_SHA: release.release.gitRevision,
    },
    dev: {
      command: `bun run dev -- --host 127.0.0.1 --port ${productionTopology.web.localPort} --strictPort`,
      cwd: "../../apps/web",
      env: { VITE_API_ORIGIN: `http://127.0.0.1:${productionTopology.ingress.localPort}` },
    },
    assets: { htmlHandling: "none", notFoundHandling: "single-page-application" },
    domain: domain(release, productionTopology.web.hostname),
    workersDev: false,
  });
});

export const nativeApplication = Effect.gen(function* () {
  const release = yield* nativeReleaseContext(yield* Alchemy.ALCHEMY_DEV, yield* Alchemy.Stage);

  const queues = yield* nativeQueues,
    buckets = yield* nativeBuckets;

  const core = yield* coreWorker({ release, queues, buckets });
  yield* installConsumers({ queues, core });
  yield* Cloudflare.Worker("ForwardedEmail", {
    ...workerPolicy,
    name: installationNames.ForwardedEmail,
    main: "../../apps/server/cloudflare/ingestion/email-worker.ts",
    env: { RELEASE_GIT_SHA: release.release.gitRevision },
  });

  const ingress = yield* Cloudflare.Worker("Ingress", {
    ...workerPolicy,
    compatibility: apiCompatibility,
    name: installationNames.Ingress,
    main: "../../apps/server/cloudflare/public-worker.ts",
    dev: { host: "127.0.0.1", port: productionTopology.ingress.localPort, strictPort: true },
    domain: domain(release, productionTopology.ingress.hostname),
    env: {
      ...release.shared,
      ...(yield* ingressBindings(release)),
      CORE: core,
    },
  });

  const web = yield* webApplication(release);

  if (release.development) yield* marketingSite(release.release.gitRevision, false);

  return { apiUrl: ingress.url, webUrl: web.url };
});
