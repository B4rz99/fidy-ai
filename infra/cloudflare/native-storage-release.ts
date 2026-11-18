import { verifyNativeEdge } from "./native-edge";
import { Context, Effect, Layer, Option, Config as ReleaseConfig, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import {
  SharedStoreMarkers,
  bootstrapQuery,
  compatibilityQuery,
} from "../../apps/server/cloudflare/storage-bootstrap/contract";
import { ReleaseHttpLive } from "./release-http";
import {
  type ProductionReleaseConfig as Config,
  ReleaseFailure,
  releaseEvidence,
  releaseFailureMessage,
  releasePort,
} from "./production-release";
import { type ReleasePort, releaseController, releaseSchemas } from "./release-controller";
import { RollbackReceipt, releaseRollback } from "./release-rollback";
import {
  buildStorageRelease,
  compatibleStoragePairs,
  storageOverlap,
  storageOwners,
  verifiedStoragePair,
} from "./storage-release";
import {
  installationNames,
  nativeIngressHost,
  nativeStack,
  nativeWebHost,
  requireAbsentInstallation,
} from "./storage-installation";
import { smokeHeaders } from "./smoke-exchange";
import { rollbackCompatible, type verifiedVersionResources } from "./rollback-compatibility";

const {
  providerJson,
  workersFromState,
  readStablePair,
  versionResources,
  encodeJson,
  readFile,
  writeFile,
  proveRecoveryCorePrivate,
  verifyTaxonomyOverlap,
  rollbackSource,
} = releaseEvidence;
const origin = "https://" + nativeIngressHost;
const successStatusStart = 200;
const recoveryUnavailableStatus = 503;
const IngressDomainResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(
    Schema.Struct({ hostname: Schema.NonEmptyString, service: Schema.NonEmptyString })
  ),
});
const installedDomains = Effect.fn(function* (
  get: (path: string) => Effect.Effect<unknown, Error>
) {
  return (yield* Effect.forEach([nativeIngressHost, nativeWebHost], (host) =>
    get("workers/domains?hostname=" + host).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(IngressDomainResponse)),
      Effect.map((response) => response.result)
    )
  )).flat();
});
const firstInstallInventory = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  const get = (path: string): Effect.Effect<unknown, Error> =>
    providerJson(
      HttpClientRequest.get(
        `https://api.cloudflare.com/client/v4/accounts/${env.account}/${path}`,
        { headers: { authorization: `Bearer ${env.token}` } }
      )
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
  const scripts = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
    })
  )(yield* get("workers/scripts"));
  const pages = Effect.fn(function* <A>(path: string, item: Schema.Codec<A>) {
    const result: A[] = [];
    for (let page = 1; ; page++) {
      const limit = 100;
      const body = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          success: Schema.Literal(true),
          result: Schema.Array(item),
          result_info: Schema.optional(
            Schema.Struct({ page: Schema.Int, total_pages: Schema.optional(Schema.Int) })
          ),
        })
      )(yield* get(`${path}?per_page=${limit}&page=${page}`));
      if (body.result_info !== undefined && body.result_info.page !== page) {
        return yield* new ReleaseFailure({ message: "Inventory pagination changed" });
      }
      result.push(...body.result);
      if (
        body.result_info?.total_pages !== undefined
          ? page >= body.result_info.total_pages
          : body.result.length < limit
      ) {
        return result;
      }
      if (page === 100) {
        return yield* new ReleaseFailure({ message: "Inventory exceeds the bounded release scan" });
      }
    }
  });
  return {
    scripts: scripts.result,
    namespaces: yield* pages(
      "workers/durable_objects/namespaces",
      Schema.Struct({
        script: Schema.NonEmptyString,
        id: Schema.NonEmptyString,
        class: Schema.NonEmptyString,
        use_sqlite: Schema.optional(Schema.Boolean),
      })
    ),
    domains: yield* installedDomains(get),
  };
});

