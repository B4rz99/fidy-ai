import { resourceFailureMessage } from "./resource-failure";
import {
  FallbackStage,
  archivedDormant,
  fromArchivedStage,
  matchesArchivedStage,
  recoverFixtureFallback,
  requireDormantReplacementSource,
  requirePromotedDormantSource,
  verifyUnpromotedFallback,
} from "./native-fallback-recovery";
import {
  controlsDigest,
  fallbackNamespaces,
  observeDormantPair,
  observePairingStart,
  requireOriginalFallbackSource,
} from "./native-fallback-probe";
import { requireInterruptedUpload } from "./native-upload-recovery";
import fixtureUpload from "./native-fixture-upload.json" with { type: "json" };
import retainedProvider from "./native-retained-provider.json" with { type: "json" };
import { expectedFixtureSigner, fixtureBuild, resourceRevision } from "./native-fixture-signer";
import { BunFileSystem } from "@effect/platform-bun";
import type { ErasureProgress } from "./native-erasure-continuation";
import type { ErasureObservation } from "./native-erasure";
import { verificationRevision } from "./installed-verification-revision";
import { readUserObjects } from "./native-erasure-evidence";
import { verifyNativeSmoke } from "./native-release-smoke";
import { isDeepStrictEqual } from "node:util";
import { verifyIncumbentFence, verifyIncumbentMail } from "./native-incumbent-fence";
import { readProviderList } from "./native-provider-list";
import { verifyInstalledWebsite } from "./native-deployed-web";
import { inspectDeployedEdge, requireClosedIngressDomains } from "./native-deployed-edge";
import { inspectNativeResources, verifyDeployedVersion } from "./native-deployed-graph";
import type { NativeRole } from "./native-graph";
import { continueAdmittedErasure } from "./native-erasure-continuation";
import { executeTen, prepareTen } from "./native-ten-release";
import { continueFleetCleanup, runFleetPilot } from "./native-fleet-pilot";
import { admittedErasureLogins, exerciseClosedUsers, fleetBrowser } from "./native-acceptance";
import { installedOrigins } from "@fidy/server/browser-transport";
import { verifyNativeEdge } from "./native-edge";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
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
  fixtureVerifier,
  releaseCommand,
  releaseEvidence,
  releaseFailureMessage,
  releasePort,
  verifyCoreDefaultPlacement,
  verifyReleaseObservability,
} from "./production-release";
import {
  type Deployment,
  type ReleasePort,
  releaseController,
  releaseSchemas,
} from "./release-controller";
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

const verifyRetainedProvider = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const name = "fidy-native-smoke-" + retainedProvider.revision;
  const current = yield* port.current(name);
  const version = yield* releaseController.servingVersion(current);
  if (
    current.id !== retainedProvider.deploymentId ||
    version !== retainedProvider.versionId ||
    current.versions.length !== 1
  ) {
    return yield* new ReleaseFailure({
      message: "Original acceptance provider deployment changed",
    });
  }
  const raw = yield* releaseEvidence.readWorkerVersion(env, client, { name, id: version });
  yield* Effect.try(() =>
    verifyDeployedVersion({
      account: env.account,
      role: "Smoke",
      revision: retainedProvider.revision,
      versionId: version,
      raw,
      fingerprint: "",
    })
  );
  yield* proveRecoveryCorePrivate(env, client, name);
  yield* verifyReleaseObservability(env, name, client);
  return retainedProvider;
});

const requireCapturedSupport = Effect.fn(function* (
  port: ReleasePort,
  smoke = fixtureUpload.support.Smoke
) {
  for (const role of ["Smoke", "Web", "ForwardedEmail"] as const) {
    const name =
      role === "Smoke" ? "fidy-native-smoke-" + fixtureUpload.revision : installationNames[role];
    const active = yield* port.current(name);
    const expected = role === "Smoke" ? smoke : fixtureUpload.support[role];
    if (
      active.id !== expected.deploymentId ||
      active.versions.length !== 1 ||
      (yield* releaseController.servingVersion(active)) !== expected.versionId
    ) {
      return yield* new ReleaseFailure({ message: "Interrupted native auxiliary Worker changed" });
    }
  }
});
const verifyInterruptedUpload = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { port, snapshot }: { port: ReleasePort; snapshot: typeof releaseSchemas.snapshot.Type }
) {
  const archived = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file + ".source")
  );
  yield* Schema.decodeUnknownEffect(
    Schema.Struct({ digest: Schema.Literal(fixtureUpload.controlsDigest) })
  )(yield* readFile(env.file + ".source.controls"));
  if (
    snapshot.revision === fixtureUpload.revision ||
    !isDeepStrictEqual(archived, { ...snapshot, revision: fixtureUpload.revision })
  ) {
    return yield* new ReleaseFailure({
      message: "Interrupted native release differs from its protected source",
    });
  }
  const saved = yield* nativeWorkerReceipts("completed");
  if (
    !Option.contains(saved.public.versionId, fixtureUpload.ingressVersion) ||
    !Option.contains(saved.core.versionId, fixtureUpload.coreVersion)
  ) {
    return yield* new ReleaseFailure({ message: "Interrupted Alchemy upload receipts changed" });
  }
  const read = (name: string, id: string): Effect.Effect<unknown, Error> =>
    releaseEvidence.readWorkerVersion(env, client, { name, id });
  const versions = yield* Effect.all({
    core: read(installationNames.Core, fixtureUpload.coreVersion),
    ingress: read(installationNames.Ingress, fixtureUpload.ingressVersion),
  });
  yield* Effect.try({
    try: () => requireInterruptedUpload(versions),
    catch: () => new ReleaseFailure({ message: "Interrupted Worker upload metadata differs" }),
  });
  yield* requireCapturedSupport(port);
  yield* inspectNativeResources(accountReader(env, client), fixtureUpload.revision, true);
});

