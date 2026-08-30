#!/usr/bin/env bun
import { UnknownJsonString } from "../../src/schema-compatibility";

import { type Cause, Data, type Duration, Effect, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, type HttpClientError } from "effect/unstable/http";
import {
  type ContractAcknowledgement,
  type ContractArtifacts,
  type ContractFinding,
  type ProductionWebRelease,
  acknowledgementCovers,
  canonicalJson,
  compareOperationPolicies,
  contractAcknowledgementFrom,
  contractArtifactsFrom,
  contractDigest,
  findOpenApiBreakingChanges,
  productionWebReleaseFrom,
  removalAcknowledgementCovers,
} from "./compatibility";

const serverRoot = Bun.fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const workspaceRoot = Bun.fileURLToPath(new URL("../../../..", import.meta.url)).replace(
  /\/$/u,
  ""
);
const contractsDirectory = `${serverRoot}/contracts`;
const acknowledgementPath = `${contractsDirectory}/breaking-change-acknowledgement.json`;
const productionWebMetadataUrl = "https://fidyapp.com/deployment-metadata.json";
const maximumReleaseMetadataBytes = 4_096;
const productionEvidenceTimeout = "10 seconds";
const httpOk = 200;

class ProductionEvidenceRejected extends Data.TaggedError("ProductionEvidenceRejected")<{
  readonly message: string;
}> {}

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

const readAcknowledgement = async (): Promise<ContractAcknowledgement | undefined> => {
  const file = Bun.file(acknowledgementPath);
  if (!(await file.exists())) return undefined;
  try {
    return contractAcknowledgementFrom(await file.json());
  } catch {
    throw new Error(`${acknowledgementPath} is not a valid exact-finding acknowledgement`);
  }
};

const appendBounded = (
  accumulated: Uint8Array<ArrayBufferLike>,
  chunk: Uint8Array<ArrayBufferLike>,
  maximumBytes: number
): Effect.Effect<Uint8Array<ArrayBufferLike>, ProductionEvidenceRejected> => {
  const byteLength = accumulated.byteLength + chunk.byteLength;
  if (byteLength > maximumBytes) {
    return Effect.fail(
      new ProductionEvidenceRejected({
        message: `Production web release evidence exceeds ${maximumBytes} bytes`,
      })
    );
  }
  const combined = new Uint8Array(byteLength);
  combined.set(accumulated);
  combined.set(chunk, accumulated.byteLength);
  return Effect.succeed(combined);
};

/**
 * Reads and validates the bounded public identity of the web artifact served in Production.
 * Fails for transport errors, timeouts, non-success responses, oversized bodies, and invalid JSON
 * or release identities.
 */
export const readProductionWebRelease = ({
  url = productionWebMetadataUrl,
  maximumBytes = maximumReleaseMetadataBytes,
  timeout = productionEvidenceTimeout,
}: {
  readonly url?: string;
  readonly maximumBytes?: number;
  readonly timeout?: Duration.Input;
} = {}): Effect.Effect<
  ProductionWebRelease,
  Cause.TimeoutError | HttpClientError.HttpClientError | ProductionEvidenceRejected,
  HttpClient.HttpClient
> =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) => {
      if (response.status !== httpOk) {
        return Effect.fail(
          new ProductionEvidenceRejected({
            message: `Could not verify the deployed web release at ${url}: HTTP ${response.status}`,
          })
        );
      }
      return response.stream.pipe(
        Stream.runFoldEffect(
          (): Uint8Array<ArrayBufferLike> => new Uint8Array(),
          (accumulated, chunk) => appendBounded(accumulated, chunk, maximumBytes)
        ),
        Effect.flatMap((bytes) =>
          Schema.decodeEffect(UnknownJsonString)(new TextDecoder().decode(bytes)).pipe(
            Effect.mapError(
              (cause) =>
                new ProductionEvidenceRejected({
                  message: `Could not verify the deployed web release: ${String(cause)}`,
                })
            ),
            Effect.flatMap((value) =>
              Effect.try({
                try: () => productionWebReleaseFrom(value),
                catch: (cause) =>
                  new ProductionEvidenceRejected({
                    message: `Could not verify the deployed web release: ${String(cause)}`,
                  }),
              })
            )
          )
        )
      );
    }),
    Effect.timeout(timeout)
  );

