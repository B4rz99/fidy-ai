import { describe, expect, it } from "vitest";
import { type RailwayReleaseDependencies, deployRailwayRelease } from "./railway-release";

const gitRevision = "0123456789abcdef0123456789abcdef01234567";
const contractDigest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const defaultHealthChecks = 3;
const defaultDeploymentChecks = 3;

const jsonResponse = (value: unknown): Response => Response.json(value);

type HttpRequest = (input: string | URL | Request, init: RequestInit) => Promise<Response>;

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const requestSequence = (responses: ReadonlyArray<Response>): HttpRequest => {
  const pending = [...responses];
  return async (): Promise<Response> => {
    const response = pending.shift();
    if (response === undefined) throw new Error("unexpected request");
    return response;
  };
};

const releaseRequest = {
  apiOrigin: "https://api.fidyapp.com",
  apiToken: "railway-token",
  contractDigest,
  environmentId: "production-environment",
  gitRevision,
  projectId: "fidy-project",
  serviceId: "fidy-server",
};

const dependencies = (
  request: HttpRequest,
  maxHealthChecks = defaultHealthChecks
): RailwayReleaseDependencies => ({
  request,
  wait: async (): Promise<void> => undefined,
  maxDeploymentChecks: defaultDeploymentChecks,
  maxHealthChecks,
  observe: (): void => undefined,
});

describe("Railway Production release adapter", () => {
  it("triggers the connected service and verifies the selected revision and health identity", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const priorRevision = "f".repeat(40);
    const responses = requestSequence([
      jsonResponse({
        data: {
          serviceInstance: {
            latestDeployment: {
              id: "deployment-0",
              status: "SUCCESS",
              meta: { commitHash: priorRevision },
            },
          },
        },
      }),
      jsonResponse({ data: { environmentTriggersDeploy: true } }),
      jsonResponse({
        data: {
          serviceInstance: {
            latestDeployment: {
              id: "deployment-1",
              status: "BUILDING",
              meta: { commitHash: gitRevision },
            },
          },
        },
      }),
      jsonResponse({
        data: {
          serviceInstance: {
            latestDeployment: {
              id: "deployment-1",
              status: "SUCCESS",
              meta: { commitHash: gitRevision },
            },
          },
        },
      }),
      jsonResponse({ status: "ok", gitRevision, contractDigest }),
    ]);
    const request: HttpRequest = async (url, init): Promise<Response> => {
      requests.push({ url: requestUrl(url), init });
      return responses(url, init);
    };

    await expect(deployRailwayRelease(releaseRequest, dependencies(request))).resolves.toBe(
      "deployment-1"
    );
    expect(requests[0]?.url).toBe("https://backboard.railway.app/graphql/v2");
    expect(requests[0]?.init.headers).toMatchObject({ Authorization: "Bearer railway-token" });
    expect(requests[1]?.init.body).toContain("environmentTriggersDeploy");
    expect(requests[1]?.init.body).toContain('"projectId":"fidy-project"');
    expect(requests.at(-1)?.url).toBe("https://api.fidyapp.com/health");
  });

  it("stops before health verification when Railway reports a failed deployment", async () => {
    const request = requestSequence([
      jsonResponse({ data: { serviceInstance: { latestDeployment: null } } }),
      jsonResponse({ data: { environmentTriggersDeploy: true } }),
      jsonResponse({
        data: {
          serviceInstance: {
            latestDeployment: {
              id: "deployment-1",
              status: "FAILED",
              meta: { commitHash: gitRevision },
            },
          },
        },
      }),
    ]);

    await expect(deployRailwayRelease(releaseRequest, dependencies(request))).rejects.toThrow(
      "Railway deployment deployment-1 ended with FAILED"
    );
  });

  it("rejects a provider trigger that selects a different repository revision", async () => {
    const selectedRevision = "f".repeat(40);
    const request = requestSequence([
      jsonResponse({ data: { serviceInstance: { latestDeployment: null } } }),
      jsonResponse({ data: { environmentTriggersDeploy: true } }),
      jsonResponse({
        data: {
          serviceInstance: {
            latestDeployment: {
              id: "deployment-1",
              status: "BUILDING",
              meta: { commitHash: selectedRevision },
            },
          },
        },
      }),
    ]);

    await expect(deployRailwayRelease(releaseRequest, dependencies(request))).rejects.toThrow(
      `Railway selected revision ${selectedRevision} instead of ${gitRevision}`
    );
  });

  it("reports Railway GraphQL failures before decoding successful data", async () => {
    const request = requestSequence([
      jsonResponse({ data: null, errors: [{ message: "Cannot deploy this trigger" }] }),
    ]);

    await expect(deployRailwayRelease(releaseRequest, dependencies(request))).rejects.toThrow(
      "Railway GraphQL failed: Cannot deploy this trigger"
    );
  });

  it("rejects a healthy server carrying a different immutable release identity", async () => {
    const request = requestSequence([
      jsonResponse({ data: { serviceInstance: { latestDeployment: null } } }),
      jsonResponse({ data: { environmentTriggersDeploy: true } }),
      jsonResponse({
        data: {
          serviceInstance: {
            latestDeployment: {
              id: "deployment-1",
              status: "SUCCESS",
              meta: { commitHash: gitRevision },
            },
          },
        },
      }),
      jsonResponse({ status: "ok", gitRevision: "f".repeat(40), contractDigest }),
    ]);

    await expect(deployRailwayRelease(releaseRequest, dependencies(request, 1))).rejects.toThrow(
      "server health identity did not match the release"
    );
  });
});
