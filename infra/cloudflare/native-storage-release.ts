import {
  addedSignupStore,
  requireCanonicalSignupBindings,
  signupUserCensus,
  verifyCanonicalSignupRedirects,
} from "./native-canonical-signup";
import { canonicalDomains } from "./native-canonical-domains";
import { SuccessorSource } from "./native-fixture-plan";
import { resourceFailureMessage } from "./resource-failure";
import {
  FallbackStage,
  RestoredDormantSource,
  archivedDormant,
  fromArchivedStage,
  matchesArchivedStage,
  matchesReplacementPredecessor,
  recoverFixtureFallback,
  requireDormantReplacementSource,
  requirePromotedDormantSource,
  requireRestoredDormantSource,
  resumePairingRollback,
  stageUploadedPair,
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
import uploadedPair from "./native-pairing-upload.json" with { type: "json" };
import fixtureUpload from "./native-fixture-upload.json" with { type: "json" };
import retainedProvider from "./native-retained-provider.json" with { type: "json" };
import {
  expectedFixtureSigner,
  fixtureArtifacts,
  fixtureBuild,
  resourceRevision,
  stagedAccountingRevision,
} from "./native-fixture-signer";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import type { ErasureProgress } from "./native-erasure-continuation";
import type { ErasureObservation } from "./native-erasure";
import { verificationRevision } from "./installed-verification-revision";
import { readUserObjects } from "./native-erasure-evidence";
import { verifyNativeSmoke } from "./native-release-smoke";
import { isDeepStrictEqual } from "node:util";
import { verifyIncumbentFence, verifyIncumbentMail } from "./native-incumbent-fence";
import { readProviderList } from "./native-provider-list";
import { verifyInstalledWebsite } from "./native-deployed-web";
import {
  canonicalDomainReader,
  inspectDeployedEdge,
  requireClosedIngressDomains,
  requireStagedHostDomains,
} from "./native-deployed-edge";
import {
  inspectNativeResources,
  isNativeInventoryRefused,
  verifyDeployedVersion,
  verifySuccessorVersionAt,
} from "./native-deployed-graph";
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
  DateTime,
  Effect,
  Exit,
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
  CausedReleaseFailure,
  type ProductionReleaseConfig as Config,
  ReleaseFailure,
  canonicalRestorePort,
  configureReleaseObservability,
  fixtureVerifier,
  isReleaseFailure,
  isWorkerVersionReadUnavailable,
  releaseCommand,
  releaseEvidence,
  releaseFailureFrom,
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
import {
  type WorkerBindings,
  rollbackCompatible,
  type verifiedVersionResources,
} from "./rollback-compatibility";

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
  (env: Config, client: HttpClient.HttpClient, reportRejection = false) =>
  (path: string): Effect.Effect<unknown, Error> =>
    providerJson(
      HttpClientRequest.get(
        `https://api.cloudflare.com/client/v4/accounts/${env.account}/${path}`,
        { headers: { authorization: `Bearer ${env.token}` } }
      ),
      reportRejection
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
  smoke: Readonly<{ deploymentId: string; versionId: string }> = fixtureUpload.support.Smoke
) {
  yield* Effect.forEach(
    ["Smoke", "Web", "ForwardedEmail"] as const,
    (role) =>
      Effect.gen(function* () {
        const name =
          role === "Smoke"
            ? "fidy-native-smoke-" + fixtureUpload.revision
            : installationNames[role];

        const active = yield* port.current(name);
        const expected = role === "Smoke" ? smoke : fixtureUpload.support[role];

        if (
          active.id !== expected.deploymentId ||
          active.versions.length !== 1 ||
          (yield* releaseController.servingVersion(active)) !== expected.versionId
        ) {
          return yield* new ReleaseFailure({
            message: "Interrupted native auxiliary Worker changed",
          });
        }
      }),
    { discard: true }
  );
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

  if (!matchesReplacementPredecessor({ prior, snapshot })) {
    return yield* new ReleaseFailure({
      message: "Replacement source differs from the protected stage",
    });
  }

  if (prior.snapshot.revision === archivedDormant.revision) {
    yield* Effect.try(() => requireOriginalFallbackSource(prior.snapshot));
  }

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
  yield* Schema.decodeUnknownEffect(
    Schema.Struct({ digest: Schema.Literal(fixtureUpload.controlsDigest) })
  )(yield* readFile(env.file + ".source.controls"));

  if (prior.snapshot.revision === uploadedPair.revision) {
    yield* verifyUploadedSupport(env, client);
  } else {
    yield* requireCapturedSupport(port, archivedDormant.smoke);
  }

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

const pairingSeal = Effect.fn(function* () {
  const application = yield* ReleaseConfig.String("FIXTURE_PAIRING_APPLICATION").pipe(
    ReleaseConfig.option
  );

  if (Option.isNone(application)) return Option.none<FallbackStage>();
  const stage = yield* Schema.decodeUnknownEffect(FallbackStage)(yield* readFile(yield* stagePath));

  if (
    stage.revision !== application.value ||
    !fromArchivedStage(stage.release.snapshot) ||
    stage.controlsDigest !== fixtureUpload.controlsDigest ||
    !isDeepStrictEqual(stage.provider, retainedProvider)
  ) {
    return yield* new ReleaseFailure({ message: "Protected replacement seal differs" });
  }

  return Option.some(stage);
});

const verifyDormantRollbackSource = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  snapshot: FallbackStage["release"]["snapshot"]
) {
  const port = releasePort({ env, client });

  if (snapshot.stableRevision !== env.revision) {
    return yield* Effect.fail(
      Error("Active receipt requires the dormant build of this exact revision")
    );
  }

  const seal = yield* pairingSeal();

  if (Option.isSome(seal)) {
    yield* requireCapturedSupport(port, seal.value.smoke);
    yield* confirmFallbackVersions(env, client, seal.value.release);

    const restored = yield* ReleaseConfig.Literal("true", "FIXTURE_RESTORED_ROLLBACK").pipe(
      ReleaseConfig.option
    );

    if (Option.isSome(restored)) {
      const source = yield* Schema.decodeUnknownEffect(RestoredDormantSource)(
        yield* readFile(env.file + ".restored-source")
      );

      return yield* requireRestoredDormantSource({
        port,
        snapshot,
        sealed: seal.value.release,
        source,
      });
    }
  }

  yield* requirePromotedDormantSource(
    port,
    snapshot,
    Option.getOrUndefined(Option.map(seal, (stage) => stage.release))
  );
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

  if (operation === "rollout-fixture-successor") {
    yield* verifySuccessorReturnSource(env, client, snapshot);
  } else if (replacing) {
    yield* verifyReplacementSource(env, client, snapshot);
  } else if ((yield* fixtureBuild) === "fallback") {
    yield* Effect.try(() => requireOriginalFallbackSource(snapshot));

    if (operation !== "plan-fixture-repair" && operation !== "resume-fixture-upload") {
      return yield* new ReleaseFailure({ message: "Dormant repair requires the archived upload" });
    }

    yield* verifyInterruptedUpload(env, client, { port, snapshot });

    if (operation === "plan-fixture-repair") return;
  } else {
    yield* verifyDormantRollbackSource(env, client, snapshot);
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

  const seal = yield* pairingSeal();

  if (
    Option.isSome(seal) &&
    !isDeepStrictEqual(fallbackNamespaces(stored.namespaces), seal.value.namespaces)
  ) {
    return yield* new ReleaseFailure({
      message: "Serving namespace identities differ from the protected stage",
    });
  }

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

const verifyInstallationWorker = (
  input: Parameters<typeof verifyDeployedVersion>[0],
  generation: string,
  successor: boolean
): void => {
  if (successor && input.role !== "Web" && input.role !== "ForwardedEmail") {
    verifySuccessorVersionAt({
      ...input,
      revision: input.role === "Smoke" ? generation : input.revision,
      generation,
    });

    return;
  }

  verifyDeployedVersion(input);
};

const verifyDeployedWorkers = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { port, roles }: { port: ReleasePort; roles: "all" | "support" }
) {
  const fingerprint = yield* expectedFixtureSigner;
  const artifacts = yield* fixtureArtifacts(env.revision);
  const generation = artifacts.resourceRevision;

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
      verifyInstallationWorker(
        {
          role,
          account: env.account,
          revision: auxiliary ? artifacts.supportRevision : env.revision,
          versionId: id,
          raw,
          fingerprint,
        },
        generation,
        artifacts.successorPlan
      )
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
          (error) =>
            new CausedReleaseFailure({
              message: "Native deployed Worker verification failed for " + worker[0],
              cause: error,
            })
        )
      ),
    { concurrency: 3 }
  );
});

const inspectInstalledResources = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  generation: string
) {
  return yield* inspectNativeResources(accountReader(env, client), generation, true).pipe(
    Effect.retry({ times: 2, schedule: Schedule.spaced("2 seconds") }),
    Effect.tapCause((cause) =>
      Effect.logError("Native data resource inventory failed: " + resourceFailureMessage(cause))
    ),
    Effect.mapError(
      (failure) =>
        new ReleaseFailure({
          message: isNativeInventoryRefused(failure)
            ? "Native data resource inventory differs at " + failure.phase + " after bounded reads"
            : "Native bucket, Queue or Workflow inventory differs after bounded reads",
        })
    )
  );
});

