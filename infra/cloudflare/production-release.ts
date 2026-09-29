/// <reference types="bun-types" />

import { Cause, Context, Data, Effect, Encoding, Layer, Option, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import {
  SmokeIdentity,
  SmokeRequest,
  SmokeResponse,
  smokePath,
} from "../../apps/server/cloudflare/runtime/smoke";
import { releaseCleanup } from "./release-cleanup";
import { type RollbackPort, RollbackReceipt, releaseRollback } from "./release-rollback";
import { type WorkerResources, rollbackCompatible } from "./rollback-compatibility";
import {
  type Deployment,
  type ReleasePort,
  type ReleaseSnapshot,
  releaseController,
  releaseSchemas,
} from "./release-controller";

const VersionId = SmokeIdentity.fields.workerVersionId;
const WorkerName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u));
const ApiDeployment = Schema.Struct({
  id: VersionId,
  versions: Schema.Array(Schema.Struct({ version_id: VersionId, percentage: Schema.Finite })),
});
const ListResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ deployments: Schema.Array(ApiDeployment) }),
});
const CreateResponse = Schema.Struct({ success: Schema.Literal(true), result: ApiDeployment });
const DeployableResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ items: Schema.Array(Schema.Struct({ id: VersionId })) }),
});
const VersionResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: VersionId,
    resources: Schema.Struct({
      bindings: Schema.Record(Schema.String, Schema.Unknown),
      script_runtime: Schema.Struct({
        migration_tag: Schema.optional(Schema.String),
        exports: Schema.Record(Schema.String, Schema.Unknown),
      }),
    }),
  }),
});
const ResourceIdentity = Schema.Struct({ logicalId: Schema.String });
const ResourceLifecycle = Schema.Struct({
  status: Schema.Literals([
    "creating",
    "created",
    "updating",
    "updated",
    "deleting",
    "replacing",
    "replaced",
  ]),
});
const stableWorkerReceiptStatuses = new Set(["created", "updated", "replaced"]);
// Alchemy `replaced` carries the successfully created generation's attrs; only the old
// generation is pending garbage collection. Capture still independently verifies live traffic.
const ResourceAttributes = Schema.Record(Schema.String, Schema.Unknown);
const WorkerIdentity = Schema.Struct({ workerName: WorkerName });
const StateEntry = Schema.Struct({
  logicalId: Schema.String,
  status: Schema.Literals(["created", "updated", "replaced"]),
  attr: ResourceAttributes,
});
// Interrupted updates retain both the current output and the last-applied output. Capture may
// use them only when their Worker identities agree; completed-receipt consumers reject updates.
const UpdatingStateEntry = Schema.Struct({
  logicalId: Schema.String,
  status: Schema.Literal("updating"),
  attr: ResourceAttributes,
  old: Schema.Struct({ attr: ResourceAttributes }),
});
const StateMap = Schema.Record(Schema.String, Schema.Unknown);
const Commands = Schema.Literals([
  "capture",
  "bootstrap-capture",
  "bootstrap-verify",
  "stage",
  "promote",
  "rollback",
  "cleanup",
  "report",
  "inspect",
  "recover-core",
  "resume-capture",
  "verify-staged",
]);
const SmokeAttestation = Schema.Struct({
  revision: SmokeIdentity.fields.gitRevision,
  publicVersionId: VersionId,
  coreVersionId: VersionId,
});
const healthSchema = Schema.Struct({
  status: Schema.Literal("available"),
  gitRevision: SmokeIdentity.fields.gitRevision,
  contractDigest: SmokeIdentity.fields.contractDigest,
});
const smokeResultSchema = Schema.Struct({ ...SmokeResponse.fields, public: SmokeIdentity });
const responseLimit = 100_000;
const successStatusStart = 200;
const successStatusEnd = 300;
const probeEntropyBytes = 16;
const inspectionHistoryLimit = 5;
const origin = "https://api.fidyapp.com";
const preSmokeRevision = "b71c2248e4667ffa042fd00c286a2c2240436475";
const preSmokeDigest = "f33c9633df9fdfe0dbb730156fe9083dc4d0f676648a27d102f73bc98262fd4f";
// One-time recovery receipt from inspected Production runs 36588418380 and 36594005666.
const interruptedPromotion = {
  revision: "2d65bde42f81b5c4af377e433100a7500bec0a5b",
  publicDeployment: "e1f796e7-ccb4-41f0-96b2-8d0d3d74feb0",
  publicVersion: "90b1cd6a-4796-41bf-ae33-fb3333a3fff0",
  coreDeployment: "0d731332-605d-47bf-976d-69963275b40e",
  coreCandidate: "deee8a6c-ace3-4f50-b589-7729605031df",
  coreStable: "28ffd738-508a-4d00-a3e1-31911f86ce01",
} as const;
const interruptedUpload = {
  ...interruptedPromotion,
  publicDeployment: "4eae3224-b347-4ccc-8715-17389919e0f6",
  coreRecoveredDeployment: "8cd6309b-859a-424a-bc05-e206e5c24922",
  publicCandidate: "7b83226f-3fbe-4d2f-99e8-72d7f818375f",
  coreCandidate: "89a2da14-0f1b-4c8a-8eba-ed39b19d6b62",
} as const;

/** The one-time direct bootstrap must never use a later, unverified Production baseline. */
export const isPreSmokeBaseline = (health: {
  gitRevision: string;
  contractDigest: string;
}): boolean => health.gitRevision === preSmokeRevision && health.contractDigest === preSmokeDigest;
class ReleaseFailure extends Data.TaggedError("ReleaseFailure")<{ message: string }> {}

/** CLI failures report only owned release messages, never foreign errors or provider values. */
export const releaseFailureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && error.value instanceof ReleaseFailure
    ? error.value.message
    : "Production release routing failed; inspect Worker deployment state before recovery.";
};