const verifyStorageUpload = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );
  yield* Effect.try(() => requireNativeTarget(snapshot));
  if (snapshot.revision !== env.revision) {
    return yield* new ReleaseFailure({
      message: "Storage upload snapshot differs from protected build",
    });
  }
  yield* releaseController.requireTrunk(port, env.revision);
  yield* releaseController.requireCapturedWorker(port, snapshot.public);
  yield* releaseController.requireCapturedWorker(port, snapshot.core);
  const stable = Effect.fn(function* (worker: typeof snapshot.core) {
    return yield* versionResources(env, client, {
      name: worker.name,
      id: worker.stableVersionId,
      revision: snapshot.stableRevision,
    });
  });
  const ingress = yield* stable(snapshot.public);
  const core = yield* stable(snapshot.core);
  const stored = yield* Effect.try(() =>
    verifiedStoragePair({ ingress: ingress.bindings, core: core.bindings })
  );
  yield* proveRecoveryCorePrivate(env, client, installationNames.Core);
  yield* verifyInstalledNamespaces({ env, client, storage: stored, workers: [ingress, core] });
  const candidate = yield* buildStorageRelease();
  if (!storageOverlap({ stable: stored.description, candidate }).forward) {
    return yield* new ReleaseFailure({
      message: "Incompatible native history or protocol before upload",
    });
  }
  yield* verifyTaxonomyOverlap(snapshot);
});

const verifyFreshTarget = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* releaseController.requireTrunk(port, env.revision);
  const inventory = yield* firstInstallInventory(env, client);
  yield* Effect.try({
    try: () => requireAbsentInstallation(inventory),
    catch: () =>
      new ReleaseFailure({
        message: "Fresh installation refused: an existing target must be inspected",
      }),
  });
});

const prepareClosedEdge = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  if (
    (yield* ReleaseConfig.String("GITHUB_ACTIONS")) !== "true" ||
    (yield* ReleaseConfig.String("GITHUB_REF")) !== "refs/heads/trunk" ||
    (yield* ReleaseConfig.String("GITHUB_EVENT_NAME")) !== "workflow_dispatch" ||
    (yield* ReleaseConfig.String("NATIVE_STORAGE_ADMISSION")) !== "closed"
  ) {
    return yield* new ReleaseFailure({ message: "Requires the closed protected installation" });
  }
  yield* verifyFreshTarget(env, client, port);
  yield* verifyNativeEdge(env, client, true);
});

const verifyInstalledNamespaces = Effect.fn(function* ({
  env,
  client,
  storage,
  workers,
}: {
  env: Config;
  client: HttpClient.HttpClient;
  storage: ReturnType<typeof verifiedStoragePair>;
  workers: ReadonlyArray<ReturnType<typeof verifiedVersionResources>>;
}) {
  const inventory = yield* firstInstallInventory(env, client);
  const nativeIds = new Set(
    inventory.namespaces
      .filter((namespace) => namespace.script === installationNames.Core && namespace.use_sqlite)
      .map((namespace) => namespace.id)
  );
  if (
    nativeIds.size !== storage.namespaces.length ||
    storage.namespaces.some((id) => !nativeIds.has(id)) ||
    !inventory.domains.some(
      (domain) =>
        domain.hostname === nativeIngressHost && domain.service === installationNames.Ingress
    )
  ) {
    return yield* new ReleaseFailure({ message: "Fresh namespace or network identity differs" });
  }
  yield* requireClosedWorkers(workers);
});
const verifyInstalledMarkers = Effect.fn(function* ({
  env,
  client,
  pair,
  storage,
}: {
  env: Config;
  client: HttpClient.HttpClient;
  pair: { publicStable: string; coreStable: string };
  storage: ReturnType<typeof verifiedStoragePair>;
}) {
  const request = HttpClientRequest.post(origin + "/internal/release-smoke" + bootstrapQuery, {
    headers: { "x-fidy-smoke-proof": env.smokeProof },
  });
  const result = yield* client.execute(request);
  const proof = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ core: SmokeIdentity, markers: SharedStoreMarkers })
  )(yield* result.json);
  if (
    result.status !== successStatusStart ||
    result.headers["x-fidy-smoke-worker-version"] !== pair.publicStable ||
    proof.core.workerVersionId !== pair.coreStable ||
    proof.core.gitRevision !== env.revision ||
    encodeJson(storage.description) !== encodeJson(yield* buildStorageRelease()) ||
    storageOwners.some(
      (owner) =>
        proof.markers[owner].workerVersionId !== pair.coreStable ||
        encodeJson(proof.markers[owner].history) !==
          encodeJson(storage.description.histories[owner])
    )
  ) {
    return yield* new ReleaseFailure({
      message: "First-install schema or serving release differs",
    });
  }
  yield* requireClosedAdmission(client);
  return proof;
});