const verifyInstalledTopology = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  input: {
    port: ReleasePort;
    bindings: WorkerBindings;
    publicStable: string;
    coreStable: string;
    hosts: NativeHostMode;
    staging: boolean;
  }
) {
  const signed = (yield* expectedFixtureSigner) !== "";
  const artifacts = yield* fixtureArtifacts(env.revision);
  const generation = artifacts.resourceRevision;
  const workers = yield* verifyDeployedWorkers(env, client, { port: input.port, roles: "all" });

  if (
    workers.find((item) => item.role === "Ingress")?.versionId !== input.publicStable ||
    workers.find((item) => item.role === "Core")?.versionId !== input.coreStable
  ) {
    return yield* new ReleaseFailure({
      message: "Application versions changed during verification",
    });
  }

  const resources = yield* inspectInstalledResources(env, client, generation);

  const edge = yield* inspectDeployedEdge(env, client, {
    installed: true,
    bindings: input.bindings,
    hosts: input.hosts,
    staging: input.staging,
  }).pipe(Effect.mapError(releaseFailureFrom("Native DNS, host or Access inventory differs")));

  yield* requireStagedHostDomains(accountReader(env, client), edge.zoneId, input.staging).pipe(
    Effect.when(Effect.succeed(input.hosts === "staged"))
  );

  const website = yield* Effect.forEach(
    nativeHostPairs(input.staging ? "acceptance" : input.hosts),
    (pair) =>
      verifyInstalledWebsite(client, artifacts.supportRevision, pair).pipe(
        Effect.mapError(
          releaseFailureFrom("Native browser asset, metadata or header verification failed")
        )
      )
  );

  const verification = { workers, resources, edge, website };

  if (!signed) return verification;
  const retained = yield* verifyRetainedProvider(env, client, input.port);

  const signedVerification = {
    ...verification,
    resourceRevision: generation,
    retainedProvider: retained,
  };

  return artifacts.successorPlan
    ? { ...signedVerification, fixtureMember: "performance-2" }
    : signedVerification;
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
      releaseFailureFrom("Installed revision must be the same protected runtime source")
    )
  );

  return { ...verifier, revision };
});

const originalControlEvidence = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { core, ingress, routing }: { core: string; ingress: string; routing: "ordinary" | "pinned" }
) {
  const { digest } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ digest: SmokeIdentity.fields.contractDigest })
  )(yield* readFile(env.file + ".controls"));

  const observed = yield* controlsDigest(
    { revision: env.revision, core, ingress, proof: env.smokeProof },
    acceptanceSend(client),
    routing
  );

  if (observed !== digest) {
    return yield* new ReleaseFailure({ message: "Original financial control identities changed" });
  }

  return { fixtureControlsDigest: digest };
});

const requireInstalledSeal = ({
  installed,
  seal,
}: {
  installed: Effect.Success<ReturnType<typeof installedRelease>>;
  seal: FallbackStage;
}): void => {
  const smoke = installed.workers.find((worker) => worker.role === "Smoke");

  if (
    !isDeepStrictEqual(fallbackNamespaces(installed.namespaces), seal.namespaces) ||
    smoke?.versionId !== seal.smoke.versionId ||
    smoke.deploymentId !== seal.smoke.deploymentId
  ) {
    throw new ReleaseFailure({
      message: "Active release differs from the sealed namespaces or Smoke Worker",
    });
  }
};

const activeControlEvidence = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  installed: Effect.Success<ReturnType<typeof installedRelease>>
) {
  const operation = yield* ReleaseConfig.String("FIXTURE_RELEASE_OPERATION").pipe(
    ReleaseConfig.withDefault("")
  );

  if (
    (yield* expectedFixtureSigner) === "" ||
    (operation !== "rollout" && operation !== "rollout-fixture-successor")
  ) {
    return {};
  }

  const seal =
    operation === "rollout-fixture-successor"
      ? Option.some((yield* readSuccessorSeal(env)).stage)
      : yield* pairingSeal();

  if (Option.isSome(seal)) {
    yield* Effect.try(() => requireInstalledSeal({ installed, seal: seal.value }));
  }

  return yield* originalControlEvidence(env, client, {
    ingress: installed.publicVersionId,
    core: installed.coreVersionId,
    routing: "pinned",
  });
});

const installedSmokeFailure = (
  failure: Effect.Error<ReturnType<typeof verifyNativeSmoke>>
): ReleaseFailure =>
  new ReleaseFailure({
    message:
      "Installed release smoke failed: " +
      (Schema.isSchemaError(failure)
        ? "Probe request did not match the owned schema"
        : failure.reason),
  });

const requireServingAccounting = Effect.fn(function* (
  env: Config,
  port: ReleasePort,
  operation: string
) {
  const finalize = yield* ReleaseConfig.Boolean("FIXTURE_ACCOUNTING_FINALIZE").pipe(
    ReleaseConfig.withDefault(false)
  );

  if (!finalize) return false;
  yield* ReleaseConfig.Literal("rollout-fixture-successor", "FIXTURE_RELEASE_OPERATION");

  if (operation !== "verify" || env.revision !== stagedAccountingRevision) {
    return yield* new ReleaseFailure({ message: "Unexpected serving accounting verification" });
  }

  const receipt = yield* readRollbackReceipt(env);
  yield* releaseController.verifyRetirement(port, receipt);

  return true;
});

const verifyInstalledUsers = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  erasureNamespace: Option.Option<string>
) {
  const synthetic = yield* Effect.forEach(nativeHostPairs(yield* hostMode), (pair) =>
    verifySyntheticUsers(env, client, {
      origins: pair,
      erasureNamespace:
        pair.api === installedOrigins.acceptance.api ? erasureNamespace : Option.none(),
    }).pipe(Effect.map((result) => ({ api: pair.api, ...result })))
  );

  if (new Set(synthetic.map((result) => result.callback.workflow)).size !== 1) {
    return yield* Effect.fail(Error("Staged hosts reached different native payment attempts"));
  }

  return { synthetic };
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
  const finalizeAccounting = yield* requireServingAccounting(env, port, operation);

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
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.mapError(installedSmokeFailure)
  );

  yield* Effect.logInfo("Verified release smoke against the installed Worker versions.");

  const userEvidence = finalizeAccounting
    ? {}
    : yield* verifyInstalledUsers(
        env,
        client,
        operation === "verify-erasure" ? Option.some(installed.userNamespace) : Option.none()
      );

  const { accountingRollout } = yield* fixtureArtifacts(env.revision);
  const accountingWitness = accountingRollout ? { nativeAccountingWitness: true } : {};
  yield* writeFile(
    env.smokeAttestationFile,
    encodeJson({
      ...installed,
      ...accountingWitness,
      verifierRevision: Option.getOrElse(yield* fixtureVerifier, () => verifier.revision),
      smoke,
      ...userEvidence,
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

type InstalledRelease = Effect.Success<ReturnType<typeof installedRelease>>;

type InstalledAccess = InstalledRelease["edge"]["access"][number];

type CoordinateIdentity = Pick<InstalledRelease, "revision" | "markers" | "workers" | "resources"> &
  Readonly<{
    namespaces: ReadonlyArray<InstalledRelease["namespaces"][number]>;
    access: ReadonlyArray<
      Readonly<{ id: InstalledAccess["appId"]; name: InstalledAccess["name"] }>
    >;
    zone: InstalledRelease["edge"]["zoneId"];
  }>;

const coordinateIdentity = (installed: InstalledRelease): CoordinateIdentity => ({
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

const CanonicalHostSource = Schema.Struct({
  revision: SmokeIdentity.fields.gitRevision,
  verifierRevision: SmokeIdentity.fields.gitRevision,
  source: Schema.Struct({ artifactId: artifactNumber, sha256: evidenceDigest }),
  smoke: Schema.Struct({
    artifactId: artifactNumber,
    sha256: evidenceDigest,
    runId: artifactNumber,
    revision: SmokeIdentity.fields.gitRevision,
  }),
  versions: Schema.Struct({ core: Schema.NonEmptyString, ingress: Schema.NonEmptyString }),
  deployments: Schema.Struct({ core: Schema.NonEmptyString, ingress: Schema.NonEmptyString }),
  namespaces: Schema.Tuple([
    Schema.NonEmptyString,
    Schema.NonEmptyString,
    Schema.NonEmptyString,
    Schema.NonEmptyString,
    Schema.NonEmptyString,
  ]),
  website: Schema.Struct({
    revision: SmokeIdentity.fields.gitRevision,
    contractDigest: evidenceDigest,
    version: Schema.NonEmptyString,
    deployment: Schema.NonEmptyString,
  }),
});

const zoneReader = (
  env: Config,
  client: HttpClient.HttpClient,
  { zoneId, reportRejection }: { zoneId: string; reportRejection: boolean }
) => {
  const base = "https://api.cloudflare.com/client/v4/zones/" + zoneId + "/";

  return (path: string): Effect.Effect<unknown, Error> =>
    providerJson(
      HttpClientRequest.get(base + path, { headers: { authorization: "Bearer " + env.token } }),
      reportRejection
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
};

const readCanonicalSource = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* requiredStaging();
  yield* releaseController.requireTrunk(port, env.revision);
  const directory = yield* ReleaseConfig.String("RUNNER_TEMP");

  const source = yield* Schema.decodeUnknownEffect(CanonicalHostSource)(
    yield* readFile(directory + "/native-canonical-host-source.json")
  );

  if (source.verifierRevision !== env.revision) {
    return yield* new ReleaseFailure({
      message: "Canonical host source differs from the verifier",
    });
  }

  const core = yield* port.current(installationNames.Core);
  const ingress = yield* port.current(installationNames.Ingress);

  if (
    core.id !== source.deployments.core ||
    ingress.id !== source.deployments.ingress ||
    core.versions.length !== 1 ||
    ingress.versions.length !== 1 ||
    (yield* releaseController.servingVersion(core)) !== source.versions.core ||
    (yield* releaseController.servingVersion(ingress)) !== source.versions.ingress
  ) {
    return yield* new ReleaseFailure({ message: "Canonical host source routing changed" });
  }

  const { bindings } = yield* versionResources(env, client, {
    name: installationNames.Core,
    id: source.versions.core,
    revision: source.revision,
  });

  return { source, bindings };
});

const checkCanonicalPrerequisite =
  (stage: string) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    work.pipe(
      Effect.tapCause((cause) =>
        Effect.logError(
          "Canonical host check failed at " + stage + ". " + resourceFailureMessage(cause)
        )
      )
    );

const reportFenceRead =
  (read: (path: string) => Effect.Effect<unknown, Error>, scope: string) =>
  (path: string): Effect.Effect<unknown, Error> =>
    read(path).pipe(
      Effect.tapError((error) =>
        isReleaseFailure(error)
          ? Effect.logError(
              "Canonical fence provider refused a " + scope + " read. " + error.message
            )
          : Effect.void
      )
    );

type IncumbentFenceChecks = Readonly<{
  mail: ReturnType<typeof verifyIncumbentMail>;
  writers: ReturnType<typeof verifyIncumbentFence>;
}>;

const incumbentFenceChecks = (
  env: Config,
  client: HttpClient.HttpClient,
  zoneId: string
): IncumbentFenceChecks => {
  const account = reportFenceRead(accountReader(env, client, true), "Workers account");

  const zoneMail = reportFenceRead(
    zoneReader(env, client, { zoneId, reportRejection: true }),
    "Email Routing zone"
  );

  const accountMail = reportFenceRead(accountReader(env, client, true), "Email Routing account");

  const mail = verifyIncumbentMail(accountMail, zoneMail).pipe(
    checkCanonicalPrerequisite("Email Routing fence")
  );

  const writers = verifyIncumbentFence(account).pipe(
    checkCanonicalPrerequisite("incumbent Worker, Queue and Workflow fence")
  );

  return { mail, writers };
};

const inspectIncumbentWriters = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  zoneId: string
) {
  const { mail, writers } = incumbentFenceChecks(env, client, zoneId);
  yield* mail;

  return yield* writers;
});

const requireRetainedCanonicalWeb = (
  port: ReleasePort,
  worker: { deployment: string; version: string }
): ReturnType<typeof releaseController.requireCapturedWorker> =>
  releaseController.requireCapturedWorker(port, {
    name: installationNames.Web,
    deploymentId: worker.deployment,
    stableVersionId: worker.version,
  });

const verifyTransferredHosts = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  const { source, bindings } = yield* readCanonicalSource(env, client, port).pipe(
    checkCanonicalPrerequisite("authenticated native source")
  );

  yield* verifyNativeEdge(env, client, "verify").pipe(
    checkCanonicalPrerequisite("zone firewall policy")
  );

  const edge = yield* inspectDeployedEdge(env, client, {
    installed: true,
    bindings,
    hosts: "staged",
    staging: false,
  }).pipe(
    checkCanonicalPrerequisite("DNS, Workers Builds or protected Access"),
    Effect.mapError(releaseFailureFrom("Canonical DNS, host or Access inventory differs"))
  );

  const read = canonicalDomainReader({
    readAccount: accountReader(env, client),
    readZone: zoneReader(env, client, { zoneId: edge.zoneId, reportRejection: false }),
    zoneId: edge.zoneId,
  });

  yield* requireStagedHostDomains(accountReader(env, client), edge.zoneId, false).pipe(
    checkCanonicalPrerequisite("native Worker domain inventory")
  );
  yield* inspectIncumbentWriters(env, client, edge.zoneId);
  yield* requireRetainedCanonicalWeb(port, source.website);

  const website = yield* Effect.forEach(nativeHostPairs("staged"), (pair) =>
    verifyInstalledWebsite(client, source.website.revision, {
      ...pair,
      contractDigest: source.website.contractDigest,
    })
  );

  const refusal = yield* client.execute(
    HttpClientRequest.get(installedOrigins.production.api + "/transactions")
  );

  const unavailable = 503;

  if (
    refusal.status !== unavailable ||
    refusal.headers["x-fidy-recovery-isolation"] !== "isolated"
  ) {
    return yield* new ReleaseFailure({ message: "Canonical API did not retain closed admission" });
  }

  const hosts = yield* Effect.forEach(canonicalDomains, read);

  return { source, zoneId: edge.zoneId, hosts, website, admission: "closed" };
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
  });

  const writers = yield* inspectIncumbentWriters(env, client, installed.edge.zoneId);

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