type ResumeStage = "receipts" | "routing" | "identity" | "drift" | "trunk" | "recapture";
const resumeStage = <A, E, R>(
  stage: ResumeStage,
  work: Effect.Effect<A, E, R>
): Effect.Effect<A, ReleaseFailure, R> =>
  work.pipe(
    Effect.mapError(
      () => new ReleaseFailure({ message: `Production reconciliation failed: stage=${stage}` })
    )
  );
const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(Json);
const encodeJson = Schema.encodeSync(Json);

type Config = Readonly<{
  account: string;
  token: string;
  revision: string;
  repository: string;
  githubToken: string;
  file: string;
  smokeProof: string;
  smokeAttestationFile: string;
  contractDigest: Option.Option<string>;
  bootstrapRelease: boolean;
  resumeRelease: boolean;
}>;
const config = (): Config => {
  const environment = process.env;
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({
      CLOUDFLARE_ACCOUNT_ID: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
      CLOUDFLARE_API_TOKEN: Schema.NonEmptyString,
      RELEASE_GIT_SHA: SmokeIdentity.fields.gitRevision,
      GITHUB_REPOSITORY: Schema.String.check(
        Schema.isPattern(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u)
      ),
      GITHUB_TOKEN: Schema.NonEmptyString,
      RELEASE_SNAPSHOT_FILE: Schema.String.check(Schema.isPattern(/^\//u)),
      SMOKE_ATTESTATION_FILE: Schema.String.check(Schema.isPattern(/^\//u)),
      SMOKE_PROOF: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
      CONTRACT_DIGEST: Schema.optional(SmokeIdentity.fields.contractDigest),
      BOOTSTRAP_RELEASE: Schema.optional(Schema.Literals(["true", "false"])),
      RESUME_RELEASE: Schema.optional(Schema.Literals(["true", "false"])),
    })
  )(environment);
  if (Option.isNone(decoded)) {
    throw Error("Incomplete production release configuration");
  }
  return {
    account: decoded.value.CLOUDFLARE_ACCOUNT_ID,
    token: decoded.value.CLOUDFLARE_API_TOKEN,
    revision: decoded.value.RELEASE_GIT_SHA,
    repository: decoded.value.GITHUB_REPOSITORY,
    githubToken: decoded.value.GITHUB_TOKEN,
    file: decoded.value.RELEASE_SNAPSHOT_FILE,
    smokeProof: decoded.value.SMOKE_PROOF,
    smokeAttestationFile: decoded.value.SMOKE_ATTESTATION_FILE,
    contractDigest: Option.fromUndefinedOr(decoded.value.CONTRACT_DIGEST),
    bootstrapRelease: decoded.value.BOOTSTRAP_RELEASE === "true",
    resumeRelease: decoded.value.RESUME_RELEASE === "true",
  };
};

// Bound the stream before decoding; early termination releases the response stream's scope.
const boundedJson = Effect.fn(function* (response: HttpClientResponse.HttpClientResponse) {
  if (response.status < successStatusStart || response.status >= successStatusEnd) {
    return yield* Effect.fail(Error("Provider rejected the release request"));
  }
  if (Number(response.headers["content-length"] ?? 0) > responseLimit) {
    return yield* Effect.fail(Error("Provider response exceeded limit"));
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* Stream.runForEachWhile(response.stream, (value) =>
    Effect.sync(() => {
      size += value.byteLength;
      if (size > responseLimit) return false;
      chunks.push(value);
      return true;
    })
  ).pipe(Effect.mapError(() => Error("Provider response could not be read within limit")));
  if (size > responseLimit) {
    return yield* Effect.fail(Error("Provider response exceeded limit"));
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return yield* decodeJson(new TextDecoder().decode(bytes));
});
const providerJson = Effect.fn(function* (request: HttpClientRequest.HttpClientRequest) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError(() => Error("Provider request failed; inspect traffic state")));
  return yield* boundedJson(response);
}, Effect.timeout("10 seconds"));
const shell = Effect.fn(function* (args: ReadonlyArray<string>) {
  const child = Bun.spawn([...args], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  const [output, exitCode] = yield* Effect.all([
    Effect.tryPromise({
      try: () => new Response(child.stdout).text(),
      catch: () => new ReleaseFailure({ message: "Release tooling failed" }),
    }),
    Effect.tryPromise({
      try: () => child.exited,
      catch: () => new ReleaseFailure({ message: "Release tooling failed" }),
    }),
  ]);
  if (exitCode !== 0) {
    return yield* Effect.fail(Error("Release tooling failed; inspect traffic state"));
  }
  return output;
});
const readFile = (path: string): Effect.Effect<unknown, Error> =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: () => new ReleaseFailure({ message: "Release snapshot could not be read" }),
  }).pipe(Effect.flatMap(decodeJson));
const writeFile = (path: string | Bun.BunFile, content: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => Bun.write(path, content),
    catch: () => new ReleaseFailure({ message: "Release output could not be written" }),
  }).pipe(Effect.asVoid);

type WorkerReceipt = Readonly<{
  workerName: string;
  versionId: Option.Option<string>;
  hasRolloutBaseline: boolean;
}>;
type WorkerReceipts = Readonly<{ public: WorkerReceipt; core: WorkerReceipt }>;
const workerReceiptMessages = {
  Ingress: {
    missing: "Alchemy Ingress Worker resource is missing",
    ambiguous: "Alchemy Ingress Worker receipt is ambiguous",
    unstable: "Alchemy Ingress Worker lifecycle is unstable",
    incomplete: "Alchemy Ingress Worker receipt is incomplete",
  },
  Core: {
    missing: "Alchemy Core Worker resource is missing",
    ambiguous: "Alchemy Core Worker receipt is ambiguous",
    unstable: "Alchemy Core Worker lifecycle is unstable",
    incomplete: "Alchemy Core Worker receipt is incomplete",
  },
} as const;
const safeWorkerReceiptMessages = new Set<string>([
  ...Object.values(workerReceiptMessages.Ingress),
  ...Object.values(workerReceiptMessages.Core),
]);

const decodeStateMap = (output: string): typeof StateMap.Type => {
  const objectStarts = [...output.matchAll(/\{/gu)].map((match) => match.index);

  for (const index of objectStarts) {
    try {
      return Schema.decodeUnknownSync(StateMap)(JSON.parse(output.slice(index).trim()));
    } catch {
      // Alchemy can write credential-refresh progress before its JSON state. Accept only a
      // complete object matching the state-map schema; never include the output in an error.
    }
  }

  throw Error("Alchemy Worker state output is invalid");
};

const interruptedUpdateAttributes = (
  value: unknown,
  logicalId: "Ingress" | "Core"
): typeof ResourceAttributes.Type => {
  const interrupted = Schema.decodeUnknownOption(UpdatingStateEntry)(value);
  if (Option.isNone(interrupted)) throw Error(workerReceiptMessages[logicalId].incomplete);
  const currentIdentity = Schema.decodeUnknownOption(WorkerIdentity)(interrupted.value.attr);
  const previousIdentity = Schema.decodeUnknownOption(WorkerIdentity)(interrupted.value.old.attr);
  if (
    Option.isNone(currentIdentity) ||
    Option.isNone(previousIdentity) ||
    currentIdentity.value.workerName !== previousIdentity.value.workerName
  ) {
    throw Error(workerReceiptMessages[logicalId].incomplete);
  }
  return interrupted.value.attr;
};

const attributesForReceipt = (
  value: unknown,
  logicalId: "Ingress" | "Core",
  mode: "capture" | "completed"
): typeof ResourceAttributes.Type => {
  const decoded = Schema.decodeUnknownOption(StateEntry)(value);
  if (Option.isSome(decoded)) return decoded.value.attr;
  const lifecycle = Schema.decodeUnknownOption(ResourceLifecycle)(value);
  if (Option.isSome(lifecycle) && lifecycle.value.status === "updating" && mode === "capture") {
    return interruptedUpdateAttributes(value, logicalId);
  }
  if (Option.isSome(lifecycle) && !stableWorkerReceiptStatuses.has(lifecycle.value.status)) {
    throw Error(workerReceiptMessages[logicalId].unstable);
  }
  throw Error(workerReceiptMessages[logicalId].incomplete);
};

const decodeWorkerReceiptsWithMode = (
  output: string,
  mode: "capture" | "completed"
): WorkerReceipts => {
  const entries = decodeStateMap(output);
  const select = (logicalId: "Ingress" | "Core"): WorkerReceipt => {
    const matchingEntries = Object.values(entries).filter((value) => {
      const identity = Schema.decodeUnknownOption(ResourceIdentity)(value);
      return Option.isSome(identity) && identity.value.logicalId === logicalId;
    });
    if (matchingEntries.length === 0) throw Error(workerReceiptMessages[logicalId].missing);
    if (matchingEntries.length !== 1) throw Error(workerReceiptMessages[logicalId].ambiguous);

    const attributes = attributesForReceipt(matchingEntries[0], logicalId, mode);
    const identity = Schema.decodeUnknownOption(WorkerIdentity)(attributes);
    if (Option.isNone(identity)) throw Error(workerReceiptMessages[logicalId].incomplete);
    const rawVersion = Schema.decodeUnknownOption(Schema.Struct({ versionId: VersionId }))(
      attributes
    );
    const baseline = Schema.decodeUnknownOption(
      Schema.Struct({ hash: Schema.Record(Schema.String, Schema.Unknown) })
    )(attributes);
    return {
      workerName: identity.value.workerName,
      versionId: Option.map(rawVersion, (entry) => entry.versionId),
      hasRolloutBaseline: Option.isSome(baseline),
    };
  };
  return { public: select("Ingress"), core: select("Core") };
};

export const decodeWorkerReceipts = (output: string): WorkerReceipts =>
  decodeWorkerReceiptsWithMode(output, "completed");

export const decodeCaptureWorkerReceipts = (output: string): WorkerReceipts =>
  decodeWorkerReceiptsWithMode(output, "capture");

const workersFromState = Effect.fn(function* (mode: "capture" | "completed" = "completed") {
  // Alchemy's persisted upload receipts, not a health response. Never print state: it also
  // contains other resources' binding metadata.
  const rawState = yield* shell([
    "bun",
    "../../node_modules/alchemy/bin/alchemy.ts",
    "state",
    "read",
    "--backend",
    "cloudflare",
    "--recursive",
    "FidyCloudflare/production",
    "--no-input",
    "--log-level",
    "error",
  ]).pipe(
    Effect.mapError(() => new ReleaseFailure({ message: "Alchemy Worker state command failed" }))
  );
  return yield* Effect.try({
    try: () =>
      mode === "capture" ? decodeCaptureWorkerReceipts(rawState) : decodeWorkerReceipts(rawState),
    catch: (cause) =>
      new ReleaseFailure({
        message:
          cause instanceof Error && safeWorkerReceiptMessages.has(cause.message)
            ? cause.message
            : "Alchemy Worker state JSON could not be decoded",
      }),
  });
});

const stableIdentity = Effect.fn(function* (input: {
  publicVersionId: string;
  coreVersionId: string;
  proof: string;
}) {
  const health = yield* Schema.decodeUnknownEffect(healthSchema)(
    yield* providerJson(HttpClientRequest.get(`${origin}/health`))
  );
  const request = yield* Schema.decodeEffect(SmokeRequest)({
    protocolVersion: 1,
    probeId: Encoding.encodeHex(crypto.getRandomValues(new Uint8Array(probeEntropyBytes))),
    expectedPublicVersionId: input.publicVersionId,
    expectedCoreVersionId: input.coreVersionId,
    expectedGitRevision: health.gitRevision,
    expectedContractDigest: health.contractDigest,
  });
  const raw = yield* providerJson(
    HttpClientRequest.post(`${origin}${smokePath}`, {
      headers: { "x-fidy-smoke-proof": input.proof, "content-type": "application/json" },
      body: HttpBody.text(encodeJson(request), "application/json"),
    })
  );
  const observed = yield* Schema.decodeUnknownEffect(smokeResultSchema)(raw);
  const identities = [observed.public, observed.core];
  if (
    observed.public.workerVersionId !== input.publicVersionId ||
    observed.core.workerVersionId !== input.coreVersionId ||
    identities.some(
      (identity) =>
        identity.gitRevision !== health.gitRevision ||
        identity.contractDigest !== health.contractDigest
    )
  ) {
    return yield* Effect.fail(Error("Stable Worker release identities disagree"));
  }
  return { stableRevision: health.gitRevision, stableContractDigest: health.contractDigest };
});

const asDeployment = (value: typeof ApiDeployment.Type): Deployment => ({
  id: value.id,
  versions: value.versions.map((version) => ({
    id: version.version_id,
    percentage: version.percentage,
  })),
});
const createDeployment = Effect.fn(function* (
  json: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<unknown, Error>,
  input: { url: string; token: string; versions: Deployment["versions"] }
) {
  const raw = yield* json(
    HttpClientRequest.post(input.url, {
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: HttpBody.text(
        encodeJson({
          strategy: "percentage",
          versions: input.versions.map((version) => ({
            version_id: version.id,
            percentage: version.percentage,
          })),
        }),
        "application/json"
      ),
    })
  );
  const response = yield* Schema.decodeUnknownEffect(CreateResponse)(raw);
  return asDeployment(response.result);
});
const releasePort = (env: Config, client: HttpClient.HttpClient): ReleasePort => {
  const json = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<unknown, Error> =>
    providerJson(request).pipe(Effect.provideService(HttpClient.HttpClient, client));
  const url = (name: string): string =>
    `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}/deployments`;
  const current: ReleasePort["current"] = (name) =>
    Effect.gen(function* () {
      const raw = yield* json(
        HttpClientRequest.get(url(name), {
          headers: { authorization: `Bearer ${env.token}` },
        })
      );
      const response = yield* Schema.decodeUnknownEffect(ListResponse)(raw);
      const active = response.result.deployments[0];
      if (active === undefined) return yield* Effect.fail(Error(`No active deployment: ${name}`));
      return asDeployment(active);
    });
  return {
    trunk: () =>
      Effect.gen(function* () {
        const raw = yield* json(
          HttpClientRequest.get(`https://api.github.com/repos/${env.repository}/commits/trunk`, {
            headers: {
              authorization: `Bearer ${env.githubToken}`,
              accept: "application/vnd.github+json",
            },
          })
        );
        const response = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ sha: SmokeIdentity.fields.gitRevision })
        )(raw);
        return response.sha;
      }),
    current,
    deploy: (name, versions) =>
      Effect.gen(function* () {
        if (versions.some((version) => version.percentage === 0)) {
          // Cloudflare documents 0% through Wrangler, but its create-deployment API schema
          // specifies a nonzero minimum. Never substitute 0.01%.
          yield* shell([
            "bun",
            "../../node_modules/wrangler/bin/wrangler.js",
            "versions",
            "deploy",
            ...versions.map((version) => `${version.id}@${version.percentage}`),
            "--name",
            name,
            "--yes",
          ]);
          return yield* current(name);
        }
        return yield* createDeployment(json, { url: url(name), token: env.token, versions });
      }),
  };
};