const requireClosedAdmission = Effect.fn(function* (client: HttpClient.HttpClient) {
  const closed = yield* client.execute(HttpClientRequest.get(origin + "/transactions"));
  if (
    closed.status !== recoveryUnavailableStatus ||
    closed.headers["x-fidy-recovery-isolation"] !== "isolated"
  ) {
    return yield* new ReleaseFailure({ message: "Normal admission is not closed" });
  }
});
const verifyFirstInstall = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* releaseController.requireTrunk(port, env.revision);
  yield* verifyNativeEdge(env, client, false);
  const receipts = yield* workersFromState("capture", nativeStack);
  if (
    receipts.core.workerName !== installationNames.Core ||
    receipts.public.workerName !== installationNames.Ingress ||
    !receipts.core.hasRolloutBaseline ||
    !receipts.public.hasRolloutBaseline
  ) {
    return yield* new ReleaseFailure({ message: "First-install resource identity unavailable" });
  }
  const pair = yield* readStablePair(
    {
      port,
      workers: receipts,
      proof: env.smokeProof,
      client,
    },
    origin
  );
  if (pair.identity.stableRevision !== env.revision) {
    return yield* new ReleaseFailure({
      message: "First-installed source differs from protected trunk",
    });
  }
  yield* proveRecoveryCorePrivate(env, client, installationNames.Core);
  const ingress = yield* versionResources(env, client, {
    name: installationNames.Ingress,
    id: pair.publicStable,
    revision: env.revision,
  });
  const core = yield* versionResources(env, client, {
    name: installationNames.Core,
    id: pair.coreStable,
    revision: env.revision,
  });
  const storage = yield* Effect.try(() =>
    verifiedStoragePair({ ingress: ingress.bindings, core: core.bindings })
  );
  yield* verifyInstalledNamespaces({ env, client, storage, workers: [ingress, core] });
  const proof = yield* verifyInstalledMarkers({ env, client, pair, storage });
  yield* writeFile(
    env.smokeAttestationFile,
    encodeJson({
      revision: env.revision,
      publicVersionId: pair.publicStable,
      coreVersionId: pair.coreStable,
      namespaces: storage.namespaces,
      markers: proof.markers,
      admission: "closed",
    })
  );
});

const requireTestedStorage = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  input: {
    ingress: string;
    core: string;
    revision: string;
    ingressName: string;
    coreName: string;
    owners: ReadonlyMap<string, ReturnType<typeof verifiedStoragePair>["description"]>;
  }
) {
  const headers = smokeHeaders({
    config: {
      SMOKE_PROOF: env.smokeProof,
      PUBLIC_WORKER_NAME: input.ingressName,
      CORE_WORKER_NAME: input.coreName,
      CORE_VERSION_ID: input.core,
    },
    publicVersion: Option.some(input.ingress),
  });
  const response = yield* client.execute(
    HttpClientRequest.get(origin + "/internal/release-smoke" + compatibilityQuery, { headers })
  );
  const observation = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ core: SmokeIdentity, markers: SharedStoreMarkers })
  )(yield* response.json);
  if (
    response.status !== successStatusStart ||
    response.headers["x-fidy-smoke-worker-version"] !== input.ingress ||
    observation.core.workerVersionId !== input.core ||
    observation.core.gitRevision !== input.revision ||
    storageOwners.some((owner) => {
      const actual = observation.markers[owner];
      const expected = input.owners.get(actual.workerVersionId);
      return (
        expected === undefined ||
        encodeJson(expected.histories[owner]) !== encodeJson(actual.history)
      );
    })
  ) {
    return yield* new ReleaseFailure({
      message: "Pinned Worker/object storage probe failed; preserve current state",
    });
  }
});
type StorageTransition = Pick<
  typeof RollbackReceipt.Type.release,
  "snapshot" | "publicVersionId" | "coreVersionId"