const attachCanonicalHost = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { port, host }: Readonly<{ port: ReleasePort; host: string }>
) {
  const { installed } = yield* inspectHostStage(env, client, port);
  yield* requireSameInstallation(env, installed);

  if (installed.edge.access.some((row) => row.paths.length !== 2)) {
    return yield* Effect.fail(Error("Canonical Access policies are incomplete"));
  }

  const target = installed.edge.hosts.find((row) => row.host === host);

  if (target === undefined) return yield* Effect.fail(Error("Canonical hostname unavailable"));

  if (!target.vacant) return;

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
});

const attachCanonicalHosts = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* Effect.forEach(
    [
      new URL(installedOrigins.production.api).hostname,
      new URL(installedOrigins.production.browser).hostname,
    ],
    (host) => attachCanonicalHost(env, client, { port, host }),
    { discard: true }
  );

  const verified = yield* installedRelease(env, client, {
    port,
    staging: false,
    verifierRevision: env.revision,
  });

  yield* requireSameInstallation(env, verified);
});

const PinnedStorageEvidence = Schema.Struct({ core: SmokeIdentity, markers: SharedStoreMarkers });

const MarkerSections = Schema.Struct({
  core: Schema.optionalKey(Schema.Unknown),
  markers: Schema.optionalKey(Schema.Unknown),
});

const decodePinnedStorageEvidence = Effect.fn(function* (
  response: HttpClientResponse.HttpClientResponse,
  ingress: string
) {
  const served = Option.fromUndefinedOr(response.headers["x-fidy-smoke-worker-version"]);

  const ingressEvidence = Option.match(served, {
    onNone: () => "missing",
    onSome: (id) => (id === ingress ? "matched" : "different"),
  });

  if (response.status !== successStatusStart) {
    return yield* new ReleaseFailure({
      message:
        "Pinned storage probe returned HTTP " +
        response.status +
        " with Ingress version " +
        ingressEvidence,
    });
  }

  const raw = yield* response.json.pipe(
    Effect.mapError(releaseFailureFrom("Pinned storage probe returned invalid JSON"))
  );

  const evidence = Schema.decodeUnknownOption(PinnedStorageEvidence)(raw);

  if (Option.isSome(evidence)) return evidence.value;
  const sections = Schema.decodeUnknownOption(MarkerSections)(raw);

  const presented = Option.match(sections, {
    onNone: () => "no structured sections",
    onSome: ({ core, markers }) =>
      "coreIdentity=" +
      Schema.is(SmokeIdentity)(core) +
      " storeMarkers=" +
      Schema.is(SharedStoreMarkers)(markers),
  });

  return yield* new ReleaseFailure({
    message:
      "Pinned storage probe returned HTTP 200 with Ingress version " +
      ingressEvidence +
      " and " +
      presented,
  });
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
  } & (Readonly<Record<never, never>> | { api: string })
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

  const api = "api" in input ? input.api : origin;

  const response = yield* client.execute(
    HttpClientRequest.get(api + "/internal/release-smoke" + compatibilityQuery, { headers })
  );

  const observation = yield* decodePinnedStorageEvidence(response, input.ingress);

  if (
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

type ProbePair = { descriptions: Descriptions; probeOriginal: boolean };

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
  | "completed upload receipts"
  | "pre-stage controls"
  | "stage assignments"
  | "taxonomy"
  | "version resources"
  | "rollback source"
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
  { descriptions, probeOriginal }: ProbePair
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

  if (probeOriginal) {
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
  yield* verifyTaxonomyOverlap(release.snapshot).pipe(sealCheck("taxonomy"));
  const versions = deployedStorage({ env, client, release });

  const { ingress, core, descriptions } = yield* (
    phase === "stage"
      ? versions.pipe(
          Effect.retry({
            while: isWorkerVersionReadUnavailable,
            times: 4,
            schedule: Schedule.spaced("2 seconds"),
          })
        )
      : versions
  ).pipe(
    Effect.mapError((error) =>
      isWorkerVersionReadUnavailable(error)
        ? new ReleaseFailure({
            message: "Immutable Worker version read returned HTTP " + error.status,
          })
        : error
    ),
    sealCheck("version resources")
  );

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

  const source = yield* rollbackSource(release.snapshot).pipe(sealCheck("rollback source"));

  const rollback =
    overlap.rollback && [ingress, core].every((pair) => rollbackCompatible({ ...pair, ...source }));

  if (phase === "promote") {
    yield* probePromotionPairs({ env, client }, release, { descriptions, probeOriginal: rollback });
  }

  return { rollback };
});

const confirmFallbackVersions = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  release: StorageTransition
) {
  const fingerprint = yield* expectedFixtureSigner;

  yield* Effect.forEach(
    [
      ["Core", installationNames.Core, release.coreVersionId],
      ["Ingress", installationNames.Ingress, release.publicVersionId],
    ] as const,
    Effect.fnUntraced(function* ([role, worker, id]) {
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
    }),
    { discard: true }
  );
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
  const seal = yield* pairingSeal();

  const resuming =
    (yield* ReleaseConfig.String("FIXTURE_RELEASE_OPERATION").pipe(
      ReleaseConfig.withDefault("")
    )) === "resume-pairing-stage";

  if (
    Option.isSome(yield* fixtureVerifier) &&
    !isDeepStrictEqual(
      coordinates,
      Option.match(seal, {
        onSome: (stage) => stage.smoke,
        onNone: () => (resuming ? uploadedPair.smoke : archivedDormant.smoke),
      })
    )
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
  const seal = yield* pairingSeal();

  if (
    Option.isNone(seal) &&
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
  const op = yield* ReleaseConfig.String("FIXTURE_RELEASE_OPERATION").pipe(
    ReleaseConfig.withDefault("")
  );

  const receipts = yield* workersFromState(
    mode,
    nativeStack,
    mode === "completed" && op === "resume-pairing-stage"
  );

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

const verifyUploadedSupport = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  const port = releasePort({ env, client });
  yield* requireCapturedSupport(port, uploadedPair.smoke);
  const name = "fidy-native-smoke-" + fixtureUpload.revision;
  const [, previous] = yield* port.recentDeployments(name);

  if (
    !isDeepStrictEqual(previous, {
      id: archivedDormant.smoke.deploymentId,
      versions: [{ id: archivedDormant.smoke.versionId, percentage: 100 }],
    })
  ) {
    return yield* new ReleaseFailure({ message: "Uploaded technical Smoke predecessor differs" });
  }

  const id = uploadedPair.smoke.versionId;
  const raw = yield* releaseEvidence.readWorkerVersion(env, client, { name, id });
  yield* Effect.try(() =>
    verifyDeployedVersion({
      role: "Smoke",
      raw,
      account: env.account,
      revision: uploadedPair.revision,
      versionId: id,
      fingerprint: fixtureUpload.fingerprint,
    })
  );
});

const resumePairingStage = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  const port = releasePort({ env, client });

  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );

  if (
    env.revision !== uploadedPair.revision ||
    Option.isNone(yield* fixtureVerifier) ||
    (yield* expectedFixtureSigner) !== fixtureUpload.fingerprint ||
    (yield* fixtureBuild) !== "fallback"
  ) {
    return yield* new ReleaseFailure({
      message: "Interrupted pairing upload is outside its protected verifier",
    });
  }

  const verify = Effect.gen(function* () {
    yield* readReplacementPredecessor(env, snapshot).pipe(sealCheck("archive"));
    yield* nativeWorkerReceipts("completed").pipe(sealCheck("completed upload receipts"));
    yield* verifyUploadedSupport(env, client).pipe(sealCheck("support Workers"));
    yield* verifyRetainedProvider(env, client, port).pipe(sealCheck("provider"));
    yield* requireClosedAdmission(client).pipe(sealCheck("closed admission"));
    yield* requireClosedIngressDomains(accountReader(env, client));

    const release = {
      snapshot,
      publicVersionId: uploadedPair.publicVersionId,
      coreVersionId: uploadedPair.coreVersionId,
    };

    yield* storageCompatibility({ env, client }, release, "stage");
    yield* confirmFallbackVersions(env, client, release).pipe(
      sealCheck("candidate Worker metadata")
    );
    yield* recordSourceControls(env, client, {
      pair: {
        revision: snapshot.stableRevision,
        ingress: snapshot.public.stableVersionId,
        core: snapshot.core.stableVersionId,
        proof: env.smokeProof,
      },
      replacing: true,
    }).pipe(sealCheck("pre-stage controls"));
  });

  const staged = yield* stageUploadedPair(port, snapshot, verify).pipe(
    sealCheck("stage assignments")
  );

  yield* writeFile(env.file, encodeJson(staged));
});