const soleStableVersion = (deployment: Deployment): string => {
  if (deployment.versions.length !== 1 || deployment.versions[0]?.percentage !== 100) {
    throw Error("Production Worker is not fully stable");
  }
  return deployment.versions[0].id;
};
const readStablePair = Effect.fn(function* ({
  port,
  workers,
  proof,
  client,
}: {
  port: ReleasePort;
  workers: WorkerReceipts;
  proof: string;
  client: HttpClient.HttpClient;
}) {
  const publicDeployment = yield* port.current(workers.public.workerName).pipe(
    Effect.mapError(
      () =>
        new ReleaseFailure({
          message: "Release capture could not read stable Worker deployments",
        })
    )
  );
  const coreDeployment = yield* port.current(workers.core.workerName).pipe(
    Effect.mapError(
      () =>
        new ReleaseFailure({
          message: "Release capture could not read stable Worker deployments",
        })
    )
  );
  const publicStable = yield* Effect.try({
    try: () => soleStableVersion(publicDeployment),
    catch: () => new ReleaseFailure({ message: "Unstable public Worker" }),
  });
  const coreStable = yield* Effect.try({
    try: () => soleStableVersion(coreDeployment),
    catch: () => new ReleaseFailure({ message: "Unstable Core Worker" }),
  });
  const identity = yield* stableIdentity({
    publicVersionId: publicStable,
    coreVersionId: coreStable,
    proof,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.mapError(
      () =>
        new ReleaseFailure({ message: "Release capture could not verify the stable Worker pair" })
    )
  );
  return { publicStable, coreStable, identity };
});

const bootstrapCapture = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  const workers = yield* workersFromState("capture");
  const health = yield* Schema.decodeUnknownEffect(healthSchema)(
    yield* providerJson(HttpClientRequest.get(`${origin}/health`)).pipe(
      Effect.provideService(HttpClient.HttpClient, client)
    )
  );
  if (!isPreSmokeBaseline(health)) {
    return yield* new ReleaseFailure({
      message: "Production is not the approved pre-smoke baseline",
    });
  }
  const publicDeployment = yield* port.current(workers.public.workerName);
  const coreDeployment = yield* port.current(workers.core.workerName);
  const publicStable = yield* Effect.try(() => soleStableVersion(publicDeployment));
  const coreStable = yield* Effect.try(() => soleStableVersion(coreDeployment));
  const snapshot = yield* releaseController.captureRelease(port, {
    revision: env.revision,
    stableRevision: health.gitRevision,
    stableContractDigest: health.contractDigest,
    publicName: workers.public.workerName,
    coreName: workers.core.workerName,
  });
  if (
    snapshot.public.stableVersionId !== publicStable ||
    snapshot.core.stableVersionId !== coreStable
  ) {
    return yield* new ReleaseFailure({
      message: "Stable Worker deployments changed during bootstrap capture",
    });
  }
  yield* writeFile(env.file, encodeJson(snapshot));
});

