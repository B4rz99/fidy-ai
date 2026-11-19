import type { ErasureObservation } from "./native-erasure";
import { readUserObjects } from "./native-erasure-evidence";
import { verifyNativeSmoke } from "./native-release-smoke";
import { isDeepStrictEqual } from "node:util";
import { verifyIncumbentFence, verifyIncumbentMail } from "./native-incumbent-fence";
import { readProviderList } from "./native-provider-list";
import { verifyInstalledWebsite } from "./native-deployed-web";
import { inspectDeployedEdge } from "./native-deployed-edge";
import { inspectNativeResources, verifyDeployedVersion } from "./native-deployed-graph";
import type { NativeRole } from "./native-graph";
import { exerciseClosedUsers } from "./native-acceptance";
import { installedOrigins } from "@fidy/server/browser-transport";
import { verifyNativeEdge } from "./native-edge";
import {
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Config as ReleaseConfig,
  Schedule,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
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
  configureReleaseObservability,
  releaseEvidence,
  releaseFailureMessage,
  releasePort,
  verifyCoreDefaultPlacement,
  verifyReleaseObservability,
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
  type NativeHostMode,
  installationNames,
  nativeHostPairs,
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
const hostMode = ReleaseConfig.Literals(["acceptance", "staged"], "NATIVE_STORAGE_HOSTS").pipe(
  ReleaseConfig.withDefault("acceptance")
);
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
const accountReader =
  (env: Config, client: HttpClient.HttpClient) =>
  (path: string): Effect.Effect<unknown, Error> =>
    providerJson(
      HttpClientRequest.get(
        `https://api.cloudflare.com/client/v4/accounts/${env.account}/${path}`,
        { headers: { authorization: `Bearer ${env.token}` } }
      )
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
const firstInstallInventory = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  const get = accountReader(env, client);
  const scripts = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      success: Schema.Literal(true),
      result: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
    })
  )(yield* get("workers/scripts"));
  return {
    scripts: scripts.result,
    namespaces: yield* readProviderList(
      get,
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
  if ((yield* hostMode) !== "acceptance") {
    return yield* Effect.fail(Error("First install requires unclaimed acceptance hosts"));
  }
  if (inventory.scripts.some((item) => item.id === "fidy-native-smoke-" + env.revision)) {
    return yield* new ReleaseFailure({ message: "Revision smoke Worker already exists" });
  }
  yield* inspectNativeResources(accountReader(env, client), env.revision, false);
  yield* inspectDeployedEdge(env, client, {
    installed: false,
    bindings: {},
    hosts: "acceptance",
    staging: false,
  });
  yield* Effect.try({
    try: () => requireAbsentInstallation(inventory),
    catch: () =>
      new ReleaseFailure({
        message: "Fresh installation refused: an existing target must be inspected",
      }),
  });
});