>;
const deployedStorage = Effect.fn(function* ({
  env,
  client,
  release,
}: {
  env: Config;
  client: HttpClient.HttpClient;
  release: StorageTransition;
}) {
  const read = Effect.fn(function* (snapshot: typeof release.snapshot.core, id: string) {
    return {
      stable: yield* versionResources(env, client, {
        name: snapshot.name,
        id: snapshot.stableVersionId,
        revision: release.snapshot.stableRevision,
      }),
      candidate: yield* versionResources(env, client, {
        name: snapshot.name,
        id,
        revision: release.snapshot.revision,
      }),
    };
  });
  const ingress = yield* read(release.snapshot.public, release.publicVersionId);
  const core = yield* read(release.snapshot.core, release.coreVersionId);
  const descriptions = yield* Effect.try({
    try: () => ({
      serving: verifiedStoragePair({
        ingress: ingress.stable.bindings,
        core: core.stable.bindings,
      }),
      candidate: verifiedStoragePair({
        ingress: ingress.candidate.bindings,
        core: core.candidate.bindings,
      }),
    }),
    catch: () =>
      new ReleaseFailure({ message: "Storage identity or compatibility description unavailable" }),
  });
  return { ingress, core, descriptions };
});
const requireClosedWorkers = Effect.fn(function* (
  workers: ReadonlyArray<ReturnType<typeof verifiedVersionResources>>
) {
  const closed = Schema.is(
    Schema.Struct({ type: Schema.Literal("plain_text"), text: Schema.Literal("isolated") })
  );
  if (workers.some((worker) => !closed(worker.bindings["RECOVERY_ISOLATION"]))) {
    return yield* new ReleaseFailure({
      message: "Closed native rollout refuses an admission change",
    });
  }
});
const storageCompatibility = Effect.fn(function* (
  { env, client }: { env: Config; client: HttpClient.HttpClient },
  release: Pick<
    typeof RollbackReceipt.Type.release,
    "snapshot" | "publicVersionId" | "coreVersionId"
  >,
  phase: "stage" | "promote" | "rollback"
) {
  yield* Effect.try(() => requireNativeTarget(release.snapshot));
  yield* verifyTaxonomyOverlap(release.snapshot);
  const { ingress, core, descriptions } = yield* deployedStorage({ env, client, release });
  yield* requireClosedWorkers([ingress.stable, core.stable, ingress.candidate, core.candidate]);
  const overlap = compatibleStoragePairs(descriptions);
  if (!overlap.forward) {
    return yield* new ReleaseFailure({
      message: "Incompatible store history, namespace or internal protocol",
    });
  }
  const source = yield* rollbackSource(release.snapshot);

  const rollback =
    overlap.rollback && [ingress, core].every((pair) => rollbackCompatible({ ...pair, ...source }));
  if (phase === "promote") {
    const owners = new Map([
      [release.snapshot.core.stableVersionId, descriptions.serving.description],
      [release.coreVersionId, descriptions.candidate.description],
    ]);
    const probe = (
      publicId: string,
      coreId: string,
      revision: string
    ): ReturnType<typeof requireTestedStorage> =>
      requireTestedStorage(env, client, {
        ingress: publicId,
        core: coreId,
        revision,
        ingressName: release.snapshot.public.name,
        coreName: release.snapshot.core.name,
        owners,
      });
    yield* probe(release.publicVersionId, release.coreVersionId, release.snapshot.revision);
    yield* probe(
      release.snapshot.public.stableVersionId,
      release.coreVersionId,
      release.snapshot.revision
    );
    if (rollback) {
      yield* probe(
        release.snapshot.public.stableVersionId,
        release.snapshot.core.stableVersionId,
        release.snapshot.stableRevision
      );
    }
  }
  return { rollback };
});
const nativeWorkerReceipts = Effect.fn(function* (mode: "capture" | "completed") {
  const receipts = yield* workersFromState(mode, nativeStack);
  if (
    receipts.public.workerName !== installationNames.Ingress ||
    receipts.core.workerName !== installationNames.Core ||
    !receipts.public.hasRolloutBaseline ||
    !receipts.core.hasRolloutBaseline
  ) {
    return yield* new ReleaseFailure({
      message: "Native rollout requires both established installation identities",
    });
  }
  return receipts;
});

const requireNativeTarget = (snapshot: typeof releaseSchemas.snapshot.Type): void => {
  if (
    snapshot.public.name !== installationNames.Ingress ||
    snapshot.core.name !== installationNames.Core
  ) {
    throw new ReleaseFailure({ message: "Receipt belongs to another installation" });
  }
};