const bootstrapVerify = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );
  if (
    !isPreSmokeBaseline({
      gitRevision: snapshot.stableRevision,
      contractDigest: snapshot.stableContractDigest,
    })
  ) {
    return yield* new ReleaseFailure({ message: "Bootstrap baseline receipt is invalid" });
  }
  const workers = yield* workersFromState();
  if (
    workers.public.workerName !== snapshot.public.name ||
    workers.core.workerName !== snapshot.core.name
  ) {
    return yield* new ReleaseFailure({ message: "Bootstrap Worker identity changed" });
  }
  const pair = yield* readStablePair({ port, workers, proof: env.smokeProof, client });
  if (
    pair.publicStable === snapshot.public.stableVersionId ||
    pair.coreStable === snapshot.core.stableVersionId ||
    pair.identity.stableRevision !== env.revision ||
    pair.identity.stableContractDigest !== Option.getOrElse(env.contractDigest, () => "")
  ) {
    return yield* new ReleaseFailure({
      message: "Bootstrap did not deploy the exact smoke-capable pair",
    });
  }
  yield* writeFile(
    `${env.file}.bootstrap`,
    encodeJson({
      publicName: workers.public.workerName,
      coreName: workers.core.workerName,
      publicVersionId: pair.publicStable,
      coreVersionId: pair.coreStable,
    })
  );
});