export const firstInstallEdge = Effect.fn(function* (mode: "plan" | "install") {
  const env = releaseEvidence.config();
  const client = yield* HttpClient.HttpClient;
  const port = releasePort({ env, client });
  if (
    (yield* ReleaseConfig.String("GITHUB_ACTIONS")) !== "true" ||
    (yield* ReleaseConfig.String("GITHUB_REF")) !== "refs/heads/trunk" ||
    (yield* ReleaseConfig.String("GITHUB_EVENT_NAME")) !== "workflow_dispatch" ||
    (yield* ReleaseConfig.String("NATIVE_STORAGE_ADMISSION")) !== "closed"
  ) {
    return yield* new ReleaseFailure({ message: "Requires the closed protected installation" });
  }
  yield* verifyFreshTarget(env, client, port);
  yield* verifyNativeEdge(env, client, mode);
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
const erasureObservation = (
  env: Config,
  client: HttpClient.HttpClient,
  userNamespace: string
): ErasureObservation => ({
  inventory: () => readUserObjects(accountReader(env, client), userNamespace),
  record: (checkpoint) =>
    writeFile(
      env.smokeAttestationFile + ".erasure",
      encodeJson({ revision: env.revision, userNamespace, ...checkpoint })
    ),
});
const verifySyntheticUsers = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  {
    origins,
    erasureNamespace,
  }: {
    origins: (typeof installedOrigins)[keyof typeof installedOrigins];
    erasureNamespace: Option.Option<string>;
  }
) {
  const send = Effect.fn(function* (request: Request) {
    const reply = yield* client
      .execute(HttpClientRequest.fromWeb(request))
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    const native = HttpClientResponse.toWeb(reply);
    if (Option.isNone(native)) {
      return yield* new ReleaseFailure({
        message: "Closed acceptance requires a native HTTP response",
      });
    }
    return native.value;
  });
  const proof = yield* exerciseClosedUsers({
    revision: env.revision,
    proof: Redacted.make(env.smokeProof),
    origins,
    send,
    erasure: Option.map(erasureNamespace, (id) => erasureObservation(env, client, id)),
  });
  const path = `https://api.cloudflare.com/client/v4/accounts/${env.account}/workflows/fidy-native-billing/instances/${proof.callback.workflow}`;
  const response = providerJson(
    HttpClientRequest.get(path, { headers: { authorization: `Bearer ${env.token}` } })
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          success: Schema.Literal(true),
          result: Schema.Struct({ status: Schema.Literal("complete") }),
        })
      )
    )
  );
  yield* response.pipe(Effect.retry({ times: 20, schedule: Schedule.spaced("500 millis") }));
  return { ...proof, callback: { ...proof.callback, workflowStatus: "complete" } };
});
const verifyDeployedWorkers = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const workers: ReadonlyArray<readonly [NativeRole, string]> = [
    ["Ingress", installationNames.Ingress],
    ["Core", installationNames.Core],
    ["Web", installationNames.Web],
    ["Smoke", "fidy-native-smoke-" + env.revision],
    ["ForwardedEmail", installationNames.ForwardedEmail],
  ];
  const verify = Effect.fn(function* ([role, name]: readonly [NativeRole, string]) {
      const deployment = yield* port.current(name);
      const id = yield* releaseController.servingVersion(deployment);
      const raw = yield* releaseEvidence.readWorkerVersion(env, client, { name, id });
      yield* Effect.try(() => verifyDeployedVersion({ role, revision: env.revision, versionId: id, raw }));
      yield* verifyReleaseObservability(env, name, client);
      if (role === "Core") yield* verifyCoreDefaultPlacement(env, { name, version: id }, client);
      if (role === "Core" || role === "Smoke" || role === "ForwardedEmail") {
        yield* proveRecoveryCorePrivate(env, client, name);
      }
      return { role, name, versionId: id, deploymentId: deployment.id };
    });
  return yield* Effect.forEach(workers, (worker) => verify(worker).pipe(
    Effect.mapError(() => new ReleaseFailure({ message: "Native deployed Worker verification failed for " + worker[0] }))
  ), { concurrency: 3 }
  );
});
const verifyInstalledTopology = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  input: {
    port: ReleasePort;
    bindings: Readonly<Record<string, unknown>>;
    publicStable: string;
    coreStable: string;
    hosts: NativeHostMode;
    staging: boolean;
  }
) {
  const workers = yield* verifyDeployedWorkers(env, client, input.port);
  if (
    workers.find((item) => item.role === "Ingress")?.versionId !== input.publicStable ||
    workers.find((item) => item.role === "Core")?.versionId !== input.coreStable
  ) {
    return yield* new ReleaseFailure({
      message: "Application versions changed during verification",
    });
  }
  const resources = yield* inspectNativeResources(accountReader(env, client), env.revision, true).pipe(
    Effect.mapError(() => new ReleaseFailure({ message: "Native bucket, Queue or Workflow inventory differs" }))
  );
  const edge = yield* inspectDeployedEdge(env, client, {
    installed: true,
    bindings: input.bindings,
    hosts: input.hosts,
    staging: input.staging,
  }).pipe(Effect.mapError(() => new ReleaseFailure({ message: "Native DNS, host or Access inventory differs" })));
  const website = yield* Effect.forEach(
    nativeHostPairs(input.staging ? "acceptance" : input.hosts),
    (pair) => verifyInstalledWebsite(client, env.revision, pair).pipe(Effect.mapError(() => new ReleaseFailure({ message: "Native browser asset, metadata or header verification failed" })))
  );
  return { workers, resources, edge, website };
});
const firstInstallWorkers = Effect.fn(function* () {
  const receipts = yield* workersFromState("capture", nativeStack);
  if (
    receipts.core.workerName !== installationNames.Core ||
    receipts.public.workerName !== installationNames.Ingress ||
    !receipts.core.hasRolloutBaseline ||
    !receipts.public.hasRolloutBaseline
  ) {
    return yield* new ReleaseFailure({ message: "First-install resource identity unavailable" });
  }
  return receipts;
});
const UserNamespace = Schema.Struct({
  type: Schema.Literal("durable_object_namespace"),
  class_name: Schema.Literal("UserStore"),
  namespace_id: Schema.NonEmptyString,
});
const installedRelease = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { port, staging }: { port: ReleasePort; staging: boolean }
) {
  yield* releaseController.requireTrunk(port, env.revision);
  yield* verifyNativeEdge(env, client, "verify");
  const receipts = yield* firstInstallWorkers();
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
  const topology = yield* verifyInstalledTopology(env, client, {
    port,
    bindings: core.bindings,
    hosts: yield* hostMode,
    staging,
    publicStable: pair.publicStable,
    coreStable: pair.coreStable,
  });
  const proof = yield* verifyInstalledMarkers({ env, client, pair, storage });
  return {
    revision: env.revision,
    publicVersionId: pair.publicStable,
    coreVersionId: pair.coreStable,
    namespaces: storage.namespaces,
    userNamespace: (yield* Schema.decodeUnknownEffect(UserNamespace)(core.bindings.USER_STORE))
      .namespace_id,
    markers: proof.markers,
    ...topology,
    protectedRunUrl: yield* ReleaseConfig.String("RELEASE_RUN_URL"),
    admission: "closed",
  };
});
const verifyFirstInstall = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { port, erase }: { port: ReleasePort; erase: boolean }
) {
  const installed = yield* installedRelease(env, client, { port, staging: false });
  const contractDigest = yield* ReleaseConfig.String("CONTRACT_DIGEST"),
    identity = { gitRevision: env.revision, contractDigest };
  const smoke = yield* verifyNativeSmoke({
    api: origin,
    headers: { "x-fidy-smoke-proof": env.smokeProof },
    public: { ...identity, workerVersionId: installed.publicVersionId },
    core: { ...identity, workerVersionId: installed.coreVersionId },
  }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  const synthetic = yield* Effect.forEach(nativeHostPairs(yield* hostMode), (pair) =>
    verifySyntheticUsers(env, client, {
      origins: pair,
      erasureNamespace:
        erase && pair.api === installedOrigins.acceptance.api
          ? Option.some(installed.userNamespace)
          : Option.none(),
    }).pipe(Effect.map((result) => ({ api: pair.api, ...result })))
  );
  if (new Set(synthetic.map((result) => result.callback.workflow)).size !== 1) {
    return yield* Effect.fail(Error("Staged hosts reached different native payment attempts"));
  }
  yield* writeFile(env.smokeAttestationFile, encodeJson({ ...installed, smoke, synthetic }));
});

