/// <reference types="bun-types" />

import { Context, Data, Effect, Encoding, Layer, Option, Schema, Stream } from "effect";
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
const StateEntry = Schema.Struct({
  logicalId: Schema.String,
  status: Schema.Literals(["created", "updated"]),
  attr: Schema.Struct({ workerName: WorkerName }),
});
const StateMap = Schema.Record(Schema.String, Schema.Unknown);
const Commands = Schema.Literals(["capture", "stage", "promote", "cleanup", "report"]);
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
const origin = "https://api.fidyapp.com";
class ReleaseFailure extends Data.TaggedError("ReleaseFailure")<{ message: string }> {}
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

export const decodeWorkerReceipts = (output: string): WorkerReceipts => {
  const entries = decodeStateMap(output);
  const select = (logicalId: string): WorkerReceipt => {
    const matches = Object.values(entries).flatMap((value) => {
      const decoded = Schema.decodeUnknownOption(StateEntry)(value);
      if (Option.isNone(decoded) || decoded.value.logicalId !== logicalId) return [];
      const rawVersion = Schema.decodeUnknownOption(
        Schema.Struct({ attr: Schema.Struct({ versionId: VersionId }) })
      )(value);
      const baseline = Schema.decodeUnknownOption(
        Schema.Struct({
          attr: Schema.Struct({ hash: Schema.Record(Schema.String, Schema.Unknown) }),
        })
      )(value);
      return [
        {
          workerName: decoded.value.attr.workerName,
          versionId: Option.map(rawVersion, (entry) => entry.attr.versionId),
          hasRolloutBaseline: Option.isSome(baseline),
        },
      ];
    });
    if (matches.length !== 1) {
      throw Error(`Missing or ambiguous Alchemy Worker receipt: ${logicalId}`);
    }
    return matches[0] ?? { workerName: "", versionId: Option.none(), hasRolloutBaseline: false };
  };
  return { public: select("Ingress"), core: select("Core") };
};

const workersFromState = Effect.fn(function* () {
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
    try: () => decodeWorkerReceipts(rawState),
    catch: () => new ReleaseFailure({ message: "Alchemy Worker state output is invalid" }),
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

const capture = Effect.fn(function* (
  port: ReleasePort,
  env: Config,
  client: HttpClient.HttpClient
) {
  const workers = yield* workersFromState();
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
const reportTraffic = Effect.fn(function* (port: ReleasePort, env: Config) {
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(env.file).exists(),
    catch: () => new ReleaseFailure({ message: "Release snapshot unavailable" }),
  });
  if (!exists) {
    yield* writeFile(Bun.stdout, "Worker traffic unavailable: no release snapshot\n");
    return;
  }
  const raw = yield* readFile(env.file);
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
  yield* releaseController.promoteRelease(port, staged, {
    exactPairPassed: true,
    middlePairPassed: true,
  });
});

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(Commands)(process.argv[2]);
    const environment = config();
    const services = yield* Layer.build(FetchHttpClient.layer);
    const client = Context.get(services, HttpClient.HttpClient);
    const port = releasePort(environment, client);
    switch (command) {
      case "capture":
        yield* capture(port, environment, client);
        break;
      case "stage":
        yield* stage(port, environment);
        break;
      case "promote":
        yield* promote(port, environment);
        break;
      case "cleanup":
        yield* cleanup(port, environment);
        break;
      case "report":
        yield* reportTraffic(port, environment);
        break;
    }
    yield* writeFile(Bun.stdout, "Production release routing step passed.\n");
  }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }), Effect.scoped);
  await Effect.runPromise(program).catch((cause: unknown) => {
    const message =
      cause instanceof ReleaseFailure
        ? cause.message
        : "Production release routing failed; inspect Worker deployment state before recovery.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