const capture = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  const workers = yield* workersFromState("capture");
  // The pinned Alchemy provider falls back to a direct 100% PUT when its previous Worker
  // output has no hash. Never let that branch masquerade as a candidate upload.
  if (!workers.public.hasRolloutBaseline || !workers.core.hasRolloutBaseline) {
    return yield* new ReleaseFailure({
      message: "Release capture blocked: Alchemy Worker rollout baseline is unavailable",
    });
  }
  const stablePair = yield* readStablePair({
    port,
    workers,
    proof: env.smokeProof,
    client,
  });
  const snapshot = yield* releaseController
    .captureRelease(port, {
      revision: env.revision,
      ...stablePair.identity,
      publicName: workers.public.workerName,
      coreName: workers.core.workerName,
    })
    .pipe(
      Effect.mapError(
        () => new ReleaseFailure({ message: "Release capture could not create a stable snapshot" })
      )
    );
  if (
    snapshot.public.stableVersionId !== stablePair.publicStable ||
    snapshot.core.stableVersionId !== stablePair.coreStable
  ) {
    return yield* new ReleaseFailure({
      message: "Stable Worker deployments changed during capture",
    });
  }
  yield* writeFile(env.file, encodeJson(snapshot));
});
export const isInterruptedStableSnapshot = (snapshot: ReleaseSnapshot): boolean => {
  const expected = interruptedUpload;
  return (
    snapshot.stableRevision === expected.revision &&
    snapshot.stableContractDigest === preSmokeDigest &&
    snapshot.public.deploymentId === expected.publicDeployment &&
    snapshot.public.stableVersionId === expected.publicVersion &&
    snapshot.core.deploymentId === expected.coreRecoveredDeployment &&
    snapshot.core.stableVersionId === expected.coreStable
  );
};
export const isInterruptedAlchemyReceipt = (input: {
  workers: WorkerReceipts;
  snapshot: ReleaseSnapshot;
}): boolean => {
  const { workers, snapshot } = input;
  const expected = interruptedUpload;
  return (
    workers.public.workerName === snapshot.public.name &&
    workers.core.workerName === snapshot.core.name &&
    Option.contains(workers.public.versionId, expected.publicCandidate) &&
    Option.contains(workers.core.versionId, expected.coreCandidate) &&
    workers.public.hasRolloutBaseline &&
    workers.core.hasRolloutBaseline
  );
};
export const isInspectedResumePair = (input: {
  publicDeployment: Deployment;
  coreDeployment: Deployment;
}): boolean => {
  const { publicDeployment, coreDeployment } = input;
  return (
    matchesRecoveryVersion({
      deployment: publicDeployment,
      id: interruptedUpload.publicDeployment,
      version: interruptedUpload.publicVersion,
    }) &&
    matchesRecoveryVersion({
      deployment: coreDeployment,
      id: interruptedUpload.coreRecoveredDeployment,
      version: interruptedUpload.coreStable,
    })
  );
};

const readResumePair = Effect.fn(function* (port: ReleasePort, workers: WorkerReceipts) {
  const pair = {
    publicDeployment: yield* port.current(workers.public.workerName),
    coreDeployment: yield* port.current(workers.core.workerName),
  };
  if (!isInspectedResumePair(pair)) {
    return yield* new ReleaseFailure({
      message: "Interrupted-upload routing changed; no recovery write",
    });
  }
  return pair;
});