type VerifyCommand = (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) => ReturnType<typeof verifyFirstInstall>;
const verification =
  (erase: boolean): VerifyCommand =>
  (env, client, port) =>
    verifyFirstInstall(env, client, { port, erase });

const coordinateIdentity = (
  installed: Effect.Success<ReturnType<typeof installedRelease>>
): Readonly<Record<string, unknown>> => ({
  revision: installed.revision,
  namespaces: [...installed.namespaces].sort(),
  markers: installed.markers,
  workers: installed.workers,
  resources: installed.resources,
  access: installed.edge.access.map((row) => ({ id: row.appId, name: row.name })),
  zone: installed.edge.zoneId,
});
const requiredStaging = Effect.fn(function* () {
  if (
    (yield* hostMode) !== "staged" ||
    (yield* ReleaseConfig.String("NATIVE_STORAGE_ADMISSION")) !== "closed" ||
    (yield* ReleaseConfig.String("GITHUB_ACTIONS")) !== "true" ||
    (yield* ReleaseConfig.String("GITHUB_REF")) !== "refs/heads/trunk" ||
    (yield* ReleaseConfig.String("GITHUB_EVENT_NAME")) !== "workflow_dispatch"
  ) {
    return yield* Effect.fail(Error("Requires protected closed host staging"));
  }
});
const inspectHostStage = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* requiredStaging();
  const installed = yield* installedRelease(env, client, { port, staging: true }),
    account = accountReader(env, client);
  const writers = yield* verifyIncumbentFence(account);
  const zonePath = "https://api.cloudflare.com/client/v4/zones/" + installed.edge.zoneId + "/";
  yield* verifyIncumbentMail(account, (path) =>
    providerJson(
      HttpClientRequest.get(zonePath + path, { headers: { authorization: "Bearer " + env.token } })
    ).pipe(Effect.provideService(HttpClient.HttpClient, client))
  );
  return { installed, writers };
});
const captureHostStage = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const { installed, writers } = yield* inspectHostStage(env, client, port);
  yield* writeFile(
    env.file + ".before-hosts",
    encodeJson({
      identity: coordinateIdentity(installed),
      writers,
      protectedRunUrl: installed.protectedRunUrl,
    })
  );
});
const requireSameInstallation = Effect.fn(function* (
  env: Config,
  installed: Effect.Success<ReturnType<typeof installedRelease>>
) {
  const before = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      identity: Schema.Unknown,
      protectedRunUrl: Schema.Literal(installed.protectedRunUrl),
    })
  )(yield* readFile(env.file + ".before-hosts"));
  if (!isDeepStrictEqual(before.identity, coordinateIdentity(installed))) {
    return yield* Effect.fail(Error("Serving application changed during hostname staging"));
  }
});
const attachCanonicalHosts = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  // The application and Access plans are separate. A domain attachment must never upload a new Worker version.
  for (const host of [
    new URL(installedOrigins.production.api).hostname,
    new URL(installedOrigins.production.browser).hostname,
  ]) {
    const { installed } = yield* inspectHostStage(env, client, port);
    yield* requireSameInstallation(env, installed);
    if (installed.edge.access.some((row) => row.paths.length !== 2)) {
      return yield* Effect.fail(Error("Canonical Access policies are incomplete"));
    }
    const target = installed.edge.hosts.find((row) => row.host === host);
    if (target === undefined) return yield* Effect.fail(Error("Canonical hostname unavailable"));
    if (!target.vacant) continue;
    const data = {
      hostname: host,
      service: target.target,
      zone_id: installed.edge.zoneId,
      enabled: true,
      previews_enabled: false,
    };
    yield* providerJson(
      HttpClientRequest.put(
        "https://api.cloudflare.com/client/v4/accounts/" + env.account + "/workers/domains",
        {
          headers: { authorization: "Bearer " + env.token },
          body: HttpBody.text(encodeJson(data), "application/json"),
        }
      )
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            success: Schema.Literal(true),
            result: Schema.Struct({
              hostname: Schema.Literal(host),
              service: Schema.Literal(target.target),
              zone_id: Schema.Literal(installed.edge.zoneId),
              enabled: Schema.Literal(true),
              previews_enabled: Schema.Literal(false),
            }),
          })
        )
      )
    );
  }
  const verified = yield* installedRelease(env, client, { port, staging: false });
  yield* requireSameInstallation(env, verified);
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
const probeReleaseTransport = Effect.fn(function* (
  env: Config,
  versions: {
    public: string;
    core: string;
    publicRevision: string;
    coreRevision: string;
    publicDigest: string;
    coreDigest: string;
  },
  stable: StorageTransition["snapshot"]
) {
  const headers = smokeHeaders({
    config: {
      SMOKE_PROOF: env.smokeProof,
      PUBLIC_WORKER_NAME: stable.public.name,
      CORE_WORKER_NAME: stable.core.name,
      CORE_VERSION_ID: versions.core,
    },
    publicVersion: Option.some(versions.public),
  });
  return yield* verifyNativeSmoke({
    api: origin,
    headers,
    public: {
      workerVersionId: versions.public,
      gitRevision: versions.publicRevision,
      contractDigest: versions.publicDigest,
    },
    core: {
      workerVersionId: versions.core,
      gitRevision: versions.coreRevision,
      contractDigest: versions.coreDigest,
    },
  });
});
type Descriptions = Effect.Success<ReturnType<typeof deployedStorage>>["descriptions"];
type ProbePair = { descriptions: Descriptions; rollback: boolean };
const storageProbeOwners = (
  release: StorageTransition,
  descriptions: Descriptions
): Map<string, ReturnType<typeof verifiedStoragePair>["description"]> =>
  new Map([
    [release.snapshot.core.stableVersionId, descriptions.serving.description],
    [release.coreVersionId, descriptions.candidate.description],
  ]);