const readReplacementPredecessor = Effect.fn(function* (
  env: Config,
  snapshot: typeof releaseSchemas.snapshot.Type
) {
  const prior = yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(
    yield* readFile(env.file + ".predecessor")
  );
  if (
    !matchesArchivedStage(prior) ||
    !fromArchivedStage(snapshot) ||
    snapshot.stableRevision !== prior.snapshot.stableRevision ||
    snapshot.stableContractDigest !== prior.snapshot.stableContractDigest
  ) {
    return yield* new ReleaseFailure({
      message: "Replacement source differs from the protected stage",
    });
  }
  yield* Effect.try(() => requireOriginalFallbackSource(prior.snapshot));
  return prior;
});
const verifyReplacementSource = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  snapshot: typeof releaseSchemas.snapshot.Type
) {
  const prior = yield* readReplacementPredecessor(env, snapshot);
  const port = releasePort({ env, client });
  yield* requireDormantReplacementSource(port, snapshot);
  yield* requireCapturedSupport(port, archivedDormant.smoke);
  const saved = yield* nativeWorkerReceipts("completed");
  if (
    !Option.contains(saved.core.versionId, prior.coreVersionId) ||
    !Option.contains(saved.public.versionId, prior.publicVersionId)
  ) {
    return yield* new ReleaseFailure({
      message: "Replacement does not own the staged Worker versions",
    });
  }
  yield* confirmFallbackVersions(env, client, prior);
  yield* inspectNativeResources(accountReader(env, client), fixtureUpload.revision, true);
});
const replacingPair = (operation: string): boolean =>
  ["stage-pairing-repair", "plan-pairing-repair"].includes(operation);