const resumeCapture = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  if (!env.resumeRelease || env.bootstrapRelease) {
    return yield* new ReleaseFailure({
      message: "Resume requires protected dispatch",
    });
  }
  const workers = yield* resumeStage("receipts", workersFromState());
  const { publicDeployment, coreDeployment } = yield* resumeStage(
    "routing",
    readResumePair(port, workers)
  );
  const identity = yield* resumeStage(
    "identity",
    stableIdentity({
      publicVersionId: interruptedUpload.publicVersion,
      coreVersionId: interruptedUpload.coreStable,
      proof: env.smokeProof,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client))
  );
  const snapshot = yield* Schema.decodeEffect(releaseSchemas.snapshot)({
    revision: env.revision,
    ...identity,
    public: {
      name: workers.public.workerName,
      deploymentId: publicDeployment.id,
      stableVersionId: interruptedUpload.publicVersion,
    },
    core: {
      name: workers.core.workerName,
      deploymentId: coreDeployment.id,
      stableVersionId: interruptedUpload.coreStable,
    },
  });
  if (!isInterruptedStableSnapshot(snapshot)) {
    return yield* new ReleaseFailure({ message: "Interrupted-upload stable Worker pair changed" });
  }
  if (!isInterruptedAlchemyReceipt({ workers, snapshot })) {
    return yield* new ReleaseFailure({ message: "Interrupted-upload Alchemy receipts changed" });
  }
  yield* resumeStage("drift", shell(["bash", "scripts/check-topology-drift.sh", "resume"]));
  if ((yield* resumeStage("trunk", port.trunk())) !== env.revision) {
    return yield* new ReleaseFailure({
      message: "Interrupted-upload baseline changed; no recovery write",
    });
  }
  yield* resumeStage("routing", readResumePair(port, workers));
  // Cleanup committed in run 36631716949; inspection 36632237904 proves this sole-stable pair.
  // Reconcile receipts without another traffic write.
  yield* resumeStage("recapture", capture(port, env, client));
});
const stage = Effect.fn(function* (port: ReleasePort, env: Config) {
  const snapshot = yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(
    yield* readFile(env.file)
  );
  const workers = yield* workersFromState();
  if (
    workers.public.workerName !== snapshot.public.name ||
    workers.core.workerName !== snapshot.core.name ||
    Option.isNone(workers.public.versionId) ||
    Option.isNone(workers.core.versionId)
  ) {
    return yield* Effect.fail(Error("Alchemy candidate receipts are incomplete"));
  }
  const result = yield* releaseController.stageRelease(port, snapshot, {
    publicVersionId: workers.public.versionId.value,
    coreVersionId: workers.core.versionId.value,
  });
  yield* writeFile(env.file, encodeJson(result));
});
const stablePairUnchanged = Effect.fn(function* (port: ReleasePort, snapshot: ReleaseSnapshot) {
  const publicDeployment = yield* port.current(snapshot.public.name);
  const coreDeployment = yield* port.current(snapshot.core.name);
  return (
    soleStableVersion(publicDeployment) === snapshot.public.stableVersionId &&
    soleStableVersion(coreDeployment) === snapshot.core.stableVersionId
  );
});
const cleanup = Effect.fn(function* (port: ReleasePort, env: Config) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(env.file).exists(),
    catch: () => new ReleaseFailure({ message: "Release snapshot unavailable" }),
  });
  if (!exists) return;
  const raw = yield* readFile(env.file);
  const snapshot = Schema.decodeUnknownOption(Schema.Struct({ snapshot: Schema.Unknown }))(raw);
  const original = Option.isSome(snapshot)
    ? (yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(raw)).snapshot
    : yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(raw);
  const workers = yield* workersFromState();
  if (
    workers.public.workerName !== original.public.name ||
    workers.core.workerName !== original.core.name
  ) {
    return yield* Effect.fail(Error("Worker identity changed during cleanup"));
  }
  if (Option.isNone(workers.public.versionId) || Option.isNone(workers.core.versionId)) {
    if (yield* stablePairUnchanged(port, original)) return;
    return yield* Effect.fail(Error("Candidate identity unavailable for guarded cleanup"));
  }
  yield* releaseCleanup.cleanRelease(port, original, {
    publicVersionId: workers.public.versionId.value,
    coreVersionId: workers.core.versionId.value,
  });
});
const isSoleRecoveryVersion = (deployment: Deployment, version: string): boolean =>
  deployment.versions.length === 1 &&
  deployment.versions[0]?.id === version &&
  deployment.versions[0].percentage === 100;
export const matchesRecoveryVersion = (input: {
  deployment: Deployment;
  id: string;
  version: string;
}): boolean =>
  input.deployment.id === input.id && isSoleRecoveryVersion(input.deployment, input.version);