const uploadedNativePair = Effect.gen(function* () {
  const workers = yield* nativeWorkerReceipts("completed");

  if (Option.isNone(workers.public.versionId) || Option.isNone(workers.core.versionId)) {
    return yield* new ReleaseFailure({ message: "Native Worker upload receipts incomplete" });
  }

  return {
    publicVersionId: workers.public.versionId.value,
    coreVersionId: workers.core.versionId.value,
  };
});

const CanonicalTransfer = Schema.Struct({
  source: CanonicalHostSource,
  zoneId: Schema.NonEmptyString,
  hosts: Schema.Tuple([
    Schema.Struct({
      vacant: Schema.Literal(false),
      id: Schema.NonEmptyString,
      service: Schema.NonEmptyString,
    }),
    Schema.Struct({
      vacant: Schema.Literal(false),
      id: Schema.NonEmptyString,
      service: Schema.NonEmptyString,
    }),
  ]),
  admission: Schema.Literal("closed"),
});

const requiredSignupOpening = ReleaseConfig.Literal(
  "open-canonical-signup",
  "FIXTURE_RELEASE_OPERATION"
);

const readCanonicalTransfer = Effect.gen(function* () {
  const directory = yield* ReleaseConfig.String("RUNNER_TEMP");

  return yield* Schema.decodeUnknownEffect(CanonicalTransfer)(
    yield* readFile(directory + "/native-canonical-host-transfer.json")
  );
});

const CanonicalCensus = Schema.Struct({ count: Schema.Int, sha256: evidenceDigest });

const captureCanonicalSignup = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* requiredSignupOpening;
  const { source, hosts, zoneId } = yield* verifyTransferredHosts(env, client, port);
  const approved = yield* readCanonicalTransfer;

  if (
    zoneId !== approved.zoneId ||
    !isDeepStrictEqual(hosts, approved.hosts) ||
    !isDeepStrictEqual(source, approved.source)
  ) {
    return yield* new ReleaseFailure({
      message: "Live closed canonical transfer differs from the protected evidence",
    });
  }

  const { bindings } = yield* versionResources(env, client, {
    name: installationNames.Core,
    id: source.versions.core,
    revision: source.revision,
  });

  const digest = yield* Schema.decodeUnknownEffect(Schema.Struct({ text: evidenceDigest }))(
    bindings.CONTRACT_DIGEST
  );

  const snapshot = yield* releaseController.captureRelease(port, {
    revision: env.revision,
    stableRevision: source.revision,
    stableContractDigest: digest.text,
    publicName: installationNames.Ingress,
    coreName: installationNames.Core,
  });

  if (
    snapshot.core.deploymentId !== source.deployments.core ||
    snapshot.public.deploymentId !== source.deployments.ingress ||
    snapshot.core.stableVersionId !== source.versions.core ||
    snapshot.public.stableVersionId !== source.versions.ingress
  ) {
    return yield* new ReleaseFailure({
      message: "Closed canonical deployment changed during opening capture",
    });
  }

  const users = signupUserCensus(
    yield* readUserObjects(accountReader(env, client), source.namespaces[0])
  );

  yield* writeFile(env.file + ".canonical-census", encodeJson(users));
  yield* writeFile(env.file, encodeJson(snapshot));
});

const canonicalOpeningStorage = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  release: StorageTransition
) {
  const storage = yield* deployedStorage({ env, client, release });
  yield* requireClosedWorkers([storage.core.stable, storage.ingress.stable]);
  const compatibility = compatibleStoragePairs(storage.descriptions);

  if (!compatibility.forward || !compatibility.rollback) {
    return yield* new ReleaseFailure({
      message: "Canonical signup cannot preserve storage compatibility in both directions",
    });
  }

  yield* Effect.try(() => {
    requireCanonicalSignupBindings({
      before: storage.core.stable.bindings,
      after: storage.core.candidate.bindings,
      role: "Core",
    });
    requireCanonicalSignupBindings({
      before: storage.ingress.stable.bindings,
      after: storage.ingress.candidate.bindings,
      role: "Ingress",
    });

    for (const { stable, candidate } of [storage.core, storage.ingress]) {
      if (
        stable.migrationTag !== candidate.migrationTag ||
        !isDeepStrictEqual(stable.exports, candidate.exports) ||
        !isDeepStrictEqual(stable.runtime, candidate.runtime)
      ) {
        throw Error("Canonical signup alters Worker migration, handler or compatibility runtime");
      }
    }
  });

  return storage.descriptions;
});

const targetSignupCandidates = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* requiredSignupOpening;

  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );

  yield* Effect.try(() => requireNativeTarget(snapshot));
  const candidate = yield* uploadedNativePair;
  yield* canonicalOpeningStorage(env, client, { snapshot, ...candidate });
  yield* writeFile(
    env.file,
    encodeJson(yield* releaseController.stageRelease(port, snapshot, candidate))
  );
});

const probeSignupStorage = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { release, descriptions }: { release: StorageTransition; descriptions: Descriptions }
) {
  const owners = storageProbeOwners(release, descriptions);

  const shared = {
    core: release.coreVersionId,
    revision: release.snapshot.revision,
    ingressName: release.snapshot.public.name,
    coreName: release.snapshot.core.name,
    owners,
    api: installedOrigins.production.api,
  };

  yield* requireTestedStorage(env, client, { ...shared, ingress: release.publicVersionId });
  yield* requireTestedStorage(env, client, {
    ...shared,
    ingress: release.snapshot.public.stableVersionId,
  });
});

type CanonicalPromotion = {
  port: ReleasePort;
  release: typeof releaseSchemas.staged.Type;
  promoted: typeof RollbackReceipt.Type.promoted;
};

const readOpenedCanonical = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  input: CanonicalPromotion
) {
  const { port, release, promoted } = input;
  const { zoneId, hosts, source } = yield* readCanonicalTransfer;

  const read = canonicalDomainReader({
    readAccount: accountReader(env, client),
    readZone: zoneReader(env, client, { zoneId, reportRejection: false }),
    zoneId,
  });

  const positions = yield* Effect.forEach(canonicalDomains, read);

  if (!isDeepStrictEqual(positions, hosts)) {
    return yield* new ReleaseFailure({
      message: "Canonical domain identity changed during signup promotion",
    });
  }

  yield* releaseController.requireCapturedWorker(port, {
    ...release.snapshot.core,
    deploymentId: promoted.coreDeploymentId,
    stableVersionId: release.coreVersionId,
  });
  yield* releaseController.requireCapturedWorker(port, {
    ...release.snapshot.public,
    deploymentId: promoted.publicDeploymentId,
    stableVersionId: release.publicVersionId,
  });
  yield* requireRetainedCanonicalWeb(port, source.website);
  yield* proveRecoveryCorePrivate(env, client, installationNames.Core);
  yield* requireLiveSignupDirectory(env, client, release).pipe(
    Effect.timeout("5 seconds"),
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 35 }),
    Effect.timeout("6 minutes"),
    checkCanonicalPrerequisite("live signup Directory")
  );

  return { hosts, source, zoneId };
});