const recordSourceControls = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  input: {
    pair: Parameters<typeof controlsDigest>[0];
    replacing: boolean;
  }
) {
  const { pair, replacing } = input;
  const digest = yield* controlsDigest(
    pair,
    replacing ? bufferedAcceptanceSend(client) : acceptanceSend(client)
  );
  if (digest !== fixtureUpload.controlsDigest) {
    return yield* new ReleaseFailure({ message: "Original financial control identities changed" });
  }
  yield* writeFile(env.file + ".controls", encodeJson({ digest }));
});
const preflightSignedSource = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { port, snapshot }: { port: ReleasePort; snapshot: typeof releaseSchemas.snapshot.Type }
) {
  yield* verifyRetainedProvider(env, client, port);
  yield* requireClosedAdmission(client);
  const pair = {
    revision: snapshot.stableRevision,
    ingress: snapshot.public.stableVersionId,
    core: snapshot.core.stableVersionId,
    proof: env.smokeProof,
  };
  yield* requireClosedIngressDomains(accountReader(env, client));
  const operation = yield* ReleaseConfig.String("FIXTURE_RELEASE_OPERATION");
  if ((yield* expectedFixtureSigner) !== fixtureUpload.fingerprint) {
    return yield* new ReleaseFailure({
      message: "Closed fixture signer differs from its protected upload",
    });
  }
  const replacing = replacingPair(operation);
  if (replacing) {
    yield* verifyReplacementSource(env, client, snapshot);
  } else if ((yield* fixtureBuild) === "fallback") {
    yield* Effect.try(() => requireOriginalFallbackSource(snapshot));
    if (operation !== "plan-fixture-repair" && operation !== "resume-fixture-upload") {
      return yield* new ReleaseFailure({ message: "Dormant repair requires the archived upload" });
    }
    yield* verifyInterruptedUpload(env, client, { port, snapshot });
    if (operation === "plan-fixture-repair") return;
  } else {
    if (snapshot.stableRevision !== env.revision) {
      return yield* Effect.fail(
        Error("Active receipt requires the dormant build of this exact revision")
      );
    }
    yield* requirePromotedDormantSource(releasePort({ env, client }), snapshot);
    yield* observeDormantPair(client, pair, true);
  }
  yield* recordSourceControls(env, client, { pair, replacing });
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
  if ((yield* expectedFixtureSigner) !== "") {
    yield* preflightSignedSource(env, client, { port, snapshot });
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
  const overlap = storageOverlap({ stable: stored.description, candidate });
  const signed = (yield* expectedFixtureSigner) !== "";
  if (!overlap.forward || (signed && !overlap.rollback)) {
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
const erasureObservation = ({
  env,
  client,
  userNamespace,
  fs,
}: {
  env: Config;
  client: HttpClient.HttpClient;
  userNamespace: string;
  fs: FileSystem.FileSystem;
}): ErasureObservation => {
  // The final report retains each phase even when the last census fails or is interrupted.
  const checkpoints: Array<Parameters<ErasureObservation["record"]>[0]> = [];
  const path = env.smokeAttestationFile + ".erasure";
  return {
    inventory: () => readUserObjects(accountReader(env, client), userNamespace),
    record: (checkpoint) =>
      Effect.gen(function* () {
        checkpoints.push(checkpoint);
        yield* fs.writeFileString(
          path + ".next",
          encodeJson({ revision: env.revision, userNamespace, ...checkpoint, checkpoints })
        );
        yield* fs.rename(path + ".next", path);
        const progress =
          "listed" in checkpoint
            ? ` (observation ${checkpoint.observations}, listed ${checkpoint.listed}, populated ${checkpoint.populated})`
            : "";
        yield* Effect.logInfo("Physical User census " + checkpoint.stage + progress);
      }),
  };
};
const sendClosedRequest = (
  client: HttpClient.HttpClient,
  body: "bytes" | "stream"
): Parameters<typeof admittedErasureLogins>[0]["send"] =>
  Effect.fn(function* (request: Request) {
    // FromWeb drops Content-Type on an empty body. The Ingress proof binds the explicit headers.
    const outbound = HttpClientRequest.setHeaders(
      HttpClientRequest.fromWeb(request),
      request.headers
    );
    const wire =
      body === "bytes" && request.body !== null
        ? HttpClientRequest.bodyUint8Array(
            outbound,
            new Uint8Array(yield* Effect.tryPromise(() => request.arrayBuffer())),
            request.headers.get("content-type") ?? undefined
          )
        : outbound;
    const reply = yield* client
      .execute(wire)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    const native = HttpClientResponse.toWeb(reply);
    if (Option.isNone(native)) {
      return yield* new ReleaseFailure({
        message: "Closed acceptance requires a native HTTP response",
      });
    }
    return native.value;
  });
export const acceptanceSend = (
  client: HttpClient.HttpClient
): ReturnType<typeof sendClosedRequest> => sendClosedRequest(client, "stream");
export const bufferedAcceptanceSend = (
  client: HttpClient.HttpClient
): ReturnType<typeof sendClosedRequest> => sendClosedRequest(client, "bytes");
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
  const fs = yield* FileSystem.FileSystem;
  const proof = yield* exerciseClosedUsers({
    revision: env.revision,
    proof: Redacted.make(env.smokeProof),
    origins,
    send: acceptanceSend(client),
    erasure: Option.map(erasureNamespace, (id) =>
      erasureObservation({ env, client, userNamespace: id, fs })
    ),
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
const verifySupportIdentity = Effect.fn(function* (
  role: NativeRole,
  deployment: Deployment,
  id: string
) {
  if (role === "Core" || role === "Ingress") return;
  if (deployment.versions.length !== 1) {
    return yield* Effect.fail(Error("Ambiguous auxiliary deployment"));
  }
  const expected = fixtureUpload.support[role];
  const rightVersion =
    role === "Smoke"
      ? deployment.id !== expected.deploymentId && id !== expected.versionId
      : deployment.id === expected.deploymentId && id === expected.versionId;
  if (!rightVersion) return yield* Effect.fail(Error("Unexpected auxiliary Worker release"));
});
const verifyDeployedWorkers = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { port, roles }: { port: ReleasePort; roles: "all" | "support" }
) {
  const fingerprint = yield* expectedFixtureSigner;
  const generation = resourceRevision({ revision: env.revision, signed: fingerprint !== "" });
  const workers: ReadonlyArray<readonly [NativeRole, string]> = [
    ["Ingress", installationNames.Ingress],
    ["Core", installationNames.Core],
    ["Web", installationNames.Web],
    ["Smoke", "fidy-native-smoke-" + generation],
    ["ForwardedEmail", installationNames.ForwardedEmail],
  ];
  const verify = Effect.fn(function* ([role, name]: readonly [NativeRole, string]) {
    const deployment = yield* port.current(name);
    const id = yield* releaseController.servingVersion(deployment);
    const auxiliary = role === "Web" || role === "ForwardedEmail";
    if (fingerprint !== "") yield* verifySupportIdentity(role, deployment, id);
    const raw = yield* releaseEvidence.readWorkerVersion(env, client, { name, id });
    yield* Effect.try(() =>
      verifyDeployedVersion({
        role,
        account: env.account,
        revision: auxiliary ? generation : env.revision,
        versionId: id,
        raw,
        fingerprint,
      })
    );
    yield* verifyReleaseObservability(env, name, client);
    if (role === "Core") yield* verifyCoreDefaultPlacement(env, { name, version: id }, client);
    if (role === "Core" || role === "Smoke" || role === "ForwardedEmail") {
      yield* proveRecoveryCorePrivate(env, client, name);
    }
    return { role, name, versionId: id, deploymentId: deployment.id };
  });
  return yield* Effect.forEach(
    workers.filter(([role]) => roles === "all" || (role !== "Core" && role !== "Ingress")),
    (worker) =>
      verify(worker).pipe(
        Effect.mapError(
          () =>
            new ReleaseFailure({
              message: "Native deployed Worker verification failed for " + worker[0],
            })
        )
      ),
    { concurrency: 3 }
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
  const signed = (yield* expectedFixtureSigner) !== "";
  const generation = resourceRevision({ revision: env.revision, signed });
  const workers = yield* verifyDeployedWorkers(env, client, { port: input.port, roles: "all" });
  if (
    workers.find((item) => item.role === "Ingress")?.versionId !== input.publicStable ||
    workers.find((item) => item.role === "Core")?.versionId !== input.coreStable
  ) {
    return yield* new ReleaseFailure({
      message: "Application versions changed during verification",
    });
  }
  const resources = yield* inspectNativeResources(
    accountReader(env, client),
    generation,
    true
  ).pipe(
    Effect.mapError(
      () => new ReleaseFailure({ message: "Native bucket, Queue or Workflow inventory differs" })
    )
  );
  const edge = yield* inspectDeployedEdge(env, client, {
    installed: true,
    bindings: input.bindings,
    hosts: input.hosts,
    staging: input.staging,
  }).pipe(
    Effect.mapError(
      () => new ReleaseFailure({ message: "Native DNS, host or Access inventory differs" })
    )
  );
  const website = yield* Effect.forEach(
    nativeHostPairs(input.staging ? "acceptance" : input.hosts),
    (pair) =>
      verifyInstalledWebsite(client, generation, pair).pipe(
        Effect.mapError(
          () =>
            new ReleaseFailure({
              message: "Native browser asset, metadata or header verification failed",
            })
        )
      )
  );
  const verification = { workers, resources, edge, website };
  if (!signed) return verification;
  const retained = yield* verifyRetainedProvider(env, client, input.port);
  return { ...verification, resourceRevision: generation, retainedProvider: retained };
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
const readInstalledIdentity = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
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
      message: "Installed source differs from expected release revision",
    });
  }
  return pair;
});
const installedRelease = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  {
    port,
    staging,
    verifierRevision,
  }: { port: ReleasePort; staging: boolean; verifierRevision: string }
) {
  yield* releaseController.requireTrunk(port, verifierRevision);
  yield* verifyNativeEdge(env, client, "verify");
  const pair = yield* readInstalledIdentity(env, client, port);
  yield* Effect.logInfo("Verified the closed edge and installed Ingress and Core identities.");
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
  yield* Effect.logInfo("Verified private Core and the five installed SQLite namespaces.");
  const topology = yield* verifyInstalledTopology(env, client, {
    port,
    bindings: core.bindings,
    hosts: yield* hostMode,
    staging,
    publicStable: pair.publicStable,
    coreStable: pair.coreStable,
  });
  yield* Effect.logInfo(
    "Verified installed Workers, data resources, Access and browser artifacts."
  );
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
const evidenceDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const artifactNumber = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/u));
const ErasureSource = Schema.Struct({
  runId: artifactNumber,
  artifactId: artifactNumber,
  sourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  archiveSha256: evidenceDigest,
  checkpointSha256: evidenceDigest,
  baselineSha256: evidenceDigest,
  survivorsSha256: evidenceDigest,
});
const verifyAdmittedErasure = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  {
    installed,
    verifierRevision,
  }: { installed: Effect.Success<ReturnType<typeof installedRelease>>; verifierRevision: string }
) {
  const source = yield* Schema.decodeUnknownEffect(ErasureSource)(
    yield* readFile(yield* ReleaseConfig.String("ERASURE_SOURCE_EVIDENCE"))
  );
  const fs = yield* FileSystem.FileSystem;
  const path = env.smokeAttestationFile + ".erasure";
  const stages: Array<Parameters<ErasureProgress>[0]> = [];
  const record: ErasureProgress = Effect.fn(function* (stage) {
    stages.push(stage);
    yield* fs.writeFileString(
      path + ".next",
      encodeJson({
        source,
        revision: env.revision,
        verifierRevision,
        userNamespace: installed.userNamespace,
        stages,
      })
    );
    yield* fs.rename(path + ".next", path);
    yield* Effect.logInfo("Erasure continuation verified " + stage);
  });
  const erasure = yield* continueAdmittedErasure({
    record,
    checkpoint: yield* readFile(env.smokeAttestationFile + ".prior"),
    revision: env.revision,
    userNamespace: installed.userNamespace,
    baseline: source.baselineSha256,
    survivors: source.survivorsSha256,
    inventory: () => readUserObjects(accountReader(env, client), installed.userNamespace),
    ...admittedErasureLogins({
      revision: env.revision,
      proof: Redacted.make(env.smokeProof),
      origins: installedOrigins.acceptance,
      send: acceptanceSend(client),
    }),
  });
  yield* writeFile(
    env.smokeAttestationFile,
    encodeJson({
      ...installed,
      verifierRevision,
      continuation: { source, ...erasure },
    })
  );
});
const installedConfig = Effect.fn(function* (verifier: Config) {
  const requested = yield* ReleaseConfig.String("EXPECTED_INSTALLED_REVISION").pipe(
    ReleaseConfig.withDefault("")
  );
  const revision = yield* verificationRevision(verifier.revision, requested, (args) =>
    releaseCommand({ args: ["git", "-C", "../..", ...args], lifetime: "read-only" })
  ).pipe(
    Effect.mapError(
      () =>
        new ReleaseFailure({
          message: "Installed revision must be the same protected runtime source",
        })
    )
  );
  return { ...verifier, revision };
});
const originalControlEvidence = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  versions: { core: string; ingress: string }
) {
  const { digest } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ digest: SmokeIdentity.fields.contractDigest })
  )(yield* readFile(env.file + ".controls"));
  const observed = yield* controlsDigest(
    { revision: env.revision, ...versions, proof: env.smokeProof },
    acceptanceSend(client)
  );
  if (observed !== digest) {
    return yield* new ReleaseFailure({ message: "Original financial control identities changed" });
  }
  return { fixtureControlsDigest: digest };
});
const activeControlEvidence = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  installed: Effect.Success<ReturnType<typeof installedRelease>>
) {
  const operation = yield* ReleaseConfig.String("FIXTURE_RELEASE_OPERATION").pipe(
    ReleaseConfig.withDefault("")
  );
  if ((yield* expectedFixtureSigner) === "" || operation !== "rollout") return {};
  return yield* originalControlEvidence(env, client, {
    ingress: installed.publicVersionId,
    core: installed.coreVersionId,
  });
});
const verifyFirstInstall = Effect.fn(function* (
  verifier: Config,
  client: HttpClient.HttpClient,
  {
    port,
    operation,
  }: { port: ReleasePort; operation: "verify" | "verify-erasure" | "continue-erasure" }
) {
  const env = yield* installedConfig(verifier);
  const installed = yield* installedRelease(env, client, {
    port,
    staging: false,
    verifierRevision: verifier.revision,
  });
  yield* Effect.logInfo("Verified schema markers and closed admission.");
  if (operation === "continue-erasure") {
    return yield* verifyAdmittedErasure(env, client, {
      installed,
      verifierRevision: verifier.revision,
    });
  }
  const contractDigest = yield* ReleaseConfig.String("CONTRACT_DIGEST"),
    identity = { gitRevision: env.revision, contractDigest };
  const smoke = yield* verifyNativeSmoke({
    api: origin,
    headers: { "x-fidy-smoke-proof": env.smokeProof },
    public: { ...identity, workerVersionId: installed.publicVersionId },
    core: { ...identity, workerVersionId: installed.coreVersionId },
  }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  yield* Effect.logInfo("Verified release smoke against the installed Worker versions.");
  const synthetic = yield* Effect.forEach(nativeHostPairs(yield* hostMode), (pair) =>
    verifySyntheticUsers(env, client, {
      origins: pair,
      erasureNamespace:
        operation === "verify-erasure" && pair.api === installedOrigins.acceptance.api
          ? Option.some(installed.userNamespace)
          : Option.none(),
    }).pipe(Effect.map((result) => ({ api: pair.api, ...result })))
  );
  if (new Set(synthetic.map((result) => result.callback.workflow)).size !== 1) {
    return yield* Effect.fail(Error("Staged hosts reached different native payment attempts"));
  }
  yield* writeFile(
    env.smokeAttestationFile,
    encodeJson({
      ...installed,
      verifierRevision: Option.getOrElse(yield* fixtureVerifier, () => verifier.revision),
      smoke,
      synthetic,
      ...(yield* activeControlEvidence(env, client, installed)),
    })
  );
});

type VerifyCommand = (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) => ReturnType<typeof verifyFirstInstall>;
const verification =
  (operation: "verify" | "verify-erasure" | "continue-erasure"): VerifyCommand =>
  (env, client, port) =>
    verifyFirstInstall(env, client, { port, operation });

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
  const installed = yield* installedRelease(env, client, {
      port,
      staging: true,
      verifierRevision: env.revision,
    }),
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
  const verified = yield* installedRelease(env, client, {
    port,
    staging: false,
    verifierRevision: env.revision,
  });
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
type SealCheck =
  | "archive"
  | "storage versions"
  | "support Workers"
  | "candidate storage"
  | "candidate async smoke"
  | "mixed storage"
  | "mixed async smoke"
  | "original storage"
  | "original async smoke"
  | "provider"
  | "closed admission"
  | "compatibility"
  | "namespace identities"
  | "candidate Worker metadata"
  | "private Core"
  | "resource inventory"
  | "edge and Build triggers"
  | "version markers"
  | "retained financial controls";
const sealCheck =
  (step: SealCheck) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    operation.pipe(
      Effect.tapCause((cause) =>
        Effect.logError(
          "Dormant verification refused at " + step + ". " + resourceFailureMessage(cause)
        )
      )
    );
const pairChecks = {
  original: { storage: "original storage", smoke: "original async smoke" },
  mixed: { storage: "mixed storage", smoke: "mixed async smoke" },
  candidate: { storage: "candidate storage", smoke: "candidate async smoke" },
} as const;
const pairRole = (original: boolean, mixed: boolean): keyof typeof pairChecks => {
  if (original) return "original";
  return mixed ? "mixed" : "candidate";
};
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
    const stable = release.snapshot;
    const priorPublic = publicVersion === stable.public.stableVersionId,
      priorCore = coreVersion === stable.core.stableVersionId;
    const check = pairChecks[pairRole(priorCore, priorPublic)];
    yield* probe(publicVersion, coreVersion, coreRevision).pipe(sealCheck(check.storage));
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
    ).pipe(Effect.provideService(HttpClient.HttpClient, client), sealCheck(check.smoke));
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
  if (
    (yield* expectedFixtureSigner) !== "" &&
    [ingress, core].some(
      ({ stable, candidate }) => !isDeepStrictEqual(stable.exports, candidate.exports)
    )
  ) {
    return yield* new ReleaseFailure({ message: "Closed fixture Worker export inventory differs" });
  }
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
const confirmFallbackVersions = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  release: FallbackStage["release"]
) {
  const fingerprint = yield* expectedFixtureSigner;
  for (const [role, worker, id] of [
    ["Core", installationNames.Core, release.coreVersionId],
    ["Ingress", installationNames.Ingress, release.publicVersionId],
  ] as const) {
    const raw = yield* releaseEvidence.readWorkerVersion(env, client, { name: worker, id });
    yield* Effect.try(() =>
      verifyDeployedVersion({
        role,
        raw,
        versionId: id,
        revision: release.snapshot.revision,
        account: env.account,
        fingerprint,
      })
    );
  }
});
const repairedSmoke = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const support = yield* verifyDeployedWorkers(env, client, { port, roles: "support" });
  const smoke = support.find(({ role }) => role === "Smoke");
  if (smoke === undefined) return yield* Effect.fail(Error("Missing repaired smoke executor"));
  const coordinates = { deploymentId: smoke.deploymentId, versionId: smoke.versionId };
  if (
    Option.isSome(yield* fixtureVerifier) &&
    !isDeepStrictEqual(coordinates, archivedDormant.smoke)
  ) {
    return yield* new ReleaseFailure({
      message: "Repaired Smoke differs from its authenticated staged deployment",
    });
  }
  return coordinates;
});
const checkStagedNamespaces = Effect.fn(function* (
  input: Effect.Success<ReturnType<typeof deployedStorage>> & {
    env: Config;
    client: HttpClient.HttpClient;
    stage: FallbackStage;
  }
) {
  const { env, client, stage, core, ingress, descriptions } = input;
  const observed = fallbackNamespaces(descriptions.candidate.namespaces);
  if (!isDeepStrictEqual(stage.namespaces, observed)) {
    return yield* Effect.fail(Error("Dormant namespace identities changed"));
  }
  yield* verifyInstalledNamespaces({
    env,
    client,
    storage: descriptions.candidate,
    workers: [core.candidate, ingress.candidate],
  });
});
const checkedFixtureStage = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  stage: FallbackStage
) {
  if (fromArchivedStage(stage.release.snapshot)) {
    yield* readReplacementPredecessor(env, stage.release.snapshot);
  } else yield* Effect.try(() => requireOriginalFallbackSource(stage.release.snapshot));
  const port = releasePort({ env, client });
  const provider = yield* verifyRetainedProvider(env, client, port).pipe(sealCheck("provider"));
  const edge = yield* hostMode;
  if (
    env.revision !== stage.revision ||
    edge !== "acceptance" ||
    !isDeepStrictEqual(stage.provider, provider) ||
    !isDeepStrictEqual(
      stage.smoke,
      yield* repairedSmoke(env, client, port).pipe(sealCheck("support Workers"))
    ) ||
    (yield* expectedFixtureSigner) === "" ||
    (yield* fixtureBuild) !== "fallback"
  ) {
    return yield* Effect.fail(Error("Closed dormant stage differs from the protected release"));
  }
  yield* releaseController.requireTrunk(port, env.revision);
  yield* requireClosedAdmission(client).pipe(sealCheck("closed admission"));
  yield* storageCompatibility({ env, client }, stage.release, "stage").pipe(
    sealCheck("compatibility")
  );
  const { core, ingress, descriptions } = yield* deployedStorage({
    env,
    client,
    release: stage.release,
  });
  yield* checkStagedNamespaces({ env, client, stage, core, ingress, descriptions }).pipe(
    sealCheck("namespace identities")
  );
  yield* confirmFallbackVersions(env, client, stage.release).pipe(
    sealCheck("candidate Worker metadata")
  );
  yield* proveRecoveryCorePrivate(env, client, installationNames.Core).pipe(
    sealCheck("private Core")
  );
  yield* inspectNativeResources(accountReader(env, client), fixtureUpload.revision, true).pipe(
    sealCheck("resource inventory")
  );
  yield* inspectDeployedEdge(env, client, {
    installed: true,
    bindings: core.candidate.bindings,
    hosts: edge,
    staging: false,
  }).pipe(sealCheck("edge and Build triggers"));
  return {
    revision: env.revision,
    ingress: stage.release.publicVersionId,
    core: stage.release.coreVersionId,
    proof: env.smokeProof,
  };
});
const verifyDormantPhase = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { stage, phase }: { stage: FallbackStage; phase: "before" | "after" }
) {
  const pair = yield* checkedFixtureStage(env, client, stage);
  const probe = observeDormantPair(client, pair, phase === "after").pipe(
    sealCheck("version markers")
  );
  yield* phase === "after"
    ? probe.pipe(Effect.retry({ times: 12, schedule: Schedule.spaced("25 seconds") }))
    : probe;
  if (
    (yield* controlsDigest(pair, acceptanceSend(client)).pipe(
      sealCheck("retained financial controls")
    )) !== stage.controlsDigest
  ) {
    return yield* new ReleaseFailure({ message: "Original financial control identities changed" });
  }
});
const stagePath = ReleaseConfig.String("RUNNER_TEMP").pipe(
  Effect.map((directory) => directory + "/native-fallback-stage.json")
);
const readFallbackStage = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  release: FallbackStage["release"]
) {
  const { descriptions } = yield* deployedStorage({ env, client, release }).pipe(
    sealCheck("storage versions")
  );
  const controls = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ digest: Schema.Literal(fixtureUpload.controlsDigest) })
  )(yield* readFile(env.file + ".controls")).pipe(sealCheck("archive"));
  const stage = yield* Schema.decodeEffect(FallbackStage)({
    revision: env.revision,
    stableRevision: release.snapshot.stableRevision,
    release,
    provider: retainedProvider,
    smoke: yield* repairedSmoke(env, client, releasePort({ env, client })).pipe(
      sealCheck("support Workers")
    ),
    namespaces: fallbackNamespaces(descriptions.serving.namespaces),
    controlsDigest: controls.digest,
  });
  return stage;
});
const qualifyFallback = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  release: FallbackStage["release"]
) {
  const verify = Effect.gen(function* () {
    const stage = yield* readFallbackStage(env, client, release);
    yield* verifyDormantPhase(env, client, { stage, phase: "before" });
    yield* storageCompatibility({ env, client }, release, "promote");
    return stage;
  });
  const stage = yield* verifyUnpromotedFallback({
    port: releasePort({ env, client }),
    release,
    verify,
  });
  yield* writeFile(yield* stagePath, encodeJson(stage));
});
const sealFallback = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  const release = yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(
    yield* readFile(env.file)
  );
  return yield* qualifyFallback(env, client, release);
});
const readArchivedStage = Effect.fn(function* (env: Config) {
  const archived = yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(
    yield* readFile(env.file)
  );
  if (
    Option.isNone(yield* fixtureVerifier) ||
    env.revision !== archivedDormant.revision ||
    !matchesArchivedStage(archived)
  ) {
    return yield* new ReleaseFailure({
      message: "Archived unsealed stage differs from its protected source",
    });
  }
  return archived;
});
const resealFallback = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  return yield* qualifyFallback(env, client, yield* readArchivedStage(env));
});
const diagnosePairing = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  const release = yield* readArchivedStage(env);
  const observations = yield* verifyUnpromotedFallback({
    port: releasePort({ env, client }),
    release,
    verify: Effect.gen(function* () {
      const stage = yield* readFallbackStage(env, client, release);
      const candidate = yield* checkedFixtureStage(env, client, stage);
      yield* observeDormantPair(client, candidate, false);
      const send = acceptanceSend(client);
      const original = {
        revision: release.snapshot.stableRevision,
        core: release.snapshot.core.stableVersionId,
        ingress: release.snapshot.public.stableVersionId,
        proof: env.smokeProof,
      };
      const ordinary = yield* observePairingStart(candidate, "json", send);
      const empty = yield* observePairingStart(candidate, "empty", send);
      const predecessor = yield* observePairingStart(original, "json", send);
      return { ordinary, empty, predecessor };
    }),
  });
  yield* Effect.logInfo("Pairing transport observation", observations);
});
const forwardFallback = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  const stage = yield* Schema.decodeUnknownEffect(FallbackStage)(yield* readFile(yield* stagePath));
  if (
    Option.isSome(yield* fixtureVerifier) &&
    (!matchesArchivedStage(stage.release) ||
      stage.controlsDigest !== fixtureUpload.controlsDigest ||
      !isDeepStrictEqual(stage.smoke, archivedDormant.smoke))
  ) {
    return yield* new ReleaseFailure({
      message: "Sealed stage differs from the verified original staged pair",
    });
  }
  const port = releasePort({ env, client });
  const promoted = yield* recoverFixtureFallback(port, stage, (verified, phase) =>
    verifyDormantPhase(env, client, { stage: verified, phase })
  );
  yield* writeFile(env.file + ".fallback", encodeJson({ stage, promoted, rollbackTested: false }));
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
  if ((yield* expectedFixtureSigner) !== "" && !eligible.rollback) {
    return yield* new ReleaseFailure({
      message:
        "Candidate receipt signer requires a tested compatible return to the captured stable pair",
    });
  }
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
  if ((yield* expectedFixtureSigner) !== "") {
    const pair = {
      revision: restored.identity.stableRevision,
      ingress: restored.publicStable,
      core: restored.coreStable,
      proof: env.smokeProof,
    };
    yield* observeDormantPair(client, pair, true).pipe(
      Effect.retry({ times: 12, schedule: Schedule.spaced("25 seconds") })
    );
    yield* originalControlEvidence(env, client, pair);
  }

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
    [
      ...Object.values(installationNames),
      "fidy-native-smoke-" +
        resourceRevision({ revision: env.revision, signed: (yield* expectedFixtureSigner) !== "" }),
    ],
    client
  );
});
const meter = (
  revision: string,
  phase:
    | "begin"
    | "signup"
    | "check"
    | "cleanup"
    | "finish"
    | "probe-logs"
    | "logs"
    | "resume"
    | "renew-cleanup"
    | "settle"
    | "archived-logs"
    | "ten-begin"
    | "ten-resume"
    | "ten-objects"
    | "ten-check"
    | "ten-cleanup"
    | "ten-signup"
    | "ten-logs"
    | "ten-settle"
    | "refusal",
  ...args: string[]
): Effect.Effect<string, ReleaseFailure> =>
  releaseCommand({
    args: [
      "python3",
      "../../scripts/infra-performance/deployed-fleet/pilot.py",
      phase,
      revision,
      ...args,
    ],
    lifetime: "read-only",
  });
