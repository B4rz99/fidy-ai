import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Layer, Schema } from "effect";
import { productionTopology } from "../../apps/server/cloudflare/runtime/contract";
import { resolveStateBackend } from "./deployment-configuration";
import {
  installationNames,
  nativeIngressHost,
  nativeWebHost,
  storageNamespaces,
} from "./storage-installation";
import { freeTierWorkerObservability } from "./worker-observability";
import {
  type NativeRelease,
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
  nativeSmokeExecutor,
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
  }).pipe(Effect.orDie)
);
const workerPolicy = {
  compatibility: { date: "2026-09-08" },
  observability: freeTierWorkerObservability,
  workersDev: false,
} as const;
const network = (
  release: NativeRelease,
  acceptance: string,
  ordinary: string
): Cloudflare.WorkerProps["domain"] =>
  release.development
    ? undefined
    : { name: acceptance, aliases: release.hosts === "staged" ? [ordinary] : [] };
const candidate = (release: NativeRelease): Cloudflare.WorkerProps["version"] =>
  release.development
    ? undefined
    : {
        traffic: 0,
        tag: release.release.versionTag,
        message: release.closed ? "isolated" : "release",
      };

const coreWorker = Effect.fn(function* ({
  release,
  queues,
  buckets,
  executor,
}: {
  release: NativeRelease;
  queues: NativeQueues;
  buckets: Effect.Success<typeof nativeBuckets>;
  executor: Effect.Success<ReturnType<typeof nativeSmokeExecutor>>;
}) {
  const core = yield* Cloudflare.Worker("Core", {
    ...workerPolicy,
    name: installationNames.Core,
    main: "../../apps/server/cloudflare/core-worker.ts",
    version: candidate(release),
    crons: ["* * * * *"],
    dev: { host: "127.0.0.1", port: productionTopology.core.localPort, strictPort: true },
    env: {
      ...release.shared,
      ...buckets,
      ...queues,
      ...(yield* nativeWorkflows),
      ...(yield* storageNamespaces),
      ...(yield* operatingBindings),
      ...(yield* privateAccessBindings(release)),
      ...(yield* providerBindings(release)),
      SMOKE_LIMITER: Cloudflare.RateLimit("ReleaseSmokeAdmission", {
        namespaceId: 2257,
        simple: { limit: 8, period: 60 },
      }),
      SMOKE_QUEUE_NAME: queues.SMOKE_QUEUE.queueName,
      SMOKE_WORKFLOW: executor.reference,
      CONNECTION_SYNCHRONIZATION_QUEUE_NAME: queues.CONNECTION_SYNCHRONIZATION_QUEUE.queueName,
      OPERATIONAL_CANARY_QUEUE_NAME: queues.OPERATIONAL_CANARY_QUEUE.queueName,
    },
  });
  if (!release.development && !release.closed) {
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
  }
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
    domain: network(release, nativeWebHost, productionTopology.web.hostname),
    workersDev: false,
  });
});
const localSite = Effect.fn(function* (release: NativeRelease) {
  yield* Cloudflare.Website.StaticSite("Site", {
    name: productionTopology.site.workerName,
    main: "../../apps/site/cloudflare/worker.ts",
    observability: freeTierWorkerObservability,
    command: "bun run build:production",
    cwd: "../../apps/site",
    outdir: "dist",
    env: { RELEASE_GIT_SHA: release.release.gitRevision },
    dev: {
      command: `bun run dev -- --host 127.0.0.1 --port ${productionTopology.site.localPort}`,
      cwd: "../../apps/site",
    },
    assets: {
      htmlHandling: "drop-trailing-slash",
      notFoundHandling: "404-page",
      runWorkerFirst: ["/*", "!/_astro/*", "!/*.png", "!/*.webp"],
    },
    workersDev: false,
  });
});
export const nativeApplication = Effect.gen(function* () {
  const release = yield* nativeReleaseContext(yield* Alchemy.ALCHEMY_DEV, yield* Alchemy.Stage);
  const queues = yield* nativeQueues(release.release.gitRevision),
    buckets = yield* nativeBuckets;
  const executor = yield* nativeSmokeExecutor({ release, queues, buckets });
  const core = yield* coreWorker({ release, queues, buckets, executor });
  yield* installConsumers({
    queues,
    revision: release.release.gitRevision,
    core,
    smoke: executor.smoke,
  });
  yield* Cloudflare.Worker("ForwardedEmail", {
    ...workerPolicy,
    name: installationNames.ForwardedEmail,
    main: "../../apps/server/cloudflare/ingestion/email-worker.ts",
    env: { RELEASE_GIT_SHA: release.release.gitRevision },
  });
  const ingress = yield* Cloudflare.Worker("Ingress", {
    ...workerPolicy,
    name: installationNames.Ingress,
    main: "../../apps/server/cloudflare/public-worker.ts",
    version: candidate(release),
    dev: { host: "127.0.0.1", port: productionTopology.ingress.localPort, strictPort: true },
    domain: network(release, nativeIngressHost, productionTopology.ingress.hostname),
    env: { ...release.shared, ...(yield* ingressBindings(release)), CORE: core },
  });
  const web = yield* webApplication(release);
  if (release.development) yield* localSite(release);
  return { apiUrl: ingress.url, webUrl: web.url };
});