const requireLiveSignupDirectory = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  release: CanonicalPromotion["release"]
) {
  const response = yield* client.execute(
    HttpClientRequest.get(
      installedOrigins.production.api + "/internal/release-smoke" + compatibilityQuery,
      {
        headers: { "x-fidy-smoke-proof": env.smokeProof },
      }
    )
  );

  const evidence = yield* decodePinnedStorageEvidence(response, release.publicVersionId);
  const ingressReady = response.headers["x-fidy-smoke-worker-version"] === release.publicVersionId;
  const coreReady = evidence.core.workerVersionId === release.coreVersionId;
  const directoryReady = evidence.markers.directory.workerVersionId === release.coreVersionId;

  if (!ingressReady || !coreReady || !directoryReady) {
    return yield* new ReleaseFailure({
      message:
        "Ordinary routing has not converged. Ingress " +
        ingressReady +
        ", Core " +
        coreReady +
        ", Directory " +
        directoryReady +
        ".",
    });
  }
});

const verifyOpenCanonical = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  input: CanonicalPromotion
) {
  const { release, promoted } = input;

  const { source, hosts, zoneId } = yield* readOpenedCanonical(env, client, input).pipe(
    checkCanonicalPrerequisite("opened Worker and hostname verification")
  );

  const redirects = yield* verifyCanonicalSignupRedirects(client).pipe(
    checkCanonicalPrerequisite("ordinary provider redirect verification")
  );

  const alternate = yield* client.execute(
    HttpClientRequest.get(installedOrigins.acceptance.api + "/transactions", {
      headers: { origin: installedOrigins.production.browser },
    })
  );

  const unavailable = 503;

  if (
    alternate.status !== unavailable ||
    alternate.headers["x-fidy-recovery-isolation"] !== "isolated"
  ) {
    return yield* new ReleaseFailure({ message: "Acceptance API allowed ordinary admission" });
  }

  const contractDigest = yield* ReleaseConfig.String("CONTRACT_DIGEST");

  const usersBefore = yield* Schema.decodeUnknownEffect(CanonicalCensus)(
    yield* readFile(env.file + ".canonical-census")
  );

  return {
    revision: env.revision,
    contractDigest,
    admission: "open",
    providerRedirects: redirects,
    openedAt: DateTime.formatIso(yield* DateTime.now),
    source,
    zoneId,
    usersBefore,
    workers: {
      [installationNames.Web]: {
        deployment: source.website.deployment,
        version: source.website.version,
      },
      [installationNames.Core]: {
        deployment: promoted.coreDeploymentId,
        version: release.coreVersionId,
      },
      [installationNames.Ingress]: {
        deployment: promoted.publicDeploymentId,
        version: release.publicVersionId,
      },
    },
    hosts: { [canonicalDomains[0].host]: hosts[0].id, [canonicalDomains[1].host]: hosts[1].id },
    namespaces: Object.fromEntries(
      source.namespaces.map((id, index) => [
        id,
        ["UserStore", "Directory", "Pricing", "Maintenance", "Erasure"][index],
      ])
    ),
  };
});

const promoteCanonicalSignup = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReturnType<typeof releasePort>
) {
  yield* requiredSignupOpening;

  const release = yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(
    yield* readFile(env.file)
  );

  const descriptions = yield* canonicalOpeningStorage(env, client, release);
  yield* probeSignupStorage(env, client, { release, descriptions });
  const { snapshot } = release;

  const canonicalPort = canonicalRestorePort({
    port: releaseEvidence.rollbackPort(port, env, client),
    env,
    client,
    snapshot,
    verifyClosedPair: Effect.gen(function* () {
      const { source } = yield* readCanonicalTransfer;

      if (
        snapshot.stableRevision !== source.revision ||
        snapshot.core.stableVersionId !== source.versions.core ||
        snapshot.public.stableVersionId !== source.versions.ingress ||
        snapshot.core.deploymentId !== source.deployments.core ||
        snapshot.public.deploymentId !== source.deployments.ingress
      ) {
        return yield* new ReleaseFailure({
          message: "Canonical restoration differs from the authenticated closed transfer",
        });
      }

      yield* canonicalOpeningStorage(env, client, release);
    }),
  });

  const promoted = yield* releaseController.promoteRelease(canonicalPort, release, {
    exactPairPassed: true,
    middlePairPassed: true,
    rollbackEligible: true,
  });

  yield* writeFile(env.file + ".canonical-promoted", encodeJson({ release, promoted })).pipe(
    Effect.andThen(verifyOpenCanonical(env, client, { port, release, promoted })),
    Effect.flatMap((proof) =>
      writeFile(env.smokeAttestationFile + ".canonical-open", encodeJson(proof))
    ),
    Effect.onError(() =>
      releaseRollback
        .restore(canonicalPort, {
          release,
          promoted,
          compatible: true,
        })
        .pipe(
          Effect.tapError(() => Effect.logError("Canonical opening restoration needs inspection")),
          Effect.ignore
        )
    ),
    Effect.uninterruptible
  );
});

const OpeningWorker = Schema.Struct({
  deployment: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
});

const CanonicalActivity = Schema.Struct({
  opening: Schema.Struct({
    revision: SmokeIdentity.fields.gitRevision,
    contractDigest: evidenceDigest,
    admission: Schema.Literal("open"),
    zoneId: Schema.NonEmptyString,
    hosts: Schema.Record(Schema.String, Schema.NonEmptyString),
    workers: Schema.Struct({
      [installationNames.Core]: OpeningWorker,
      [installationNames.Ingress]: OpeningWorker,
      [installationNames.Web]: OpeningWorker,
    }),
    namespaces: Schema.Record(Schema.String, Schema.NonEmptyString),
    usersBefore: CanonicalCensus,
  }),
  reference: Schema.Struct({ artifactId: artifactNumber, sha256: evidenceDigest }),
  recovery: Schema.Struct({
    kind: Schema.Literal("accepted-workerd"),
    artifactId: artifactNumber,
    runId: artifactNumber,
    revision: SmokeIdentity.fields.gitRevision,
    digest: evidenceDigest,
  }),
  activity: Schema.Struct({
    provider: Schema.Literals(["google", "microsoft", "ordinary"]),
    signupDigest: evidenceDigest,
    background: Schema.Struct({
      watchdogCompleted: Schema.Literal(true),
      canaryCompleted: Schema.Literal(true),
      digest: evidenceDigest,
    }),
  }),
});

type OpeningPositions = typeof CanonicalActivity.Type.opening;

const verifyCanonicalActivityHosts = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  opening: OpeningPositions
) {
  const zoneId = opening.zoneId;

  const read = canonicalDomainReader({
    readAccount: accountReader(env, client),
    readZone: zoneReader(env, client, { zoneId, reportRejection: false }),
    zoneId,
  });

  yield* Effect.forEach(
    canonicalDomains,
    Effect.fn(function* (domain) {
      const current = yield* read(domain);

      if (
        current.vacant ||
        current.service !== domain.native ||
        current.id !== opening.hosts[domain.host]
      ) {
        return yield* new ReleaseFailure({
          message: "Opened canonical domain changed during activity verification",
        });
      }
    }),
    { discard: true }
  );
});

const currentCanonicalActivity = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  { port, opening }: { port: ReleasePort; opening: OpeningPositions }
) {
  yield* releaseController.requireTrunk(port, env.revision);
  yield* requireRetainedCanonicalWeb(port, opening.workers[installationNames.Web]);

  const verify = Effect.fn(function* (
    name: typeof installationNames.Core | typeof installationNames.Ingress
  ) {
    const expected = opening.workers[name];
    yield* releaseController.requireCapturedWorker(port, {
      name,
      deploymentId: expected.deployment,
      stableVersionId: expected.version,
    });

    const { bindings } = yield* versionResources(env, client, {
      name,
      id: expected.version,
      revision: opening.revision,
    });

    yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        NATIVE_STORAGE_ADMISSION: Schema.Struct({ text: Schema.Literal("open") }),
        RECOVERY_ISOLATION: Schema.Struct({ text: Schema.Literal("") }),
        CONTRACT_DIGEST: Schema.Struct({ text: Schema.Literal(opening.contractDigest) }),
      })
    )(bindings);

    return bindings;
  });

  const core = yield* verify(installationNames.Core);
  const ingress = yield* verify(installationNames.Ingress);
  const { namespaces } = yield* Effect.try(() => verifiedStoragePair({ core, ingress }));

  if (!isDeepStrictEqual(namespaces.toSorted(), Object.keys(opening.namespaces).sort())) {
    return yield* new ReleaseFailure({
      message: "Opened native namespaces changed during activity verification",
    });
  }

  yield* verifyCanonicalActivityHosts(env, client, opening);
  yield* proveRecoveryCorePrivate(env, client, installationNames.Core);

  return (yield* Schema.decodeUnknownEffect(UserNamespace)(core.USER_STORE)).namespace_id;
});

const verifyCanonicalActivity = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* ReleaseConfig.Literal("verify-canonical-activity", "FIXTURE_RELEASE_OPERATION");
  const directory = yield* ReleaseConfig.String("RUNNER_TEMP");

  const { opening, activity, reference, recovery } = yield* Schema.decodeUnknownEffect(
    CanonicalActivity
  )(yield* readFile(directory + "/native-canonical-observations.json"));

  const userNamespace = yield* currentCanonicalActivity(env, client, { port, opening });
  const post = yield* readUserObjects(accountReader(env, client), userNamespace);

  const maintenanceNamespace = Object.entries(opening.namespaces).find(
    ([, owner]) => owner === "Maintenance"
  )?.[0];

  if (
    Option.isNone(addedSignupStore({ objects: post, prior: opening.usersBefore })) ||
    maintenanceNamespace === undefined
  ) {
    return yield* new ReleaseFailure({
      message:
        "Ordinary provider completion lacks one new native User Store or exact Maintenance namespace",
    });
  }

  const digest = new Bun.CryptoHasher("sha256")
    .update(activity.signupDigest)
    .update(signupUserCensus(post).sha256)
    .digest("hex");

  yield* writeFile(
    env.smokeAttestationFile + ".canonical-activity",
    encodeJson({
      ...opening,
      openingArtifact: reference.artifactId,
      openingSha256: reference.sha256,
      signup: {
        provider: activity.provider,
        verification: activity.provider === "ordinary" ? "operator-confirmed" : "provider-log",
        outcome: "created",
        synthetic: false,
        origin: installedOrigins.production.api,
        coreVersion: opening.workers[installationNames.Core].version,
        userNamespace,
        proof: { kind: "new-userstore", digest },
      },
      background: activity.background,
      recovery: {
        owner: "Maintenance",
        namespace: maintenanceNamespace,
        outcome: "recovered",
        ...recovery,
      },
    })
  );
});