/** Throws when an acknowledgement remains after its comparison has no breaking findings. */
export const rejectStaleAcknowledgement = ({
  acknowledgement,
  findings,
  path = acknowledgementPath,
}: {
  readonly acknowledgement: ContractAcknowledgement | undefined;
  readonly findings: ReadonlyArray<ContractFinding>;
  readonly path?: string;
}): void => {
  if (findings.length === 0 && acknowledgement !== undefined) {
    throw new Error(`Delete stale ${path}; this comparison has no breaking findings.`);
  }
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

type RemovalAuthorizationDependencies = {
  readonly runCommand: (command: ReadonlyArray<string>) => {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly readDeployedWeb: () => Promise<ProductionWebRelease>;
  readonly writeOutput: (message: string) => void;
};

const liveRemovalAuthorizationDependencies: RemovalAuthorizationDependencies = {
  runCommand: run,
  readDeployedWeb: () =>
    readProductionWebRelease().pipe(
      // This contract checker is the tooling entry point that owns the HTTP client lifetime.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(FetchHttpClient.layer),
      Effect.runPromise
    ),
  writeOutput: (message) => process.stdout.write(message),
};

/**
 * Checks exact acknowledgement and distinguishes an intentional initial break from final removal.
 * Returns false when no exact acknowledgement exists; final removal still requires deployed evidence.
 */
export const authorizeRemoval = async (
  {
    acknowledgement,
    baseRef,
    baseDigest,
    candidateDigest,
    findings,
  }: {
    readonly acknowledgement: ContractAcknowledgement | undefined;
    readonly baseRef: string;
    readonly baseDigest: string;
    readonly candidateDigest: string;
    readonly findings: ReadonlyArray<ContractFinding>;
  },
  dependencies: RemovalAuthorizationDependencies = liveRemovalAuthorizationDependencies
): Promise<boolean> => {
  if (
    acknowledgement === undefined ||
    !acknowledgementCovers({ acknowledgement, baseDigest, candidateDigest, findings })
  ) {
    return false;
  }
  const baseRevisionResult = dependencies.runCommand(["git", "rev-parse", `${baseRef}^{commit}`]);
  if (baseRevisionResult.exitCode !== 0) throw new Error(baseRevisionResult.stderr);
  const baseRevision = baseRevisionResult.stdout.trim();
  const webDiff = dependencies.runCommand(["git", "diff", "--quiet", baseRef, "--", "apps/web"]);
  if (webDiff.exitCode > 1) throw new Error(webDiff.stderr);
  if (webDiff.exitCode === 1) {
    dependencies.writeOutput(
      `acknowledged ${findings.length} initial-breaking finding(s) for ${acknowledgement.rolloutIssue}; candidate web and server adopt the contract together\n`
    );
    return true;
  }
  const deployedWeb = await dependencies.readDeployedWeb();
  if (
    !removalAcknowledgementCovers({
      acknowledgement,
      baseDigest,
      candidateDigest,
      findings,
      baseRevision,
      deployedWeb,
      candidateChangesWeb: false,
    })
  ) {
    throw new Error(
      `The exact acknowledgement cannot authorize an initial break. Final removal requires an unchanged candidate web and Production deployment of base revision ${baseRevision} with contract ${baseDigest}; found ${deployedWeb.gitRevision} with ${deployedWeb.contractDigest}.`
    );
  }
  dependencies.writeOutput(
    `acknowledged ${findings.length} final-removal finding(s) for ${acknowledgement.rolloutIssue}; Production web ${deployedWeb.gitRevision} carries the exact base contract\n`
  );
  return true;
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

  rejectStaleAcknowledgement({ acknowledgement, findings });
  if (findings.length === 0) {
    process.stdout.write(
      `server contracts compatible: ${baseDigest} -> ${candidateDigest} (${baseRef})\n`
    );
    return;
  }

  if (await authorizeRemoval({ acknowledgement, baseRef, baseDigest, candidateDigest, findings })) {
    return;
  }

  throw new Error(
    `Unacknowledged contract compatibility findings.\nBase digest: ${baseDigest}\nCandidate digest: ${candidateDigest}\n${JSON.stringify(findings, null, 2)}\nCoordinate an add/use/remove rollout, or commit ${acknowledgementPath} with these exact digests, findings, and its rollout issue.`
  );
};

if (import.meta.main) await main();