const requireRecoveryPair = Effect.fn(function* (
  port: ReleasePort,
  workers: WorkerReceipts,
  core: { id: string; version: string }
) {
  const currentPublic = yield* port.current(workers.public.workerName);
  const currentCore = yield* port.current(workers.core.workerName);
  if (
    !matchesRecoveryVersion({
      deployment: currentPublic,
      id: interruptedPromotion.publicDeployment,
      version: interruptedPromotion.publicVersion,
    }) ||
    !matchesRecoveryVersion({ deployment: currentCore, id: core.id, version: core.version })
  ) {
    return yield* new ReleaseFailure({
      message: "Interrupted promotion identity changed; no recovery write",
    });
  }
});
const recoverInterruptedCore = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  const workers = yield* workersFromState("capture");
  const expected = interruptedPromotion;
  yield* requireRecoveryPair(port, workers, {
    id: expected.coreDeployment,
    version: expected.coreCandidate,
  });
  const health = yield* Schema.decodeUnknownEffect(healthSchema)(
    yield* providerJson(HttpClientRequest.get(`${origin}/health`)).pipe(
      Effect.provideService(HttpClient.HttpClient, client)
    )
  );
  if (health.gitRevision !== expected.revision || health.contractDigest !== preSmokeDigest) {
    return yield* new ReleaseFailure({
      message: "Interrupted promotion revision changed; no recovery write",
    });
  }
  yield* stableIdentity({
    publicVersionId: expected.publicVersion,
    coreVersionId: expected.coreCandidate,
    proof: env.smokeProof,
  }).pipe(Effect.provideService(HttpClient.HttpClient, client));
  if ((yield* port.trunk()) !== env.revision) {
    return yield* new ReleaseFailure({
      message: "Recovery superseded by trunk; no recovery write",
    });
  }
  // A provider response may be lost after a committed write. Observe exact routing even if
  // the response is rejected; do not issue a second, ambiguous traffic change.
  yield* port
    .deploy(workers.core.workerName, [{ id: expected.coreStable, percentage: 100 }])
    .pipe(Effect.catch(() => Effect.void));
  const core = yield* port.current(workers.core.workerName);
  if (!isSoleRecoveryVersion(core, expected.coreStable)) {
    return yield* new ReleaseFailure({
      message: "Core recovery not confirmed; inspect both Workers",
    });
  }
  const publicDeployment = yield* port.current(workers.public.workerName);
  if (
    !matchesRecoveryVersion({
      deployment: publicDeployment,
      id: expected.publicDeployment,
      version: expected.publicVersion,
    })
  ) {
    return yield* new ReleaseFailure({ message: "Public routing changed during Core recovery" });
  }
  yield* stableIdentity({
    publicVersionId: expected.publicVersion,
    coreVersionId: expected.coreStable,
    proof: env.smokeProof,
  }).pipe(Effect.provideService(HttpClient.HttpClient, client));
});
export const verifyInspectedStaging = Effect.fn(function* (
  port: ReleasePort,
  workers: WorkerReceipts
) {
  const inspected = {
    public: {
      stable: interruptedPromotion.publicVersion,
      candidate: "18489858-358b-4986-9d60-98a686052c85",
    },
    core: {
      stable: interruptedPromotion.coreStable,
      candidate: "2216c932-4dc6-4195-baad-8944aa28bf07",
    },
  };
  for (const role of ["public", "core"] as const) {
    const worker = workers[role];
    const expected = inspected[role];
    const deployment = yield* port.current(worker.workerName);
    if (
      !Option.contains(worker.versionId, expected.candidate) ||
      deployment.versions.length !== 2 ||
      !deployment.versions.some(
        (version) => version.id === expected.stable && version.percentage === 100
      ) ||
      !deployment.versions.some(
        (version) => version.id === expected.candidate && version.percentage === 0
      )
    ) {
      return yield* new ReleaseFailure({
        message: "Inspected candidate pair is no longer staged; no synthetic probe",
      });
    }
  }
});

const inspectTraffic = Effect.fn(function* (env: Config, client: HttpClient.HttpClient) {
  const workers = yield* workersFromState("capture");
  const deployments = Effect.fn(function* (name: string) {
    const raw = yield* providerJson(
      HttpClientRequest.get(
        `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}/deployments`,
        { headers: { authorization: `Bearer ${env.token}` } }
      )
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
    const response = yield* Schema.decodeUnknownEffect(ListResponse)(raw);
    return response.result.deployments.slice(0, inspectionHistoryLimit).map(asDeployment);
  });
  const observed = {
    public: yield* deployments(workers.public.workerName),
    core: yield* deployments(workers.core.workerName),
  };
  yield* writeFile(Bun.stdout, `${encodeJson(observed)}\n`);
});
const reportTraffic = Effect.fn(function* (port: ReleasePort, env: Config) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(env.file).exists(),
    catch: () => new ReleaseFailure({ message: "Release snapshot unavailable" }),
  });
  if (!exists) {
    const promotedExists = yield* Effect.tryPromise({
      try: () => Bun.file(`${env.file}.promoted`).exists(),
      catch: () => new ReleaseFailure({ message: "Release receipt unavailable" }),
    });
    if (!promotedExists) {
      yield* writeFile(Bun.stdout, "Worker traffic unavailable: no release snapshot\n");
      return;
    }
  }
  const raw = exists
    ? yield* readFile(env.file)
    : (yield* Schema.decodeUnknownEffect(RollbackReceipt)(yield* readFile(`${env.file}.promoted`)))
        .release;
  const isStaged = Schema.decodeUnknownOption(Schema.Struct({ snapshot: Schema.Unknown }))(raw);
  const snapshot = Option.isSome(isStaged)
    ? (yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(raw)).snapshot
    : yield* Schema.decodeUnknownEffect(releaseSchemas.snapshot)(raw);
  const describe = (name: string): Effect.Effect<Deployment | { readonly status: "unavailable" }> =>
    port.current(name).pipe(Effect.orElseSucceed(() => ({ status: "unavailable" }) as const));
  const observed = {
    public: yield* describe(snapshot.public.name),
    core: yield* describe(snapshot.core.name),
  };
  yield* writeFile(Bun.stdout, `${encodeJson(observed)}\n`);
});
const promote = Effect.fn(function* (port: ReleasePort, env: Config) {
  const staged = yield* Schema.decodeUnknownEffect(releaseSchemas.staged)(
    yield* readFile(env.file)
  );
  const attestationRaw = yield* readFile(env.smokeAttestationFile);
  const attestation = yield* Schema.decodeUnknownEffect(SmokeAttestation)(attestationRaw);
  if (
    attestation.revision !== staged.snapshot.revision ||
    attestation.publicVersionId !== staged.publicVersionId ||
    attestation.coreVersionId !== staged.coreVersionId
  ) {
    return yield* Effect.fail(Error("Smoke attestation does not match candidate uploads"));
  }
  const promoted = yield* releaseController.promoteRelease(port, staged, {
    exactPairPassed: true,
    middlePairPassed: true,
  });
  // A successful promotion must retain the exact deployment IDs for guarded recovery.
  yield* writeFile(`${env.file}.promoted`, encodeJson({ release: staged, promoted }));
});

