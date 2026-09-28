// oxlint-disable typescript/consistent-type-assertions -- Deliberately incomplete Core fixture proves rejection before any synthetic binding.
import { describe, expect, it } from "vitest";
import { verifySmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";
import {
  type SmokeEnvironment,
  handleSmoke,
} from "../../apps/server/cloudflare/runtime/smoke-work";
import publicWorker from "../../apps/server/cloudflare/public-worker";

const revision = "0123456789abcdef0123456789abcdef01234567";
const digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const version = "dc8dcd28-271b-4367-9840-6c244f84cb40";
const candidate = { gitRevision: revision, contractDigest: digest, workerVersionId: version };

describe("production smoke identity", () => {
  it("refuses a healthy stable Worker when the requested candidate override was ignored", () => {
    expect(
      verifySmokeIdentity(candidate, {
        ...candidate,
        workerVersionId: "db7cd8d3-4425-4fe7-8c81-01bf963b6067",
      })
    ).toBe(false);
  });

  it("requires the exact candidate version and compatible release metadata", () => {
    expect(verifySmokeIdentity(candidate, candidate)).toBe(true);
    expect(verifySmokeIdentity(candidate, { ...candidate, contractDigest: "0".repeat(64) })).toBe(
      false
    );
    expect(verifySmokeIdentity(candidate, { ...candidate, gitRevision: "0".repeat(40) })).toBe(
      false
    );
  });
});

describe("production smoke ingress", () => {
  it("rejects unauthorized smoke requests before the private Core binding or any work runs", async () => {
    let coreCalls = 0;
    const environment = {
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      CORE: {
        fetch: (): Promise<Response> => {
          coreCalls++;
          return Promise.resolve(
            Response.json({
              status: "passed",
              core: candidate,
              manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
            })
          );
        },
      },
      LOCAL_CANONICAL_READ_BEARER: "",
      PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
      RELEASE_GIT_SHA: revision,
      CONTRACT_DIGEST: digest,
      SMOKE_PROOF: "a".repeat(64),
      CF_VERSION_METADATA: { id: version, tag: "", timestamp: "" },
    };
    const refusals = await Promise.all(
      [new Headers(), new Headers({ "x-fidy-smoke-proof": "invalid" })].map((headers) =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/internal/release-smoke", {
            method: "POST",
            headers,
          }),
          environment
        )
      )
    );
    for (const response of refusals) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(coreCalls).toBe(0);
    const authorized = await publicWorker.fetch(
      new Request("https://api.fidyapp.com/internal/release-smoke", {
        method: "POST",
        headers: {
          "x-fidy-smoke-proof": "a".repeat(64),
          "cloudflare-workers-version-overrides":
            'fidy-core="dc8dcd28-271b-4367-9840-6c244f84cb40"',
        },
      }),
      environment
    );
    expect(authorized.status).toBe(200);
    expect(coreCalls).toBe(1);
    expect(await authorized.json()).toMatchObject({ public: candidate, core: candidate });
  });

  it("reports the public digest independently rather than copying the Core digest", async () => {
    const response = await publicWorker.fetch(
      new Request("https://api.fidyapp.com/internal/release-smoke", {
        headers: { "x-fidy-smoke-proof": "a".repeat(64) },
      }),
      {
        BROWSER_ORIGIN: "https://app.fidyapp.com",
        CORE: {
          fetch: (): Promise<Response> =>
            Promise.resolve(
              Response.json({
                status: "passed",
                core: candidate,
                manifest: { protocolVersion: 1, asyncWorkVersion: 1 },
              })
            ),
        },
        LOCAL_CANONICAL_READ_BEARER: "",
        PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
        RELEASE_GIT_SHA: revision,
        CONTRACT_DIGEST: "0".repeat(64),
        SMOKE_PROOF: "a".repeat(64),
        CF_VERSION_METADATA: { id: version },
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      core: { contractDigest: digest },
      public: { contractDigest: "0".repeat(64) },
    });
  });

  it("rejects excess authorized probes at the public-to-Core boundary before synthetic work", async () => {
    const actions: string[] = [];
    const blocked = (): never => {
      actions.push("binding");
      throw new Error("synthetic work should not run");
    };
    const coreEnvironment = {
      DB: {
        prepare: (sql: string): object => {
          actions.push(sql.startsWith("INSERT") ? "admission" : "read");
          return {
            bind: (): object => ({
              run: (): Promise<void> => Promise.resolve(),
              first: (): Promise<unknown> => Promise.resolve(null),
            }),
          };
        },
      },
      SMOKE_BUCKET: { put: blocked },
      SMOKE_QUEUE: { send: blocked },
      SMOKE_WORKFLOW: { create: blocked },
      USER_TRANSACTION_COORDINATOR: { getByName: blocked },
      CF_VERSION_METADATA: { id: version },
      SMOKE_PROOF: "a".repeat(64),
      RELEASE_GIT_SHA: revision,
      CONTRACT_DIGEST: digest,
    } as unknown as SmokeEnvironment;
    const response = await publicWorker.fetch(
      new Request("https://api.fidyapp.com/internal/release-smoke", {
        method: "POST",
        headers: { "x-fidy-smoke-proof": "a".repeat(64), "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: 1,
          probeId: "b".repeat(32),
          expectedPublicVersionId: version,
          expectedCoreVersionId: version,
          expectedGitRevision: revision,
          expectedContractDigest: digest,
        }),
      }),
      {
        BROWSER_ORIGIN: "https://app.fidyapp.com",
        CORE: {
          fetch: (request: Request): Promise<Response> => handleSmoke(request, coreEnvironment),
        },
        LOCAL_CANONICAL_READ_BEARER: "",
        PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
        RELEASE_GIT_SHA: revision,
        CONTRACT_DIGEST: digest,
        SMOKE_PROOF: "a".repeat(64),
        CF_VERSION_METADATA: { id: version },
      }
    );
    expect(response.status).toBe(503);
    expect(actions).toEqual(["admission", "read"]);
  });
});