const settleFleetMeter = Effect.fn(function* (
  revision: string,
  phase: "finish" | "settle" | "ten-settle"
) {
  const settled = yield* meter(revision, phase, String(yield* Clock.currentTimeMillis)).pipe(
    Effect.map((status) => status.trim()),
    Effect.repeat({
      while: (status) => status === "pending",
      times: 20,
      schedule: Schedule.spaced("15 seconds"),
    }),
    Effect.timeout("6 minutes")
  );
  if (settled !== "observed") {
    return yield* Effect.fail(Error("Post-cleanup Durable Object usage unavailable"));
  }
});
const fleetCheckpoints = Effect.fn(function* (
  env: Config,
  verifierRevision: string,
  installed: Effect.Success<ReturnType<typeof installedRelease>>
) {
  const fs = yield* FileSystem.FileSystem;
  const events: Readonly<Record<string, string | number>>[] = [];
  const record = (event: Readonly<Record<string, string | number>>): Effect.Effect<void, Error> => {
    events.push(event);
    const path = env.smokeAttestationFile + ".fleet";
    return fs
      .writeFileString(
        path + ".next",
        encodeJson({
          revision: env.revision,
          verifierRevision,
          coreVersion: installed.coreVersionId,
          publicVersion: installed.publicVersionId,
          userNamespace: installed.userNamespace,
          requestedPilotUsers: 1,
          fullFleet: "missing",
          events,
        })
      )
      .pipe(Effect.andThen(fs.rename(path + ".next", path)));
  };
  return record;
});
const archivedFleet = Effect.fn(function* (
  installed: Effect.Success<ReturnType<typeof installedRelease>>
) {
  const directory = yield* ReleaseConfig.String("RUNNER_TEMP");
  const provenance = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      runId: artifactNumber,
      sourceRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
      targetSha256: evidenceDigest,
      userSha256: evidenceDigest,
      baselineSha256: evidenceDigest,
    })
  )(yield* readFile(directory + "/fleet-provenance.json"));
  const source = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      revision: Schema.Literal(installed.revision),
      verifierRevision: Schema.Literal(provenance.sourceRevision),
      userNamespace: Schema.Literal(installed.userNamespace),
      coreVersion: Schema.Literal(installed.coreVersionId),
      publicVersion: Schema.Literal(installed.publicVersionId),
      requestedPilotUsers: Schema.Literal(1),
      events: Schema.Array(
        Schema.Struct({ stage: Schema.String, physicalObject: Schema.optional(evidenceDigest) })
      ),
    })
  )(yield* readFile(directory + "/fleet-source.json"));
  const stages = [
    "signup-started",
    "signup-created",
    "observation-start",
    "erasure-submission-started",
    "erasure-reply-unconfirmed",
    "erasure-admitted",
  ];
  const [, , subject] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([
      Schema.Struct({ stage: Schema.Literal("signup-started") }),
      Schema.Struct({ stage: Schema.Literal("signup-created") }),
      Schema.Struct({ stage: Schema.Literal("observation-start"), physicalObject: evidenceDigest }),
      Schema.Struct({ stage: Schema.Literal("erasure-submission-started") }),
      Schema.Struct({ stage: Schema.Literals(["erasure-reply-unconfirmed", "erasure-admitted"]) }),
    ])
  )(source.events.filter((item) => stages.includes(item.stage)));
  return { ...provenance, target: subject.physicalObject };
});
const resumeFleetCleanup = Effect.fn(function* ({
  installed,
  inventory,
  browser,
  record,
}: {
  installed: Effect.Success<ReturnType<typeof installedRelease>>;
  inventory: Parameters<typeof continueFleetCleanup>[0]["inventory"];
  browser: ReturnType<typeof fleetBrowser>;
  record: Effect.Success<ReturnType<typeof fleetCheckpoints>>;
}) {
  const source = yield* archivedFleet(installed);
  yield* record({
    stage: "source-bound",
    sourceRun: source.runId,
    sourceVerifierRevision: source.sourceRevision,
  });
  const budget = (phase: "renew-cleanup" | "refusal"): Effect.Effect<void, Error> =>
    meter(installed.revision, phase).pipe(Effect.asVoid);
  // Retain coverage from the source windows even when physical cleanup fails.
  const coverage = yield* Effect.exit(meter(installed.revision, "archived-logs"));
  const cleaned = yield* Effect.exit(
    continueFleetCleanup({
      ...source,
      inventory,
      record,
      budget,
      login: browser.login,
      renewCleanup: () => budget("renew-cleanup").pipe(Effect.andThen(browser.renew)),
      refused: () => browser.refused((stage) => record({ stage })),
    })
  );
  yield* settleFleetMeter(installed.revision, "settle");
  if (cleaned._tag === "Failure") return yield* Effect.failCause(cleaned.cause);
  if (coverage._tag === "Failure") return yield* Effect.failCause(coverage.cause);
});
const fleetPilot = Effect.fn(function* (
  verifier: Config,
  client: HttpClient.HttpClient,
  { port, operation }: { port: ReleasePort; operation: "fleet-pilot" | "continue-fleet-cleanup" }
) {
  const env = yield* installedConfig(verifier);
  const continued = operation === "continue-fleet-cleanup";
  yield* meter(env.revision, continued ? "resume" : "begin");
  const installed = yield* installedRelease(env, client, {
    port,
    staging: false,
    verifierRevision: verifier.revision,
  });
  const browser = fleetBrowser({
    subject: "fleet-1",
    revision: env.revision,
    proof: Redacted.make(env.smokeProof),
    origins: installedOrigins.acceptance,
    send: acceptanceSend(client),
    erasure: Option.none(),
  });
  const record = yield* fleetCheckpoints(env, verifier.revision, installed);
  yield* record({ stage: "verified-release" });
  const inventory = (): ReturnType<typeof readUserObjects> =>
    readUserObjects(accountReader(env, client), installed.userNamespace);
  if (continued) return yield* resumeFleetCleanup({ installed, inventory, browser, record });
  yield* meter(env.revision, "probe-logs");
  const measured = yield* Effect.exit(
    runFleetPilot({
      inventory,
      beforeSignup: () => meter(env.revision, "signup").pipe(Effect.asVoid),
      register: browser.register,
      renewCleanup: () =>
        meter(env.revision, "cleanup").pipe(
          Effect.matchEffect({
            onFailure: () => record({ stage: "cleanup-lease-refused" }),
            onSuccess: browser.renew,
          })
        ),
      login: browser.login,
      renew: browser.renew,
      record,
      watch: Effect.fn(function* () {
        const start = yield* Clock.currentTimeMillis;
        const observationMs = 600_000;
        while ((yield* Clock.currentTimeMillis) - start < observationMs) {
          yield* meter(env.revision, "check");
          yield* browser.renew();
          yield* Effect.sleep("25 seconds");
        }
      }),
    })
  );
  yield* settleFleetMeter(env.revision, "finish");
  if (measured._tag === "Failure") return yield* Effect.failCause(measured.cause);
  yield* meter(env.revision, "logs");
});
const fleetVerification =
  (
    operation: "fleet-pilot" | "continue-fleet-cleanup"
  ): ((
    env: Config,
    client: HttpClient.HttpClient,
    port: ReleasePort
  ) => ReturnType<typeof fleetPilot>) =>
  (env: Config, client: HttpClient.HttpClient, port: ReleasePort) =>
    fleetPilot(env, client, { port, operation });