const probePromotionPairs = Effect.fn(function* (
  { env, client }: { env: Config; client: HttpClient.HttpClient },
  release: StorageTransition,
  { descriptions, rollback }: ProbePair
) {
  const owners = storageProbeOwners(release, descriptions);
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
  const candidateDigest = yield* ReleaseConfig.String("CONTRACT_DIGEST");
  const verifiedPair = Effect.fn(function* (
    publicVersion: string,
    coreVersion: string,
    coreRevision: string
  ) {
    yield* probe(publicVersion, coreVersion, coreRevision);
    const stable = release.snapshot;
    const priorPublic = publicVersion === stable.public.stableVersionId,
      priorCore = coreVersion === stable.core.stableVersionId;
    yield* probeReleaseTransport(
      env,
      {
        public: publicVersion,
        core: coreVersion,
        publicRevision: priorPublic ? stable.stableRevision : stable.revision,
        coreRevision,
        publicDigest: priorPublic ? stable.stableContractDigest : candidateDigest,
        coreDigest: priorCore ? stable.stableContractDigest : candidateDigest,
      },
      stable
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
  });
  yield* verifiedPair(release.publicVersionId, release.coreVersionId, release.snapshot.revision);
  yield* verifiedPair(
    release.snapshot.public.stableVersionId,
    release.coreVersionId,
    release.snapshot.revision
  );
  if (rollback) {
    yield* verifiedPair(
      release.snapshot.public.stableVersionId,
      release.snapshot.core.stableVersionId,
      release.snapshot.stableRevision
    );
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
    yield* probePromotionPairs({ env, client }, release, { descriptions, rollback });
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

const prepareDiagnostics = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* releaseController.requireTrunk(port, env.revision);
  if (
    (yield* ReleaseConfig.String("NATIVE_STORAGE_ADMISSION")) !== "closed" ||
    (yield* ReleaseConfig.String("GITHUB_EVENT_NAME")) !== "workflow_dispatch"
  ) {
    return yield* Effect.fail(Error("Protected closed dispatch required"));
  }
  yield* nativeWorkerReceipts("completed");
  yield* configureReleaseObservability(
    env,
    [...Object.values(installationNames), "fidy-native-smoke-" + env.revision],
    client
  );
});
const commands = {
  "capture-hosts": captureHostStage,
  "attach-hosts": attachCanonicalHosts,
  "prepare-diagnostics": prepareDiagnostics,
  "verify-fresh-target": verifyFreshTarget,
  "verify-upload": verifyStorageUpload,
  verify: verification(false),
  "verify-erasure": verification(true),
  capture: captureNative,
  stage: stageNative,
  promote: promoteClosed,
  rollback: rollbackNative,
};
if (import.meta.main) {
  const program = Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(
      Schema.Literals([
        "capture-hosts",
        "attach-hosts",
        "prepare-diagnostics",
        "verify-fresh-target",
        "verify-upload",
        "verify",
        "verify-erasure",
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
