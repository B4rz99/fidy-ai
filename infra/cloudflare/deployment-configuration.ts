import { Data, Result } from "effect";

const developmentGitRevision = "0000000000000000000000000000000000000000";
const developmentContractDigest =
  "0000000000000000000000000000000000000000000000000000000000000000";

const gitRevisionPattern = /^[0-9a-f]{40}$/u;
const contractDigestPattern = /^[0-9a-f]{64}$/u;
const zeroValuePattern = /^0+$/u;

export type ReleaseMetadata = {
  readonly contractDigest: string;
  readonly gitRevision: string;
};

type TopologyModeInput = {
  readonly development: boolean;
  readonly stage: string;
};

type DeploymentConfigurationInput = TopologyModeInput & {
  readonly contractDigest: string;
  readonly gitRevision: string;
};

export class InvalidDeploymentConfiguration extends Data.TaggedError(
  "InvalidDeploymentConfiguration"
)<{
  readonly reason: "invalid_release_metadata" | "unsupported_remote_stage";
}> {}

/** Resolves the only two topology modes before state or resources are created. */
export const resolveTopologyMode = (
  input: TopologyModeInput
): Result.Result<"development" | "production", InvalidDeploymentConfiguration> => {
  if (input.development) return Result.succeed("development");
  if (input.stage === "production") return Result.succeed("production");
  return Result.fail(new InvalidDeploymentConfiguration({ reason: "unsupported_remote_stage" }));
};

const isReleaseIdentity = (value: string, pattern: RegExp): boolean =>
  pattern.test(value) && !zeroValuePattern.test(value);

/** Resolves bounded release metadata for an already selected topology mode. */
export const resolveDeploymentConfiguration = (
  input: DeploymentConfigurationInput
): Result.Result<ReleaseMetadata, InvalidDeploymentConfiguration> => {
  const mode = resolveTopologyMode(input);
  if (Result.isFailure(mode)) return Result.fail(mode.failure);

  if (mode.success === "development") {
    return Result.succeed({
      contractDigest: developmentContractDigest,
      gitRevision: developmentGitRevision,
    });
  }

  if (
    !isReleaseIdentity(input.contractDigest, contractDigestPattern) ||
    !isReleaseIdentity(input.gitRevision, gitRevisionPattern)
  ) {
    return Result.fail(new InvalidDeploymentConfiguration({ reason: "invalid_release_metadata" }));
  }

  return Result.succeed({
    contractDigest: input.contractDigest,
    gitRevision: input.gitRevision,
  });
};
