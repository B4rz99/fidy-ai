#!/usr/bin/env bun

import {
  type ContractAcknowledgement,
  type ContractArtifacts,
  type ContractFinding,
  acknowledgementCovers,
  asJsonObject,
  canonicalJson,
  compareOperationPolicies,
  contractArtifactsFrom,
  contractDigest,
  findOpenApiBreakingChanges,
  isUnknownRecord,
} from "./compatibility";

const serverRoot = Bun.fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const workspaceRoot = Bun.fileURLToPath(new URL("../../../..", import.meta.url)).replace(
  /\/$/u,
  ""
);
const contractsDirectory = `${serverRoot}/contracts`;
const acknowledgementPath = `${contractsDirectory}/breaking-change-acknowledgement.json`;

const run = (
  command: ReadonlyArray<string>,
  cwd: string = workspaceRoot
): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } => {
  const result = Bun.spawnSync([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
};

const readJson = async (path: string): Promise<unknown> => {
  try {
    return await Bun.file(path).json();
  } catch (cause) {
    throw new Error(`Could not read JSON contract ${path}: ${String(cause)}`);
  }
};

const isUnknownArray = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value);

const committedBaseArtifacts = (baseRef: string): ContractArtifacts | undefined => {
  const paths = [
    "apps/server/contracts/openapi.json",
    "apps/server/contracts/operation-policy.json",
  ] as const;
  const shown = paths.map((path) => run(["git", "show", `${baseRef}:${path}`]));
  if (shown.every(({ exitCode }) => exitCode !== 0)) return undefined;
  if (shown.some(({ exitCode }) => exitCode !== 0)) {
    throw new Error(`Base ${baseRef} contains only part of the generated server contract`);
  }
  const openapi = shown[0];
  const policy = shown[1];
  if (openapi === undefined || policy === undefined) {
    throw new Error(`Base ${baseRef} contract lookup was incomplete`);
  }
  return contractArtifactsFrom(
    JSON.parse(openapi.stdout),
    JSON.parse(policy.stdout),
    `base ${baseRef}`
  );
};

const bootstrapBaseArtifacts = async (baseRef: string): Promise<ContractArtifacts> => {
  const temporaryDirectory = `/tmp/fidy-contract-base-${process.pid}`;
  const archive = `${temporaryDirectory}.tar`;
  const cleanup = (): void => {
    run(["rm", "-rf", temporaryDirectory, archive]);
  };
  cleanup();
  const mkdir = run(["mkdir", "-p", temporaryDirectory]);
  if (mkdir.exitCode !== 0) throw new Error(mkdir.stderr);

  try {
    const archived = run(
      ["git", "archive", "--format=tar", `--output=${archive}`, baseRef],
      workspaceRoot
    );
    if (archived.exitCode !== 0) {
      throw new Error(`Could not archive ${baseRef}: ${archived.stderr}`);
    }
    const extracted = run(["tar", "-xf", archive, "-C", temporaryDirectory]);
    if (extracted.exitCode !== 0) throw new Error(extracted.stderr);
    const linked = run([
      "ln",
      "-s",
      `${workspaceRoot}/node_modules`,
      `${temporaryDirectory}/node_modules`,
    ]);
    if (linked.exitCode !== 0) throw new Error(linked.stderr);

    const toolDirectory = `${temporaryDirectory}/apps/server/tools/contracts`;
    await Bun.write(
      `${toolDirectory}/compatibility.ts`,
      Bun.file(`${serverRoot}/tools/contracts/compatibility.ts`),
      { createPath: true }
    );
    await Bun.write(
      `${toolDirectory}/generate.ts`,
      Bun.file(`${serverRoot}/tools/contracts/generate.ts`)
    );

    const outputDirectory = `${temporaryDirectory}/generated-contracts`;
    const generated = run(
      ["bun", "tools/contracts/generate.ts", "--output-dir", outputDirectory],
      `${temporaryDirectory}/apps/server`
    );
    if (generated.exitCode !== 0) {
      throw new Error(`Could not bootstrap ${baseRef} contracts:\n${generated.stderr}`);
    }
    return contractArtifactsFrom(
      await readJson(`${outputDirectory}/openapi.json`),
      await readJson(`${outputDirectory}/operation-policy.json`),
      `bootstrapped base ${baseRef}`
    );
  } finally {
    cleanup();
  }
};

const isFinding = (value: unknown): value is ContractFinding => {
  if (
    !isUnknownRecord(value) ||
    typeof value.rule !== "string" ||
    typeof value.detail !== "string"
  ) {
    return false;
  }
  if (value.source === "openapi") {
    try {
      asJsonObject(value.location);
      return true;
    } catch {
      return false;
    }
  }
  return value.source === "operation-policy" && typeof value.operationId === "string";
};

const readAcknowledgement = async (): Promise<ContractAcknowledgement | undefined> => {
  const file = Bun.file(acknowledgementPath);
  if (!(await file.exists())) return undefined;
  const value: unknown = await file.json();
  if (
    !isUnknownRecord(value) ||
    typeof value.baseDigest !== "string" ||
    typeof value.candidateDigest !== "string" ||
    typeof value.rolloutIssue !== "string" ||
    !isUnknownArray(value.findings) ||
    !value.findings.every(isFinding)
  ) {
    throw new Error(`${acknowledgementPath} is not a valid exact-finding acknowledgement`);
  }
  return {
    baseDigest: value.baseDigest,
    candidateDigest: value.candidateDigest,
    rolloutIssue: value.rolloutIssue,
    findings: value.findings,
  };
};

const parseBaseRef = (): string => {
  const argumentIndex = Bun.argv.indexOf("--base");
  const argument = argumentIndex === -1 ? undefined : Bun.argv[argumentIndex + 1];
  const baseRef = argument ?? Bun.env.BASE_REF ?? "origin/trunk";
  const exists = run(["git", "rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  if (exists.exitCode !== 0) {
    throw new Error(
      `Contract compatibility needs a PR base. Pass --base <git-ref> or set BASE_REF (tried ${baseRef}).`
    );
  }
  return baseRef;
};

const main = async (): Promise<void> => {
  const baseRef = parseBaseRef();
  const candidate = contractArtifactsFrom(
    await readJson(`${contractsDirectory}/openapi.json`),
    await readJson(`${contractsDirectory}/operation-policy.json`),
    "candidate"
  );
  const committed = committedBaseArtifacts(baseRef);
  const base = committed ?? (await bootstrapBaseArtifacts(baseRef));
  if (committed === undefined) {
    process.stdout.write(`bootstrapped base contracts from ${baseRef}\n`);
  }

  const findings = [
    ...(await findOpenApiBreakingChanges(base.openapi, candidate.openapi)),
    ...compareOperationPolicies(base.operationPolicy, candidate.operationPolicy),
  ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const baseDigest = contractDigest(base);
  const candidateDigest = contractDigest(candidate);
  const acknowledgement = await readAcknowledgement();

  if (findings.length === 0) {
    if (acknowledgement !== undefined) {
      throw new Error(
        `Delete stale ${acknowledgementPath}; this comparison has no breaking findings.`
      );
    }
    process.stdout.write(
      `server contracts compatible: ${baseDigest} -> ${candidateDigest} (${baseRef})\n`
    );
    return;
  }

  if (
    acknowledgement !== undefined &&
    acknowledgementCovers({ acknowledgement, baseDigest, candidateDigest, findings })
  ) {
    process.stdout.write(
      `acknowledged ${findings.length} exact contract finding(s) for ${acknowledgement.rolloutIssue}\n`
    );
    return;
  }

  throw new Error(
    `Unacknowledged contract compatibility findings.\nBase digest: ${baseDigest}\nCandidate digest: ${candidateDigest}\n${JSON.stringify(findings, null, 2)}\nCoordinate an add/use/remove rollout, or commit ${acknowledgementPath} with these exact digests, findings, and its rollout issue.`
  );
};

if (import.meta.main) await main();