const stageCapturedPair = Effect.fn(function* (input: {
  env: Config;
  client: HttpClient.HttpClient;
  port: ReleasePort;
  snapshot: typeof releaseSchemas.snapshot.Type;
  candidate: Effect.Success<typeof uploadedNativePair>;
}) {
  const { env, client, port, snapshot, candidate } = input;
  yield* storageCompatibility({ env, client }, { snapshot, ...candidate }, "stage");
  yield* writeFile(
    env.file,
    encodeJson(yield* releaseController.stageRelease(port, snapshot, candidate))
  );
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
  const candidate = yield* uploadedNativePair;
  yield* stageCapturedPair({ env, client, port, snapshot, candidate });
});

const successorSource = Effect.gen(function* () {
  yield* ReleaseConfig.Literal("true", "GITHUB_ACTIONS");
  yield* ReleaseConfig.Literal("true", "GITHUB_REF_PROTECTED");
  yield* ReleaseConfig.Literal("workflow_dispatch", "GITHUB_EVENT_NAME");
  yield* ReleaseConfig.Literal("refs/heads/trunk", "GITHUB_REF");
  yield* ReleaseConfig.Literal("1", "GITHUB_RUN_ATTEMPT");
  yield* ReleaseConfig.Literal("closed", "NATIVE_STORAGE_ADMISSION");
  yield* ReleaseConfig.Literal("acceptance", "NATIVE_STORAGE_HOSTS");
  yield* ReleaseConfig.Literals(
    ["stage-fixture-successor", "recover-fixture-successor", "rollout-fixture-successor"],
    "FIXTURE_RELEASE_OPERATION"
  );
  yield* ReleaseConfig.Literal(
    "B4rz99/fidy-ai/.github/workflows/native-fixture-successor-plan.yml@refs/heads/trunk",
    "GITHUB_WORKFLOW_REF"
  );
  const directory = yield* ReleaseConfig.String("RUNNER_TEMP");

  const source = yield* Schema.decodeUnknownEffect(SuccessorSource)(
    yield* readFile(directory + "/fixture-successor-source.json")
  );

  const fingerprint = yield* expectedFixtureSigner;

  if (fingerprint !== source.signerSha256 || fingerprint !== fixtureUpload.fingerprint) {
    return yield* new ReleaseFailure({
      message: "Successor signer differs from the reviewed plan",
    });
  }

  return { directory, source, fingerprint };
});

const requireSuccessorCapture = Effect.fn(function* (
  env: Config,
  snapshot: typeof releaseSchemas.snapshot.Type
) {
  const authorized = yield* successorSource;
  const { source } = authorized;

  if (
    env.revision !== source.revision ||
    snapshot.revision !== source.revision ||
    snapshot.stableRevision !== source.previousRevision ||
    snapshot.core.stableVersionId !== source.stableCoreVersion ||
    snapshot.core.deploymentId !== source.stableCoreDeployment ||
    snapshot.public.stableVersionId !== source.stableIngressVersion ||
    snapshot.public.deploymentId !== source.stableIngressDeployment
  ) {
    return yield* new ReleaseFailure({
      message: "Captured successor predecessor differs from the approved plan",
    });
  }

  return authorized;
});

const verifySuccessorSource = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  snapshot: typeof releaseSchemas.snapshot.Type
) {
  const { source } = yield* requireSuccessorCapture(env, snapshot);
  const port = releasePort({ env, client });
  yield* verifyRetainedProvider(env, client, port);
  yield* requireCapturedSupport(port, {
    versionId: source.oldSmokeVersionId,
    deploymentId: source.oldSmokeDeploymentId,
  });
  yield* requireClosedAdmission(client);
  yield* requireClosedIngressDomains(accountReader(env, client));
  yield* recordSourceControls(env, client, {
    replacing: true,
    pair: {
      revision: snapshot.stableRevision,
      ingress: snapshot.public.stableVersionId,
      core: snapshot.core.stableVersionId,
      proof: env.smokeProof,
    },
  });
});

const captureSuccessor = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* ReleaseConfig.Literal("stage-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  yield* successorSource;
  yield* captureNative(env, client, port);

  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );

  yield* verifySuccessorSource(env, client, snapshot);
});

const ResumedSuccessor = Schema.Struct({
  verifierRevision: SmokeIdentity.fields.gitRevision,
  supportVerifierRevision: SmokeIdentity.fields.gitRevision,
  supportArtifact: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/u)),
  supportSha256: SmokeIdentity.fields.contractDigest,
  coreVersionId: Schema.Literal("ba7f02c9-89fa-4990-8484-42b698854d3d"),
  publicVersionId: Schema.Literal("a0339369-cd2e-4ebc-ad4e-c849c14cd836"),
  reseal: Schema.optionalKey(
    Schema.Struct({
      artifactId: Schema.Literal("14673926918"),
      sha256: Schema.Literal("f5df86d3d6c140f73f3e70367a658434e797220c690e0bcb9e2cd40435036dcc"),
    })
  ),
});

const resumedSuccessor = Effect.gen(function* () {
  const resumed = yield* ReleaseConfig.Boolean("FIXTURE_SUCCESSOR_RESUME").pipe(
    ReleaseConfig.withDefault(false)
  );

  if (!resumed) return Option.none();
  const dir = yield* ReleaseConfig.String("RUNNER_TEMP");
  const expectedVerifier = yield* ReleaseConfig.String("GITHUB_SHA");

  const resume = yield* Schema.decodeUnknownEffect(ResumedSuccessor, {
    onExcessProperty: "error",
  })(yield* readFile(dir + "/fixture-successor-resume.json"));

  if (resume.verifierRevision !== expectedVerifier) {
    return yield* new ReleaseFailure({
      message: "Resumed stage approval came from another verifier",
    });
  }

  return Option.some(resume);
});

const stageSuccessor = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* ReleaseConfig.Literal("stage-fixture-successor", "FIXTURE_RELEASE_OPERATION");

  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );

  yield* verifySuccessorSource(env, client, snapshot);
  const candidate = yield* uploadedNativePair;
  const resume = yield* resumedSuccessor;

  if (Option.isSome(resume)) {
    if (
      candidate.coreVersionId !== resume.value.coreVersionId ||
      candidate.publicVersionId !== resume.value.publicVersionId
    ) {
      return yield* new ReleaseFailure({
        message: "Recovered upload receipts differ from the interrupted pair",
      });
    }

    yield* successorResources({
      env,
      client,
      release: candidate,
      generation: env.revision,
      fingerprint: yield* expectedFixtureSigner,
    });
  }

  yield* writeFile(env.file + ".uploads", encodeJson(candidate));
  yield* stageCapturedPair({ env, client, port, snapshot, candidate });
});

const successorResources = Effect.fn(function* (input: {
  env: Config;
  client: HttpClient.HttpClient;
  release: Pick<FallbackStage["release"], "coreVersionId" | "publicVersionId">;
  fingerprint: string;
  generation: string;
}) {
  const { env, client, release, fingerprint, generation } = input;
  const port = releasePort({ env, client });
  const smokeName = "fidy-native-smoke-" + generation;
  const smoke = yield* port.current(smokeName);
  const versionId = yield* releaseController.servingVersion(smoke);

  yield* Effect.forEach(
    [
      ["Core", installationNames.Core, release.coreVersionId],
      ["Ingress", installationNames.Ingress, release.publicVersionId],
      ["Smoke", smokeName, versionId],
    ] as const,
    Effect.fnUntraced(function* ([role, name, id]) {
      const raw = yield* releaseEvidence.readWorkerVersion(env, client, { name, id });
      yield* Effect.try(() =>
        verifySuccessorVersionAt({
          role,
          raw,
          account: env.account,
          revision: role === "Smoke" ? generation : env.revision,
          versionId: id,
          fingerprint,
          generation,
        })
      );
      yield* verifyReleaseObservability(env, name, client);
    }),
    { discard: true }
  );

  yield* proveRecoveryCorePrivate(env, client, smokeName);
  yield* proveRecoveryCorePrivate(env, client, installationNames.Core);
  yield* inspectInstalledResources(env, client, fixtureUpload.revision);
  yield* inspectInstalledResources(env, client, generation);

  return { versionId, deploymentId: smoke.id };
});

const verifyStagedSuccessor = Effect.fn(function* (input: {
  env: Config;
  client: HttpClient.HttpClient;
  release: FallbackStage["release"];
  fingerprint: string;
  source: typeof SuccessorSource.Type;
}) {
  const { env, client, release, fingerprint, source } = input;
  yield* verifySuccessorSource(env, client, release.snapshot);
  yield* storageCompatibility({ env, client }, release, "stage");
  const deployed = yield* deployedStorage({ env, client, release });
  const namespaces = fallbackNamespaces(deployed.descriptions.candidate.namespaces);

  if (!isDeepStrictEqual(Object.values(namespaces), source.namespaces)) {
    return yield* new ReleaseFailure({ message: "Successor namespace identities changed" });
  }

  yield* verifyInstalledNamespaces({
    env,
    client,
    storage: deployed.descriptions.candidate,
    workers: [deployed.core.candidate, deployed.ingress.candidate],
  });
  yield* inspectDeployedEdge(env, client, {
    installed: true,
    bindings: deployed.core.candidate.bindings,
    hosts: "acceptance",
    staging: false,
  });

  const smoke = yield* successorResources({
    env,
    client,
    release,
    fingerprint,
    generation: env.revision,
  });

  yield* probePromotionPairs({ env, client }, release, {
    descriptions: deployed.descriptions,
    probeOriginal: true,
  });

  const candidate = {
    revision: env.revision,
    ingress: release.publicVersionId,
    core: release.coreVersionId,
    proof: env.smokeProof,
  };

  yield* observeDormantPair(client, candidate, false);
  const digest = yield* controlsDigest(candidate, acceptanceSend(client));

  if (digest !== fixtureUpload.controlsDigest) {
    return yield* new ReleaseFailure({ message: "Successor financial control histories differ" });
  }

  return { smoke, namespaces, controlsDigest: digest };
});