type TenAction = "ten-prepare" | "ten-hosted" | "continue-ten-cleanup";
const tenFleet = Effect.fn(function* (
  verifier: Config,
  client: HttpClient.HttpClient,
  { port, action }: { port: ReleasePort; action: TenAction }
) {
  const env = yield* installedConfig(verifier);
  if (action === "ten-prepare") yield* meter(env.revision, "ten-begin");
  if (action === "continue-ten-cleanup") yield* meter(env.revision, "ten-resume");
  const installed = yield* installedRelease(env, client, {
    port,
    staging: false,
    verifierRevision: verifier.revision,
  });
  const input = {
    revision: env.revision,
    proof: Redacted.make(env.smokeProof),
    origins: installedOrigins.acceptance,
    send: acceptanceSend(client),
    erasure: Option.none<ErasureObservation>(),
  };
  const release: Parameters<typeof prepareTen>[0] = {
    revision: env.revision,
    verifierRevision: verifier.revision,
    publicVersion: installed.publicVersionId,
    coreVersion: installed.coreVersionId,
    userNamespace: installed.userNamespace,
    path: env.smokeAttestationFile + ".fleet",
    inventory: () => readUserObjects(accountReader(env, client), installed.userNamespace),
    survivors: admittedErasureLogins(input).logins,
    browser: (ordinal) => fleetBrowser({ ...input, subject: `fleet-${ordinal}` }),
    meter: (phase, ...args) => meter(env.revision, phase, ...args),
    settle: () => settleFleetMeter(env.revision, "ten-settle"),
  };
  if (action === "ten-prepare") return yield* prepareTen(release);
  yield* executeTen(release, action === "continue-ten-cleanup");
});
const tenCommand =
  (
    action: TenAction
  ): ((
    env: Config,
    client: HttpClient.HttpClient,
    port: ReleasePort
  ) => ReturnType<typeof tenFleet>) =>
  (env, client, port) =>
    tenFleet(env, client, { port, action });