const versionResources = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  worker: { name: string; id: string }
) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(worker.name)}/versions/${worker.id}`;
  const raw = yield* providerJson(
    HttpClientRequest.get(url, {
      headers: { authorization: `Bearer ${env.token}` },
    })
  ).pipe(Effect.provideService(HttpClient.HttpClient, client));
  const version = yield* Schema.decodeUnknownEffect(VersionResponse)(raw);
  if (version.result.id !== worker.id) {
    return yield* Effect.fail(Error("Worker version identity changed"));
  }
  return {
    bindings: version.result.resources.bindings,
    migrationTag: version.result.resources.script_runtime.migration_tag ?? "",
    exports: version.result.resources.script_runtime.exports,
  } satisfies WorkerResources;
});
const rollbackSource = Effect.fn(function* (snapshot: typeof releaseSchemas.snapshot.Type) {
  // A code-only release is the only automatic rollback case. A missing Git ancestor refuses.
  yield* shell([
    "git",
    "-C",
    "../..",
    "merge-base",
    "--is-ancestor",
    snapshot.stableRevision,
    snapshot.revision,
  ]);
  const changedPaths = (yield* shell([
    "git",
    "-C",
    "../..",
    "diff",
    "--name-only",
    snapshot.stableRevision,
    snapshot.revision,
    "--",
    "infra/cloudflare/alchemy.run.ts",
    "apps/server/cloudflare/",
  ]))
    .trim()
    .split("\n");
  const workflowPaths = new Set<string>();
  for (const revision of [snapshot.stableRevision, snapshot.revision]) {
    const found = yield* shell([
      "git",
      "-C",
      "../..",
      "grep",
      "-l",
      "-F",
      "WorkflowEntrypoint",
      revision,
      "--",
      "apps/server/cloudflare/",
    ]);
    for (const line of found.trim().split("\n")) {
      workflowPaths.add(line.slice(line.indexOf(":") + 1));
    }
  }
  return { changedPaths, workflowPaths: [...workflowPaths] };
});
const rollbackCompatibility = Effect.fn(function* (
  env: Config,
  client: HttpClient.HttpClient,
  release: typeof RollbackReceipt.Type.release
) {
  const source = yield* rollbackSource(release.snapshot);
  const pairs = [
    {
      name: release.snapshot.public.name,
      stable: release.snapshot.public.stableVersionId,
      candidate: release.publicVersionId,
    },
    {
      name: release.snapshot.core.name,
      stable: release.snapshot.core.stableVersionId,
      candidate: release.coreVersionId,
    },
  ];
  let compatible = true;
  for (const pair of pairs) {
    const stable = yield* versionResources(env, client, { name: pair.name, id: pair.stable });
    const candidate = yield* versionResources(env, client, { name: pair.name, id: pair.candidate });
    compatible &&= rollbackCompatible({
      stable,
      candidate,
      ...source,
    });
  }
  return compatible;
});
const rollback = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  const { release, promoted } = yield* Schema.decodeUnknownEffect(RollbackReceipt)(
    yield* readFile(`${env.file}.promoted`)
  );
  const compatible = yield* rollbackCompatibility(env, client, release);
  const guarded: RollbackPort = {
    ...port,
    deployable: (name, id) =>
      Effect.gen(function* () {
        const versions = yield* Schema.decodeUnknownEffect(DeployableResponse)(
          yield* providerJson(
            HttpClientRequest.get(
              `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}/versions?deployable=true`,
              { headers: { authorization: `Bearer ${env.token}` } }
            )
          ).pipe(Effect.provideService(HttpClient.HttpClient, client))
        );
        return versions.result.items.some((item) => item.id === id);
      }),
  };
  yield* releaseRollback.restore(guarded, { release, promoted, compatible });
});

const runBootstrap = Effect.fn(function* ({
  command,
  port,
  env,
  client,
}: {
  command: "bootstrap-capture" | "bootstrap-verify";
  port: ReleasePort;
  env: Config;
  client: HttpClient.HttpClient;
}) {
  if (!env.bootstrapRelease) {
    return yield* new ReleaseFailure({ message: "Direct bootstrap requires protected dispatch" });
  }
  if (command === "bootstrap-capture") return yield* bootstrapCapture(port, env, client);
  return yield* bootstrapVerify(port, env, client);
});

const runRouting = Effect.fn(function* ({
  command,
  port,
  env,
  client,
}: {
  command: "capture" | "stage" | "promote" | "rollback" | "cleanup" | "report" | "inspect";
  port: ReleasePort;
  env: Config;
  client: HttpClient.HttpClient;
}) {
  switch (command) {
    case "capture":
      yield* capture(port, env, client);
      break;
    case "stage":
      yield* stage(port, env);
      break;
    case "promote":
      yield* promote(port, env);
      break;
    case "rollback":
      yield* rollback(port, env, client);
      break;
    case "cleanup":
      yield* cleanup(port, env);
      break;
    case "report":
      yield* reportTraffic(port, env);
      break;
    case "inspect":
      yield* inspectTraffic(env, client);
      break;
  }
});

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(Commands)(process.argv[2]);
    const environment = config();
    const services = yield* Layer.build(FetchHttpClient.layer);
    const client = Context.get(services, HttpClient.HttpClient);
    const port = releasePort(environment, client);
    if (command === "bootstrap-capture" || command === "bootstrap-verify") {
      yield* runBootstrap({ command, port, env: environment, client });
    } else if (command === "recover-core") {
      yield* recoverInterruptedCore(port, environment, client);
    } else if (command === "resume-capture") {
      yield* resumeCapture(port, environment, client);
    } else if (command === "verify-staged") {
      yield* verifyInspectedStaging(port, yield* workersFromState());
    } else {
      yield* runRouting({ command, port, env: environment, client });
    }
    yield* writeFile(Bun.stdout, "Production release routing step passed.\n");
  }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }), Effect.scoped);
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          process.stderr.write(`${releaseFailureMessage(cause)}\n`);
          process.exitCode = 1;
        })
      )
    )
  );
}
