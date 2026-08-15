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
  it("deploys the exact connected-repository commit and verifies its health identity", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const responses = requestSequence([
      jsonResponse({ data: { serviceInstanceDeployV2: "deployment-1" } }),
      jsonResponse({ data: { deployment: { id: "deployment-1", status: "BUILDING" } } }),
      jsonResponse({ data: { deployment: { id: "deployment-1", status: "SUCCESS" } } }),
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
    expect(requests[0]?.init.body).toContain(`"commitSha":"${gitRevision}"`);
    expect(requests.at(-1)?.url).toBe("https://api.fidyapp.com/health");
  });

  it("stops before health verification when Railway reports a failed deployment", async () => {
    const request = requestSequence([
      jsonResponse({ data: { serviceInstanceDeployV2: "deployment-1" } }),
      jsonResponse({ data: { deployment: { id: "deployment-1", status: "FAILED" } } }),
    ]);

    await expect(deployRailwayRelease(releaseRequest, dependencies(request))).rejects.toThrow(
      "Railway deployment deployment-1 ended with FAILED"
    );
  });

  it("rejects a healthy server carrying a different immutable release identity", async () => {
    const request = requestSequence([
      jsonResponse({ data: { serviceInstanceDeployV2: "deployment-1" } }),
      jsonResponse({ data: { deployment: { id: "deployment-1", status: "SUCCESS" } } }),
      jsonResponse({ status: "ok", gitRevision: "f".repeat(40), contractDigest }),
    ]);

    await expect(deployRailwayRelease(releaseRequest, dependencies(request, 1))).rejects.toThrow(
      "server health identity did not match the release"
    );
  });
});
