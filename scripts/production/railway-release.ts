#!/usr/bin/env bun

import { appendFile } from "node:fs/promises";
import { Option, Result, Schema } from "effect";

const railwayGraphqlUrl = "https://backboard.railway.app/graphql/v2";
const deploymentCheckLimit = 120;
const healthCheckLimit = 150;
const deploymentPollInterval = 5_000;
const healthPollInterval = 2_000;
const GitRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const ContractDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const GraphqlFailure = Schema.Struct({
  data: Schema.Null,
  errors: Schema.Array(Schema.Struct({ message: Schema.String })),
});
const TriggerResponse = Schema.Struct({
  data: Schema.Struct({ environmentTriggersDeploy: Schema.Literal(true) }),
});
const AutoDeployResponse = Schema.Struct({
  data: Schema.Struct({
    serviceInstanceAutoDeployUpdate: Schema.Struct({ enabled: Schema.Boolean }),
  }),
});
const LatestDeployment = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  meta: Schema.Struct({ commitHash: GitRevision }),
});
const LatestDeploymentResponse = Schema.Struct({
  data: Schema.Struct({
    serviceInstance: Schema.Struct({
      latestDeployment: Schema.OptionFromNullOr(LatestDeployment),
    }),
  }),
});
const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  gitRevision: GitRevision,
  contractDigest: ContractDigest,
});

const triggerMutation = `mutation environmentTriggersDeploy($projectId: String!, $serviceId: String!, $environmentId: String!) {
  environmentTriggersDeploy(input: {
    projectId: $projectId
    serviceId: $serviceId
    environmentId: $environmentId
  })
}`;
const autoDeployMutation = `mutation serviceInstanceAutoDeployUpdate($projectId: String!, $serviceId: String!, $environmentId: String!, $enabled: Boolean!) {
  serviceInstanceAutoDeployUpdate(input: {
    projectId: $projectId
    serviceId: $serviceId
    environmentId: $environmentId
    enabled: $enabled
  }) { enabled }
}`;
const latestDeploymentQuery = `query latestDeployment($serviceId: String!, $environmentId: String!) {
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    latestDeployment { id status meta }
  }
}`;
const failedStatuses = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

type HttpRequest = (input: string | URL | Request, init: RequestInit) => Promise<Response>;

