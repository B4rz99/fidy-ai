/// <reference types="bun-types" />

import { Encoding, Option, Schema } from "effect";
import {
  SmokeIdentity,
  SmokeRequest,
  SmokeResponse,
  smokePath,
} from "../../apps/server/cloudflare/runtime/smoke";
import { cleanRelease } from "./release-cleanup";
import {
  type Deployment,
  type ReleasePort,
  type ReleaseSnapshot,
  captureRelease,
  decodeSnapshot,
  decodeStaged,
  promoteRelease,
  stageRelease,
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
const timeoutMs = 10_000;
const responseLimit = 100_000;
const probeEntropyBytes = 16;
const origin = "https://api.fidyapp.com";

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

// A streamed provider response must be counted before it is buffered or parsed.
const boundedJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) {
    throw Error("Provider rejected the release request");
  }
  if (Number(response.headers.get("content-length")) > responseLimit) {
    throw Error("Provider response exceeded limit");
  }
  if (response.body === null) {
    throw Error("Provider response body missing");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const value of response.body) {
    size += value.byteLength;
    if (size > responseLimit) {
      throw Error("Provider response exceeded limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return parsed;
};
const shell = async (args: ReadonlyArray<string>): Promise<string> => {
  const child = Bun.spawn([...args], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    throw Error("Release tooling failed; inspect traffic state");
  }
  return output;
};

type WorkerReceipt = Readonly<{
  workerName: string;
  versionId: Option.Option<string>;
  hasRolloutBaseline: boolean;
}>;
const workersFromState = async (): Promise<{ public: WorkerReceipt; core: WorkerReceipt }> => {
  // Alchemy's persisted upload receipts, not a health response. Never print state: it also
  // contains other resources' binding metadata.
  const rawState = await shell([
    "bun",
    "../../node_modules/alchemy/bin/alchemy.ts",
    "state",
    "read",
    "--backend",
    "cloudflare",
    "--recursive",
    "FidyCloudflare/production",
  ]);
  const parsed: unknown = JSON.parse(rawState);
  const entries = Schema.decodeUnknownSync(StateMap)(parsed);
  const select = (logicalId: string): WorkerReceipt => {
    const matches = Object.values(entries).flatMap((value) => {
      const decoded = Schema.decodeUnknownOption(StateEntry)(value);
      if (Option.isNone(decoded) || decoded.value.logicalId !== logicalId) {
        return [];
      }
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

const stableIdentity = async (input: {
  publicVersionId: string;
  coreVersionId: string;
  proof: string;
}): Promise<{ stableRevision: string; stableContractDigest: string }> => {
  const health = Schema.decodeUnknownSync(healthSchema)(
    await boundedJson(
      await fetch(`${origin}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      })
    )
  );
  const request = Schema.decodeSync(SmokeRequest)({
    protocolVersion: 1,
    probeId: Encoding.encodeHex(crypto.getRandomValues(new Uint8Array(probeEntropyBytes))),
    expectedPublicVersionId: input.publicVersionId,
    expectedCoreVersionId: input.coreVersionId,
    expectedGitRevision: health.gitRevision,
    expectedContractDigest: health.contractDigest,
  });
  const response = await fetch(`${origin}${smokePath}`, {
    method: "POST",
    headers: { "x-fidy-smoke-proof": input.proof, "content-type": "application/json" },
    body: JSON.stringify(request),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const observed = Schema.decodeUnknownSync(smokeResultSchema)(await boundedJson(response));
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
    throw Error("Stable Worker release identities disagree");
  }
  return { stableRevision: health.gitRevision, stableContractDigest: health.contractDigest };
};

const asDeployment = (value: typeof ApiDeployment.Type): Deployment => ({
  id: value.id,
  versions: value.versions.map((version) => ({
    id: version.version_id,
    percentage: version.percentage,
  })),
});
const promoteVersion = async (
  env: Config,
  url: string,
  versions: Deployment["versions"]
): Promise<Deployment> => {
  const response = Schema.decodeUnknownSync(CreateResponse)(
    await boundedJson(
      await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          strategy: "percentage",
          versions: versions.map((version) => ({
            version_id: version.id,
            percentage: version.percentage,
          })),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      })
    )
  );
  return asDeployment(response.result);
};
const releasePort = (env: Config): ReleasePort => {
  const url = (name: string): string =>
    `https://api.cloudflare.com/client/v4/accounts/${env.account}/workers/scripts/${encodeURIComponent(name)}/deployments`;
  const current: ReleasePort["current"] = async (name) => {
    const response = Schema.decodeUnknownSync(ListResponse)(
      await boundedJson(
        await fetch(url(name), {
          headers: { authorization: `Bearer ${env.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        })
      )
    );
    const active = response.result.deployments[0];
    if (active === undefined) {
      throw Error(`No active deployment: ${name}`);
    }
    return asDeployment(active);
  };
  return {
    trunk: async () => {
      const response = await boundedJson(
        await fetch(`https://api.github.com/repos/${env.repository}/commits/trunk`, {
          headers: {
            authorization: `Bearer ${env.githubToken}`,
            accept: "application/vnd.github+json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        })
      );
      return Schema.decodeUnknownSync(Schema.Struct({ sha: SmokeIdentity.fields.gitRevision }))(
        response
      ).sha;
    },
    current,
    deploy: async (name, versions) => {
      if (versions.some((version) => version.percentage === 0)) {
        // Cloudflare documents 0% through Wrangler, but its create-deployment API schema
        // specifies a nonzero minimum. Never substitute 0.01%.
        await shell([
          "bun",
          "../../node_modules/wrangler/bin/wrangler.js",
          "versions",
          "deploy",
          ...versions.map((version) => `${version.id}@${version.percentage}`),
          "--name",
          name,
          "--yes",
        ]);
        return current(name);
      }
      return promoteVersion(env, url(name), versions);
    },
  };
};

const soleStableVersion = (deployment: Deployment): string => {
  if (deployment.versions.length !== 1 || deployment.versions[0]?.percentage !== 100) {
    throw Error("Production Worker is not fully stable");
  }
  return deployment.versions[0].id;
};
const capture = async (port: ReleasePort, env: Config): Promise<void> => {
  const workers = await workersFromState();
  // The pinned Alchemy provider falls back to a direct 100% PUT when its previous Worker
  // output has no hash. Never let that branch masquerade as a candidate upload.
  if (!workers.public.hasRolloutBaseline || !workers.core.hasRolloutBaseline) {
    throw Error("Alchemy Worker rollout baseline missing; candidate upload is unsafe");
  }
  const publicDeployment = await port.current(workers.public.workerName);
  const coreDeployment = await port.current(workers.core.workerName);
  const publicStable = soleStableVersion(publicDeployment);
  const coreStable = soleStableVersion(coreDeployment);
  const identity = await stableIdentity({
    publicVersionId: publicStable,
    coreVersionId: coreStable,
    proof: env.smokeProof,
  });
  const snapshot = await captureRelease(port, {
    revision: env.revision,
    ...identity,
    publicName: workers.public.workerName,
    coreName: workers.core.workerName,
  });
  if (
    snapshot.public.stableVersionId !== publicStable ||
    snapshot.core.stableVersionId !== coreStable
  ) {
    throw Error("Stable deployments changed during capture");
  }
  await Bun.write(env.file, JSON.stringify(snapshot));
};
const stage = async (port: ReleasePort, env: Config): Promise<void> => {
  const raw: unknown = JSON.parse(await Bun.file(env.file).text());
  const snapshot = decodeSnapshot(raw);
  const workers = await workersFromState();
  if (
    workers.public.workerName !== snapshot.public.name ||
    workers.core.workerName !== snapshot.core.name ||
    Option.isNone(workers.public.versionId) ||
    Option.isNone(workers.core.versionId)
  ) {
    throw Error("Alchemy candidate receipts are incomplete");
  }
  const result = await stageRelease(port, snapshot, {
    publicVersionId: workers.public.versionId.value,
    coreVersionId: workers.core.versionId.value,
  });
  await Bun.write(env.file, JSON.stringify(result));
};
const stablePairUnchanged = async (
  port: ReleasePort,
  snapshot: ReleaseSnapshot
): Promise<boolean> => {
  const publicDeployment = await port.current(snapshot.public.name);
  const coreDeployment = await port.current(snapshot.core.name);
  return (
    soleStableVersion(publicDeployment) === snapshot.public.stableVersionId &&
    soleStableVersion(coreDeployment) === snapshot.core.stableVersionId
  );
};
const cleanup = async (port: ReleasePort, env: Config): Promise<void> => {
  if (!(await Bun.file(env.file).exists())) {
    return;
  }
  const raw: unknown = JSON.parse(await Bun.file(env.file).text());
  const snapshot = Schema.decodeUnknownOption(Schema.Struct({ snapshot: Schema.Unknown }))(raw);
  const original = Option.isSome(snapshot) ? decodeStaged(raw).snapshot : decodeSnapshot(raw);
  const workers = await workersFromState();
  if (
    workers.public.workerName !== original.public.name ||
    workers.core.workerName !== original.core.name
  ) {
    throw Error("Worker identity changed during cleanup");
  }
  if (Option.isNone(workers.public.versionId) || Option.isNone(workers.core.versionId)) {
    if (await stablePairUnchanged(port, original)) {
      return;
    }
    throw Error("Candidate identity unavailable for guarded cleanup");
  }
  await cleanRelease(port, original, {
    publicVersionId: workers.public.versionId.value,
    coreVersionId: workers.core.versionId.value,
  });
};
const reportTraffic = async (port: ReleasePort, env: Config): Promise<void> => {
  if (!(await Bun.file(env.file).exists())) {
    await Bun.write(Bun.stdout, "Worker traffic unavailable: no release snapshot\n");
    return;
  }
  const raw: unknown = JSON.parse(await Bun.file(env.file).text());
  const isStaged = Schema.decodeUnknownOption(Schema.Struct({ snapshot: Schema.Unknown }))(raw);
  const snapshot = Option.isSome(isStaged) ? decodeStaged(raw).snapshot : decodeSnapshot(raw);
  const describe = async (name: string): Promise<unknown> =>
    port.current(name).catch(() => ({ status: "unavailable" }));
  const observed = {
    public: await describe(snapshot.public.name),
    core: await describe(snapshot.core.name),
  };
  await Bun.write(Bun.stdout, `${JSON.stringify(observed)}\n`);
};
const promote = async (port: ReleasePort, env: Config): Promise<void> => {
  const raw: unknown = JSON.parse(await Bun.file(env.file).text());
  const staged = decodeStaged(raw);
  const attestationPath = env.smokeAttestationFile;
  if (!attestationPath.startsWith("/")) {
    throw Error("Missing smoke attestation path");
  }
  const attestationRaw: unknown = JSON.parse(await Bun.file(attestationPath).text());
  const attestation = Schema.decodeUnknownSync(SmokeAttestation)(attestationRaw);
  if (
    attestation.revision !== staged.snapshot.revision ||
    attestation.publicVersionId !== staged.publicVersionId ||
    attestation.coreVersionId !== staged.coreVersionId
  ) {
    throw Error("Smoke attestation does not match candidate uploads");
  }
  await promoteRelease(port, staged, { exactPairPassed: true, middlePairPassed: true });
};

if (import.meta.main) {
  try {
    const command = Schema.decodeUnknownSync(Commands)(process.argv[2]);
    const environment = config();
    const port = releasePort(environment);
    if (command === "capture") {
      await capture(port, environment);
    }
    if (command === "stage") {
      await stage(port, environment);
    }
    if (command === "promote") {
      await promote(port, environment);
    }
    if (command === "cleanup") {
      await cleanup(port, environment);
    }
    if (command === "report") {
      await reportTraffic(port, environment);
    }
    await Bun.write(Bun.stdout, "Production release routing step passed.\n");
  } catch {
    await Bun.write(
      Bun.stderr,
      "Production release routing failed; inspect Worker deployment state before recovery.\n"
    );
    process.exitCode = 1;
  }
}