const captureNative = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const workers = yield* nativeWorkerReceipts("capture");
  const pair = yield* readStablePair(
    {
      port,
      workers,
      client,
      proof: env.smokeProof,
    },
    origin
  );
  const snapshot = yield* releaseController.captureRelease(port, {
    revision: env.revision,
    ...pair.identity,
    publicName: installationNames.Ingress,
    coreName: installationNames.Core,
  });
  if (
    pair.publicStable !== snapshot.public.stableVersionId ||
    pair.coreStable !== snapshot.core.stableVersionId
  ) {
    return yield* new ReleaseFailure({ message: "Native traffic changed during capture" });
  }
  yield* writeFile(env.file, encodeJson(snapshot));
});

const stageNative = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );
  yield* Effect.try(() => requireNativeTarget(snapshot));
  const workers = yield* nativeWorkerReceipts("completed");
  if (Option.isNone(workers.public.versionId) || Option.isNone(workers.core.versionId)) {
    return yield* new ReleaseFailure({ message: "Native Worker upload receipts incomplete" });
  }
  const candidate = {
    publicVersionId: workers.public.versionId.value,
    coreVersionId: workers.core.versionId.value,
  };
  yield* storageCompatibility({ env, client }, { snapshot, ...candidate }, "stage");
  yield* writeFile(
    env.file,
    encodeJson(yield* releaseController.stageRelease(port, snapshot, candidate))
  );
});

/** Promotion is limited to the isolated network surface. Product opening has its own acceptance gates. */
const promoteClosed = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const release = yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(
    yield* readFile(env.file)
  );
  const eligible = yield* storageCompatibility({ env, client }, release, "promote");
  const promoted = yield* releaseController.promoteRelease(port, release, {
    exactPairPassed: true,
    middlePairPassed: true,
    rollbackEligible: eligible.rollback,
  });
  yield* writeFile(
    env.file + ".promoted",
    encodeJson({ release, promoted, rollbackTested: eligible.rollback })
  );
});

const rollbackNative = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const { release, promoted } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ ...RollbackReceipt.fields, rollbackTested: Schema.Literal(true) })
  )(yield* readFile(env.file + ".promoted"));
  yield* releaseController.requireTrunk(port, release.snapshot.revision);
  const eligible = yield* storageCompatibility({ env, client }, release, "rollback");
  yield* releaseRollback.restore(releaseEvidence.rollbackPort(port, env, client), {
    release,
    promoted,
    compatible: eligible.rollback,
  });
  const restored = yield* readStablePair(
    {
      port,
      workers: yield* nativeWorkerReceipts("capture"),
      proof: env.smokeProof,
      client,
    },
    origin
  );
  if (
    restored.publicStable !== release.snapshot.public.stableVersionId ||
    restored.coreStable !== release.snapshot.core.stableVersionId ||
    restored.identity.stableRevision !== release.snapshot.stableRevision
  ) {
    return yield* new ReleaseFailure({
      message: "Restored version identity differs; inspect current traffic",
    });
  }
  yield* requireClosedAdmission(client);
  yield* writeFile(
    env.file + ".restored",
    encodeJson({
      revision: restored.identity.stableRevision,
      publicVersionId: restored.publicStable,
      coreVersionId: restored.coreStable,
      admission: "closed",
    })
  );
});

const commands = {
  "verify-fresh-target": verifyFreshTarget,
  "prepare-closed-edge": prepareClosedEdge,
  "verify-upload": verifyStorageUpload,
  verify: verifyFirstInstall,
  capture: captureNative,
  stage: stageNative,
  promote: promoteClosed,
  rollback: rollbackNative,
};
if (import.meta.main) {
  const program = Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(
      Schema.Literals([
        "verify-fresh-target",
        "prepare-closed-edge",
        "verify-upload",
        "verify",
        "capture",
        "stage",
        "promote",
        "rollback",
      ])
    )(process.argv[2]);
    const env = releaseEvidence.config();
    const services = yield* Layer.build(ReleaseHttpLive);
    const client = Context.get(services, HttpClient.HttpClient);
    yield* commands[command](env, client, releasePort({ env, client }));
  }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }), Effect.scoped);
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          process.stderr.write(releaseFailureMessage(cause) + "\n");
          process.exitCode = 1;
        })
      )
    )
  );
}