const sealSuccessor = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  yield* ReleaseConfig.Literal("stage-fixture-successor", "FIXTURE_RELEASE_OPERATION");

  const release = yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(
    yield* readFile(env.file)
  );

  const { directory, source, fingerprint } = yield* requireSuccessorCapture(env, release.snapshot);

  const approval = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      artifactId: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/u)),
      sha256: SmokeIdentity.fields.contractDigest,
    })
  )(yield* readFile(directory + "/fixture-successor-approval.json"));

  const resume = yield* resumedSuccessor;

  const reseal = yield* ReleaseConfig.Boolean("FIXTURE_SUCCESSOR_RESEAL").pipe(
    ReleaseConfig.withDefault(false)
  );

  const resumedReseal = Option.isSome(resume) && resume.value.reseal !== undefined;

  if (reseal !== resumedReseal) {
    return yield* new ReleaseFailure({ message: "Unexpected verification-only successor lineage" });
  }

  const verified = yield* verifyUnpromotedFallback({
    port: releasePort({ env, client }),
    release,
    verify: verifyStagedSuccessor({ env, client, release, fingerprint, source }),
  });

  const resumeEvidence = Option.match(resume, {
    onNone: () => ({}),
    onSome: (value) => ({ resume: value }),
  });

  yield* writeFile(
    directory + "/native-fixture-successor-stage.json",
    encodeJson({
      revision: env.revision,
      stableRevision: source.previousRevision,
      release,
      ...verified,
      provider: retainedProvider,
      fixtureMember: "performance-2",
      approval,
      predecessor: source,
      ...resumeEvidence,
    })
  );
});

const SuccessorArtifact = Schema.Struct({ artifactId: artifactNumber, sha256: evidenceDigest });

const SuccessorStage = Schema.Struct({
  ...FallbackStage.fields,
  fixtureMember: Schema.Literal("performance-2"),
  approval: SuccessorArtifact,
  predecessor: SuccessorSource,
  resume: Schema.optionalKey(ResumedSuccessor),
});

const RecoveredSuccessor = Schema.Struct({
  stage: SuccessorStage,
  seal: SuccessorArtifact,
  promoted: RollbackReceipt.fields.promoted,
});

const readSuccessorSeal = Effect.fn(function* (env: Config) {
  const { directory, source, fingerprint } = yield* successorSource;

  const stage = yield* Schema.decodeUnknownEffect(SuccessorStage)(
    yield* readFile(directory + "/native-fixture-successor-stage.json")
  );

  const seal = yield* Schema.decodeUnknownEffect(SuccessorArtifact)(
    yield* readFile(directory + "/fixture-successor-seal-reference.json")
  );

  const artifacts = yield* fixtureArtifacts(env.revision);

  if (
    artifacts.resourceRevision !== stage.revision ||
    !isDeepStrictEqual(source, stage.predecessor) ||
    !isDeepStrictEqual(stage.provider, retainedProvider) ||
    stage.controlsDigest !== fixtureUpload.controlsDigest
  ) {
    return yield* new ReleaseFailure({
      message: "Sealed dormant successor differs from protected evidence",
    });
  }

  yield* requireSuccessorCapture({ ...env, revision: stage.revision }, stage.release.snapshot);

  return { directory, stage, seal, source, fingerprint };
});

const verifyRecoveredSuccessor = Effect.fn(function* (input: {
  env: Config;
  client: HttpClient.HttpClient;
  stage: typeof SuccessorStage.Type;
  fingerprint: string;
}) {
  const { env, client, stage, fingerprint } = input;
  const port = releasePort({ env, client });
  yield* verifyRetainedProvider(env, client, port);
  yield* requireCapturedSupport(port, {
    versionId: stage.predecessor.oldSmokeVersionId,
    deploymentId: stage.predecessor.oldSmokeDeploymentId,
  });
  yield* requireClosedAdmission(client);
  yield* requireClosedIngressDomains(accountReader(env, client));

  const smoke = yield* successorResources({
    env: { ...env, revision: stage.revision },
    client,
    release: stage.release,
    generation: stage.revision,
    fingerprint,
  });

  if (!isDeepStrictEqual(smoke, stage.smoke)) {
    return yield* new ReleaseFailure({
      message: "Successor technical smoke differs from the sealed stage",
    });
  }
});

const recoverSuccessor = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  yield* ReleaseConfig.Literal("recover-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  const { directory, seal, stage, source, fingerprint } = yield* readSuccessorSeal(env);
  const port = releasePort({ env, client });

  const verified = yield* verifyUnpromotedFallback({
    port,
    release: stage.release,
    verify: verifyStagedSuccessor({ env, client, release: stage.release, source, fingerprint }),
  });

  if (
    !isDeepStrictEqual(verified.smoke, stage.smoke) ||
    !isDeepStrictEqual(verified.namespaces, stage.namespaces) ||
    verified.controlsDigest !== stage.controlsDigest
  ) {
    return yield* new ReleaseFailure({
      message: "Zero-traffic successor no longer matches its seal",
    });
  }

  const pair = {
    revision: env.revision,
    ingress: stage.release.publicVersionId,
    core: stage.release.coreVersionId,
    proof: env.smokeProof,
  };

  const promoted = yield* recoverFixtureFallback(port, stage, (_stage, phase) =>
    Effect.gen(function* () {
      yield* verifyRecoveredSuccessor({ env, client, stage, fingerprint });
      yield* observeDormantPair(client, pair, phase === "after").pipe(
        Effect.retry({ times: 8, schedule: Schedule.spaced("10 seconds") })
      );

      if ((yield* controlsDigest(pair, acceptanceSend(client))) !== stage.controlsDigest) {
        return yield* new ReleaseFailure({
          message: "Dormant successor financial controls changed",
        });
      }
    })
  );

  yield* writeFile(
    directory + "/native-fixture-successor-recovered.json",
    encodeJson({ stage, seal, promoted })
  );
});

const verifySuccessorReturnSource = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  snapshot: typeof releaseSchemas.snapshot.Type
) {
  yield* ReleaseConfig.Literal("rollout-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  const { directory, seal, stage, fingerprint } = yield* readSuccessorSeal(env);

  const recovered = yield* Schema.decodeUnknownEffect(RecoveredSuccessor)(
    yield* readFile(directory + "/native-fixture-successor-recovered.json")
  );

  if (
    !isDeepStrictEqual(recovered.stage, stage) ||
    !isDeepStrictEqual(recovered.seal, seal) ||
    snapshot.revision !== env.revision ||
    snapshot.stableRevision !== stage.revision ||
    snapshot.core.deploymentId !== recovered.promoted.coreDeploymentId ||
    snapshot.public.deploymentId !== recovered.promoted.publicDeploymentId
  ) {
    return yield* new ReleaseFailure({
      message: "Active successor did not start from the verified recovery",
    });
  }

  const port = releasePort({ env, client });
  yield* requirePromotedDormantSource(port, snapshot, stage.release);
  yield* verifyRecoveredSuccessor({ env, client, stage, fingerprint });
  yield* observeDormantPair(
    client,
    {
      revision: stage.revision,
      ingress: snapshot.public.stableVersionId,
      core: snapshot.core.stableVersionId,
      proof: env.smokeProof,
    },
    true
  );
});

const captureSuccessorRollout = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* ReleaseConfig.Literal("rollout-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  yield* captureNative(env, client, port);
  yield* verifyStorageUpload(env, client, port);
  yield* verifyInstalledWebsite(client, fixtureUpload.revision, installedOrigins.acceptance);
});

const stageSuccessorRollout = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* ReleaseConfig.Literal("rollout-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  yield* verifyStorageUpload(env, client, port);

  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );

  const candidate = yield* uploadedNativePair;
  yield* writeFile(env.file + ".uploads", encodeJson(candidate));
  yield* stageCapturedPair({ env, client, port, snapshot, candidate });
});

const promoteSuccessor = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReleasePort
) {
  yield* ReleaseConfig.Literal("rollout-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  const { stage, directory, fingerprint } = yield* readSuccessorSeal(env);

  const recovered = yield* Schema.decodeUnknownEffect(RecoveredSuccessor)(
    yield* readFile(directory + "/native-fixture-successor-recovered.json")
  );

  const release = yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(
    yield* readFile(env.file)
  );

  const expected = {
    revision: env.revision,
    stableRevision: stage.revision,
    core: {
      name: installationNames.Core,
      deploymentId: recovered.promoted.coreDeploymentId,
      stableVersionId: stage.release.coreVersionId,
    },
    public: {
      name: installationNames.Ingress,
      deploymentId: recovered.promoted.publicDeploymentId,
      stableVersionId: stage.release.publicVersionId,
    },
  };

  const { stableContractDigest: _stableContractDigest, ...coordinates } = release.snapshot;

  if (!isDeepStrictEqual(stage, recovered.stage) || !isDeepStrictEqual(coordinates, expected)) {
    return yield* new ReleaseFailure({
      message: "Staged successor differs from its authorized return pair",
    });
  }

  const smoke = yield* successorResources({
    env,
    client,
    release,
    fingerprint,
    generation: stage.revision,
  });

  if (!isDeepStrictEqual(smoke, stage.smoke)) {
    return yield* new ReleaseFailure({
      message: "Active successor smoke changed before promotion",
    });
  }

  const forward = yield* ReleaseConfig.Boolean("FIXTURE_ACCOUNTING_FORWARD").pipe(
    ReleaseConfig.withDefault(false)
  );

  if (forward) return yield* finishAccountingPromotion({ env, client, port, release, directory });
  yield* promoteClosed(env, client, port);
});