type RailwayReleaseRequest = {
  readonly apiToken: string;
  readonly projectId: string;
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
  readonly variables: Readonly<Record<string, string | boolean>>;
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

const graphql = async <Value>(input: GraphqlRequest<Value>): Promise<Value> => {
  const response = await input.request(railwayGraphqlUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: input.query, variables: input.variables }),
  });
  if (!response.ok) throw new Error(`deployment provider returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  const failure = Schema.decodeUnknownResult(GraphqlFailure)(body);
  if (Result.isSuccess(failure)) {
    const messages = failure.success.errors.map(({ message }) => message).join("; ");
    throw new Error(`Railway GraphQL failed: ${messages || "unknown provider failure"}`);
  }
  return input.decode(body);
};

const checkedOrigin = (candidate: string): string => {
  const origin = new URL(candidate);
  if (origin.protocol !== "https:" || origin.origin !== candidate) {
    throw new Error("Production API origin must be one exact HTTPS origin");
  }
  return origin.origin;
};

const latestDeployment = async (
  input: RailwayReleaseRequest,
  dependencies: RailwayReleaseDependencies
): Promise<Option.Option<typeof LatestDeployment.Type>> => {
  const result = await graphql({
    request: dependencies.request,
    token: input.apiToken,
    query: latestDeploymentQuery,
    variables: { serviceId: input.serviceId, environmentId: input.environmentId },
    decode: Schema.decodeUnknownSync(LatestDeploymentResponse),
  });
  return result.data.serviceInstance.latestDeployment;
};

const setAutoDeploy = async (
  input: RailwayReleaseRequest,
  dependencies: RailwayReleaseDependencies,
  enabled: boolean
): Promise<void> => {
  const result = await graphql({
    request: dependencies.request,
    token: input.apiToken,
    query: autoDeployMutation,
    variables: {
      projectId: input.projectId,
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      enabled,
    },
    decode: Schema.decodeUnknownSync(AutoDeployResponse),
  });
  if (result.data.serviceInstanceAutoDeployUpdate.enabled !== enabled) {
    throw new Error("Railway returned a different automatic deployment state");
  }
};

const triggerDeployment = async (
  input: RailwayReleaseRequest,
  dependencies: RailwayReleaseDependencies
): Promise<void> => {
  await setAutoDeploy(input, dependencies, true);
  try {
    await graphql({
      request: dependencies.request,
      token: input.apiToken,
      query: triggerMutation,
      variables: {
        projectId: input.projectId,
        serviceId: input.serviceId,
        environmentId: input.environmentId,
      },
      decode: Schema.decodeUnknownSync(TriggerResponse),
    });
  } finally {
    await setAutoDeploy(input, dependencies, false);
  }
};

const awaitDeployment = async (
  input: RailwayReleaseRequest,
  previousDeploymentId: Option.Option<string>,
  dependencies: RailwayReleaseDependencies
): Promise<string> => {
  for (let attempt = 0; attempt < dependencies.maxDeploymentChecks; attempt += 1) {
    const latest = await latestDeployment(input, dependencies);
    if (
      Option.isNone(latest) ||
      Option.exists(previousDeploymentId, (id) => id === latest.value.id)
    ) {
      await dependencies.wait(deploymentPollInterval);
      continue;
    }
    const deployment = latest.value;
    if (deployment.meta.commitHash !== input.gitRevision) {
      throw new Error(
        `Railway selected revision ${deployment.meta.commitHash} instead of ${input.gitRevision}`
      );
    }
    dependencies.observe(`Railway deployment ${deployment.id}: ${deployment.status}`);
    if (deployment.status === "SUCCESS") return deployment.id;
    if (failedStatuses.has(deployment.status)) {
      throw new Error(`Railway deployment ${deployment.id} ended with ${deployment.status}`);
    }
    await dependencies.wait(deploymentPollInterval);
  }
  throw new Error("Railway did not create a successful deployment for the release");
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
 * Triggers the connected Railway service after the caller establishes the release as current,
 * accepts only a new deployment carrying that immutable revision, and then requires public health
 * to report the same revision and contract digest. Provider and identity failures stop before any
 * web deployment.
 */
export const deployRailwayRelease = async (
  input: RailwayReleaseRequest,
  dependencies: RailwayReleaseDependencies = liveDependencies
): Promise<string> => {
  Schema.decodeSync(GitRevision)(input.gitRevision);
  Schema.decodeSync(ContractDigest)(input.contractDigest);
  const apiOrigin = checkedOrigin(input.apiOrigin);
  if (
    input.apiToken === "" ||
    input.projectId === "" ||
    input.serviceId === "" ||
    input.environmentId === ""
  ) {
    throw new Error("Railway release configuration is incomplete");
  }

  await setAutoDeploy(input, dependencies, false);
  const previousDeployment = await latestDeployment(input, dependencies);
  await triggerDeployment(input, dependencies);
  const deploymentId = await awaitDeployment(
    input,
    Option.map(previousDeployment, ({ id }) => id),
    dependencies
  );
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
    projectId: requiredEnvironment("RAILWAY_PROJECT_ID"),
    serviceId: requiredEnvironment("RAILWAY_SERVICE_ID"),
    environmentId: requiredEnvironment("RAILWAY_ENVIRONMENT_ID"),
    gitRevision: requiredEnvironment("RELEASE_GIT_SHA"),
    contractDigest: requiredEnvironment("RELEASE_CONTRACT_DIGEST"),
    apiOrigin: requiredEnvironment("PRODUCTION_API_ORIGIN"),
  });
  await appendFile(requiredEnvironment("GITHUB_OUTPUT"), `deployment-id=${deploymentId}\n`);
}
