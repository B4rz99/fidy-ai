#!/usr/bin/env bun

import { appendFile } from "node:fs/promises";
import { Schema } from "effect";

const railwayGraphqlUrl = "https://backboard.railway.app/graphql/v2";
const deploymentCheckLimit = 120;
const healthCheckLimit = 30;
const deploymentPollInterval = 5_000;
const healthPollInterval = 2_000;
const GitRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const ContractDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const DeployResponse = Schema.Struct({
  data: Schema.Struct({ serviceInstanceDeployV2: Schema.String }),
});
const DeploymentResponse = Schema.Struct({
  data: Schema.Struct({
    deployment: Schema.Struct({ id: Schema.String, status: Schema.String }),
  }),
});
const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  gitRevision: GitRevision,
  contractDigest: ContractDigest,
});

const deployMutation = `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!, $commitSha: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
}`;
const deploymentQuery = `query deployment($id: String!) {
  deployment(id: $id) { id status }
}`;
const failedStatuses = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

type HttpRequest = (input: string | URL | Request, init: RequestInit) => Promise<Response>;

type RailwayReleaseRequest = {
  readonly apiToken: string;
  readonly serviceId: string;
  readonly environmentId: string;
  readonly gitRevision: string;
  readonly contractDigest: string;
  readonly apiOrigin: string;
};

export type RailwayReleaseDependencies = {
  readonly request: HttpRequest;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly maxDeploymentChecks: number;
  readonly maxHealthChecks: number;
  readonly observe: (message: string) => void;
};

type GraphqlRequest<Value> = {
  readonly request: HttpRequest;
  readonly token: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly decode: (value: unknown) => Value;
};

const liveDependencies: RailwayReleaseDependencies = {
  request: (input, init): Promise<Response> => Bun.fetch(input, init),
  wait: (milliseconds): Promise<void> => Bun.sleep(milliseconds),
  maxDeploymentChecks: deploymentCheckLimit,
  maxHealthChecks: healthCheckLimit,
  observe: (message): void => {
    process.stderr.write(`${message}\n`);
  },
};

const decodeJson = async <Value>(
  response: Response,
  decode: (value: unknown) => Value
): Promise<Value> => {
  if (!response.ok) throw new Error(`deployment provider returned HTTP ${response.status}`);
  return decode(await response.json());
};

const graphql = async <Value>(input: GraphqlRequest<Value>): Promise<Value> =>
  decodeJson(
    await input.request(railwayGraphqlUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
    }),
    input.decode
  );

const checkedOrigin = (candidate: string): string => {
  const origin = new URL(candidate);
  if (origin.protocol !== "https:" || origin.origin !== candidate) {
    throw new Error("Production API origin must be one exact HTTPS origin");
  }
  return origin.origin;
};

const requestDeployment = async (
  input: RailwayReleaseRequest,
  dependencies: RailwayReleaseDependencies,
  gitRevision: string
): Promise<string> => {
  const deployed = await graphql({
    request: dependencies.request,
    token: input.apiToken,
    query: deployMutation,
    variables: {
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      commitSha: gitRevision,
    },
    decode: Schema.decodeUnknownSync(DeployResponse),
  });
  return deployed.data.serviceInstanceDeployV2;
};

const awaitDeployment = async (
  deploymentId: string,
  token: string,
  dependencies: RailwayReleaseDependencies
): Promise<void> => {
  for (let attempt = 0; attempt < dependencies.maxDeploymentChecks; attempt += 1) {
    const result = await graphql({
      request: dependencies.request,
      token,
      query: deploymentQuery,
      variables: { id: deploymentId },
      decode: Schema.decodeUnknownSync(DeploymentResponse),
    });
    if (result.data.deployment.id !== deploymentId) {
      throw new Error("Railway returned a different deployment identity");
    }
    const status = result.data.deployment.status;
    dependencies.observe(`Railway deployment ${deploymentId}: ${status}`);
    if (status === "SUCCESS") return;
    if (failedStatuses.has(status)) {
      throw new Error(`Railway deployment ${deploymentId} ended with ${status}`);
    }
    await dependencies.wait(deploymentPollInterval);
  }
  throw new Error(`Railway deployment ${deploymentId} did not reach SUCCESS`);
};

const awaitReleaseIdentity = async (
  input: RailwayReleaseRequest,
  dependencies: RailwayReleaseDependencies,
  apiOrigin: string
): Promise<void> => {
  for (let attempt = 0; attempt < dependencies.maxHealthChecks; attempt += 1) {
    try {
      const health = await decodeJson(
        await dependencies.request(`${apiOrigin}/health`, {
          headers: { Accept: "application/json" },
        }),
        Schema.decodeUnknownSync(HealthResponse)
      );
      if (
        health.gitRevision === input.gitRevision &&
        health.contractDigest === input.contractDigest
      ) {
        return;
      }
    } catch {
      // Railway can report success immediately before the public origin switches revisions.
    }
    await dependencies.wait(healthPollInterval);
  }
  throw new Error("server health identity did not match the release");
};

/**
 * Requests one Railway Git deployment for an exact connected-repository commit, waits for its
 * terminal provider status, then accepts it only when public health reports the same immutable
 * revision and contract digest. Provider and identity failures stop before any web deployment.
 */
export const deployRailwayRelease = async (
  input: RailwayReleaseRequest,
  dependencies: RailwayReleaseDependencies = liveDependencies
): Promise<string> => {
  const gitRevision = Schema.decodeUnknownSync(GitRevision)(input.gitRevision);
  Schema.decodeUnknownSync(ContractDigest)(input.contractDigest);
  const apiOrigin = checkedOrigin(input.apiOrigin);
  if (input.apiToken === "" || input.serviceId === "" || input.environmentId === "") {
    throw new Error("Railway release configuration is incomplete");
  }

  const deploymentId = await requestDeployment(input, dependencies, gitRevision);
  await awaitDeployment(deploymentId, input.apiToken, dependencies);
  await awaitReleaseIdentity(input, dependencies, apiOrigin);
  dependencies.observe(`Railway deployment ${deploymentId}: verified release identity`);
  return deploymentId;
};

const requiredEnvironment = (name: string): string => {
  const value = Bun.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

if (import.meta.main) {
  const deploymentId = await deployRailwayRelease({
    apiToken: requiredEnvironment("RAILWAY_API_TOKEN"),
    serviceId: requiredEnvironment("RAILWAY_SERVICE_ID"),
    environmentId: requiredEnvironment("RAILWAY_ENVIRONMENT_ID"),
    gitRevision: requiredEnvironment("RELEASE_GIT_SHA"),
    contractDigest: requiredEnvironment("RELEASE_CONTRACT_DIGEST"),
    apiOrigin: requiredEnvironment("PRODUCTION_API_ORIGIN"),
  });
  await appendFile(requiredEnvironment("GITHUB_OUTPUT"), `deployment-id=${deploymentId}\n`);
}