const finishAccountingPromotion = Effect.fn(function* ({
  env,
  client,
  port,
  release,
  directory,
}: {
  env: Config;
  client: HttpClient.HttpClient;
  port: ReleasePort;
  release: typeof releaseSchemas.staged.Type;
  directory: string;
}) {
  if (env.revision !== stagedAccountingRevision) {
    return yield* new ReleaseFailure({ message: "Unexpected interrupted accounting revision" });
  }

  const { coreDeploymentId } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      artifactId: Schema.Literal("14681664304"),
      sha256: SmokeIdentity.fields.contractDigest,
      coreDeploymentId: SmokeIdentity.fields.workerVersionId,
    }),
    { onExcessProperty: "error" }
  )(yield* readFile(directory + "/fixture-successor-accounting-forward.json"));

  const [current, staged] = yield* releasePort({ env, client }).recentDeployments(
    release.snapshot.core.name
  );

  if (current?.id !== coreDeploymentId || staged?.id !== release.coreDeploymentId) {
    return yield* new ReleaseFailure({ message: "Interrupted accounting Core history changed" });
  }

  const { rollback } = yield* storageCompatibility({ env, client }, release, "stage");

  if (!rollback) {
    return yield* new ReleaseFailure({ message: "Interrupted accounting return pair changed" });
  }

  const { descriptions } = yield* deployedStorage({ env, client, release });
  yield* probePromotionPairs({ env, client }, release, { descriptions, probeOriginal: false });
  const promoted = yield* releaseController.finishIngressPromotion(port, release, coreDeploymentId);
  yield* writeFile(env.file + ".promoted", encodeJson({ release, promoted, rollbackTested: true }));
});

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

const rollbackCheck =
  (phase: string) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    operation.pipe(
      Effect.tapCause((cause) =>
        Effect.logError("Rollback failed at " + phase + ": " + resourceFailureMessage(cause))
      )
    );

const readRollbackReceipt = Effect.fn(function* (env: Config) {
  return yield* Schema.decodeUnknownEffect(
    Schema.Struct({ ...RollbackReceipt.fields, rollbackTested: Schema.Literal(true) })
  )(yield* readFile(env.file + ".promoted"));
});

const verifyRestoredNative = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  {
    port,
    release,
    routing,
  }: {
    port: ReleasePort;
    release: typeof RollbackReceipt.Type.release;
    routing: "ordinary" | "pinned";
  }
) {
  const restored = yield* readStablePair(
    {
      port,
      workers: yield* nativeWorkerReceipts("capture"),
      proof: env.smokeProof,
      client,
    },
    origin
  ).pipe(rollbackCheck("serving identities"));

  if (
    restored.publicStable !== release.snapshot.public.stableVersionId ||
    restored.coreStable !== release.snapshot.core.stableVersionId ||
    restored.identity.stableRevision !== release.snapshot.stableRevision
  ) {
    return yield* new ReleaseFailure({
      message: "Restored version identity differs; inspect current traffic",
    });
  }

  yield* requireClosedAdmission(client).pipe(rollbackCheck("closed admission"));

  if ((yield* expectedFixtureSigner) !== "") {
    const pair = {
      revision: restored.identity.stableRevision,
      ingress: restored.publicStable,
      core: restored.coreStable,
      proof: env.smokeProof,
    };

    yield* observeDormantPair(client, pair, true).pipe(
      Effect.retry({ times: 12, schedule: Schedule.spaced("25 seconds") }),
      rollbackCheck("restored Durable Object markers")
    );
    yield* originalControlEvidence(env, client, { ...pair, routing }).pipe(
      rollbackCheck("retained financial controls")
    );
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

const rollbackNative = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReturnType<typeof releasePort>
) {
  const receipt = yield* readRollbackReceipt(env).pipe(rollbackCheck("promotion receipt"));
  yield* releaseController
    .requireTrunk(port, receipt.release.snapshot.revision)
    .pipe(rollbackCheck("protected source"));

  const eligible = yield* storageCompatibility({ env, client }, receipt.release, "rollback").pipe(
    rollbackCheck("compatibility")
  );

  yield* releaseRollback
    .restore(releaseEvidence.rollbackPort(port, env, client), {
      ...receipt,
      compatible: eligible.rollback,
    })
    .pipe(rollbackCheck("guarded Ingress and Core restoration"));
  yield* verifyRestoredNative(env, client, { port, release: receipt.release, routing: "pinned" });
});

const verifyRestoredPairing = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  {
    port,
    release,
    positions,
  }: {
    port: ReleasePort;
    release: typeof RollbackReceipt.Type.release;
    positions: typeof RollbackReceipt.Type.promoted;
  }
) {
  const { descriptions } = yield* deployedStorage({ env, client, release }).pipe(
    rollbackCheck("sealed storage description")
  );

  yield* verifyInstalledMarkers({
    env,
    client,
    pair: {
      publicStable: release.snapshot.public.stableVersionId,
      coreStable: release.snapshot.core.stableVersionId,
    },
    storage: descriptions.serving,
  }).pipe(rollbackCheck("ordinary schema markers"));
  yield* verifyRestoredNative(env, client, { port, release, routing: "ordinary" });

  yield* Effect.forEach(
    ["core", "public"] as const,
    (role) =>
      releaseController
        .requireCapturedWorker(port, {
          ...release.snapshot[role],
          deploymentId: positions[`${role}DeploymentId`],
        })
        .pipe(rollbackCheck("restored " + role + " deployment identity")),
    { discard: true }
  );

  yield* writeFile(env.file + ".restored-deployments", encodeJson(positions));
});

const resumeNativeRollback = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  port: ReturnType<typeof releasePort>
) {
  yield* ReleaseConfig.Literal("resume-pairing-rollback", "FIXTURE_RELEASE_OPERATION");
  const seal = yield* pairingSeal().pipe(rollbackCheck("protected dormant seal"));

  if (
    Option.isNone(seal) ||
    Option.isNone(yield* fixtureVerifier) ||
    (yield* fixtureBuild) !== "fallback"
  ) {
    return yield* new ReleaseFailure({
      message: "Partial rollback requires the protected dormant seal",
    });
  }

  const receipt = yield* readRollbackReceipt(env).pipe(rollbackCheck("archived promotion receipt"));

  const position = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ ingressDeploymentId: SmokeIdentity.fields.workerVersionId })
  )(yield* readFile(env.file + ".rollback-position")).pipe(
    rollbackCheck("recorded Ingress position")
  );

  yield* requireClosedAdmission(client).pipe(rollbackCheck("closed admission"));
  yield* requireClosedIngressDomains(accountReader(env, client)).pipe(
    rollbackCheck("closed ingress domains")
  );
  yield* verifyRetainedProvider(env, client, port).pipe(rollbackCheck("retained provider"));
  yield* requireCapturedSupport(port, seal.value.smoke).pipe(
    rollbackCheck("sealed support Workers")
  );

  const eligible = yield* storageCompatibility({ env, client }, receipt.release, "rollback").pipe(
    rollbackCheck("compatibility")
  );

  if (!eligible.rollback) {
    return yield* new ReleaseFailure({
      message: "Sealed Core rollback compatibility no longer holds",
    });
  }

  const core = yield* resumePairingRollback({
    port: releaseEvidence.rollbackPort(port, env, client),
    receipt,
    ingressDeploymentId: position.ingressDeploymentId,
  }).pipe(rollbackCheck("exact intermediate assignments and Core restoration"));

  yield* verifyRestoredPairing(env, client, {
    port,
    release: receipt.release,
    positions: {
      coreDeploymentId: core.id,
      publicDeploymentId: position.ingressDeploymentId,
    },
  });
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

  if (Exit.isFailure(cleaned)) return yield* Effect.failCause(cleaned.cause);

  if (Exit.isFailure(coverage)) return yield* Effect.failCause(coverage.cause);
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

  if (Exit.isFailure(measured)) return yield* Effect.failCause(measured.cause);
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
  "recover-successor": recoverSuccessor,
  "capture-successor-rollout": captureSuccessorRollout,
  "verify-successor-upload": verifyStorageUpload,
  "stage-successor-rollout": stageSuccessorRollout,
  "promote-successor": promoteSuccessor,
  "capture-successor": captureSuccessor,
  "stage-successor": stageSuccessor,
  "seal-successor": sealSuccessor,
  "resume-pairing-stage": resumePairingStage,
  "resume-pairing-rollback": resumeNativeRollback,
  "seal-fallback": sealFallback,
  "reseal-fallback": resealFallback,
  "diagnose-pairing": diagnosePairing,
  "forward-fallback": forwardFallback,
  "ten-prepare": tenCommand("ten-prepare"),
  "ten-hosted": tenCommand("ten-hosted"),
  "continue-ten-cleanup": tenCommand("continue-ten-cleanup"),
  "fleet-pilot": fleetVerification("fleet-pilot"),
  "continue-fleet-cleanup": fleetVerification("continue-fleet-cleanup"),
  "verify-canonical-activity": verifyCanonicalActivity,
  "capture-canonical-signup": captureCanonicalSignup,
  "stage-canonical-signup": targetSignupCandidates,
  "promote-canonical-signup": promoteCanonicalSignup,
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
        "recover-successor",
        "capture-successor-rollout",
        "verify-successor-upload",
        "stage-successor-rollout",
        "promote-successor",
        "capture-successor",
        "stage-successor",
        "seal-successor",
        "resume-pairing-stage",
        "resume-pairing-rollback",
        "seal-fallback",
        "reseal-fallback",
        "diagnose-pairing",
        "forward-fallback",
        "ten-prepare",
        "ten-hosted",
        "continue-ten-cleanup",
        "fleet-pilot",
        "continue-fleet-cleanup",
        "verify-canonical-activity",
        "capture-canonical-signup",
        "stage-canonical-signup",
        "promote-canonical-signup",
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

  BunRuntime.runMain(
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