const commands = {
  "seal-fallback": sealFallback,
  "reseal-fallback": resealFallback,
  "diagnose-pairing": diagnosePairing,
  "forward-fallback": forwardFallback,
  "ten-prepare": tenCommand("ten-prepare"),
  "ten-hosted": tenCommand("ten-hosted"),
  "continue-ten-cleanup": tenCommand("continue-ten-cleanup"),
  "fleet-pilot": fleetVerification("fleet-pilot"),
  "continue-fleet-cleanup": fleetVerification("continue-fleet-cleanup"),
  "capture-hosts": captureHostStage,
  "attach-hosts": attachCanonicalHosts,
  "prepare-diagnostics": prepareDiagnostics,
  "verify-fresh-target": verifyFreshTarget,
  "verify-upload": verifyStorageUpload,
  verify: verification("verify"),
  "verify-erasure": verification("verify-erasure"),
  "continue-erasure": verification("continue-erasure"),
  capture: captureNative,
  stage: stageNative,
  promote: promoteClosed,
  rollback: rollbackNative,
};
if (import.meta.main) {
  const program = Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(
      Schema.Literals([
        "seal-fallback",
        "reseal-fallback",
        "diagnose-pairing",
        "forward-fallback",
        "ten-prepare",
        "ten-hosted",
        "continue-ten-cleanup",
        "fleet-pilot",
        "continue-fleet-cleanup",
        "capture-hosts",
        "attach-hosts",
        "prepare-diagnostics",
        "verify-fresh-target",
        "verify-upload",
        "verify",
        "verify-erasure",
        "continue-erasure",
        "capture",
        "stage",
        "promote",
        "rollback",
      ])
    )(process.argv[2]);
    const env = releaseEvidence.config();
    const services = yield* Layer.build(Layer.mergeAll(ReleaseHttpLive, BunFileSystem.layer));
    const client = Context.get(services, HttpClient.HttpClient);
    yield* commands[command](env, client, releasePort({ env, client })).pipe(
      Effect.provideService(FileSystem.FileSystem, Context.get(services, FileSystem.FileSystem))
    );
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
