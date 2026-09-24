import { it } from "@effect/vitest";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import type { TelemetryService, TelemetryWorkRecord } from "@fidy/server/telemetry";
import { Effect, Result } from "effect";
import { describe, expect } from "vitest";
import coreWorker, { makeCoreWorker } from "../../apps/server/cloudflare/core-worker";
import { resolveDeploymentConfiguration, resolveStateBackend } from "./deployment-configuration";
import { edgeSecurityPolicy } from "./edge-security";
import publicWorker, { makePublicWorker } from "../../apps/server/cloudflare/public-worker";
import { makeWorkerTelemetry } from "../../apps/server/cloudflare/telemetry";
import {
  localCanonicalReadBearer,
  productionTopology,
} from "../../apps/server/cloudflare/topology";

const gitRevision = "0123456789abcdef0123456789abcdef01234567";
const contractDigest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const privateFailureDetail =
  "D1_ERROR: no such table: categories; SELECT secret_value FROM internal_topology";

const failDatabaseOperation = (): never => {
  throw new Error(privateFailureDetail);
};

const failingDatabase: D1Database = {
  batch: failDatabaseOperation,
  dump: failDatabaseOperation,
  exec: failDatabaseOperation,
  prepare: failDatabaseOperation,
  withSession: failDatabaseOperation,
};

const unusedAiBinding = {
  run: (): Promise<never> => Promise.reject(new Error("Unused Workers AI binding")),
};

const coreEnvironment = {
  AI: unusedAiBinding,
  CONTRACT_DIGEST: contractDigest,
  DB: failingDatabase,
  HOSTED_AI_MODEL: approvedWorkersAiModel,
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  WOMPI_ENVIRONMENT: "",
  WOMPI_PUBLIC_KEY: "",
  WOMPI_PRIVATE_KEY: "",
  WOMPI_INTEGRITY_SECRET: "",
  USER_TRANSACTION_COORDINATOR: {
    getByName: (): Pick<Fetcher, "fetch"> => ({
      fetch: (): Promise<Response> => Promise.reject(new Error("unused")),
    }),
  },
  KAPSO_API_KEY: "",
  KAPSO_WEBHOOK_SECRET: "",
  CLOUDFLARE_ACCESS_ISSUER: "",
  CLOUDFLARE_ACCESS_AUDIENCE: "",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
  RELEASE_GIT_SHA: gitRevision,
};

const collectingTelemetry = (records: Array<TelemetryWorkRecord>): TelemetryService =>
  makeWorkerTelemetry((record) => {
    records.push(record);
  });

type PublicEnvironment = Parameters<typeof publicWorker.fetch>[1];

const makePublicEnvironment = (overrides: Partial<PublicEnvironment> = {}): PublicEnvironment => ({
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  CORE: { fetch: () => Promise.reject(new Error("unexpected Core delegation")) },
  LOCAL_CANONICAL_READ_BEARER: localCanonicalReadBearer,
  PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
  RELEASE_GIT_SHA: gitRevision,
  ...overrides,
});

describe("Deployment configuration", () => {
  it("selects remote state only for the supported Production stage", () => {
    expect(resolveStateBackend({ development: true, stage: "dev-test" })).toBe("local");
    expect(resolveStateBackend({ development: false, stage: "production" })).toBe("cloudflare");
    expect(resolveStateBackend({ development: false, stage: "staging" })).toBe("memory");
    expect(resolveStateBackend({ development: false, stage: "placeholder" })).toBe("memory");
  });

  it("uses bounded placeholder metadata only for local emulation", () => {
    const configuration = resolveDeploymentConfiguration({
      contractDigest: "",
      development: true,
      gitRevision: "",
      stage: "dev-test",
    });

    expect(Result.isSuccess(configuration)).toBe(true);
    if (Result.isSuccess(configuration)) {
      expect(configuration.success).toEqual({
        contractDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        gitRevision: "0000000000000000000000000000000000000000",
      });
    }
  });

  it.each([
    { contractDigest, gitRevision, stage: "staging" },
    { contractDigest: "", gitRevision, stage: "production" },
    { contractDigest, gitRevision: "", stage: "production" },
    {
      contractDigest: "0000000000000000000000000000000000000000000000000000000000000000",
      gitRevision,
      stage: "production",
    },
  ])("rejects an unsupported or unidentifiable remote deployment", (input) => {
    const configuration = resolveDeploymentConfiguration({ development: false, ...input });

    expect(Result.isFailure(configuration)).toBe(true);
  });

  it("accepts exact immutable Production metadata", () => {
    const configuration = resolveDeploymentConfiguration({
      contractDigest,
      development: false,
      gitRevision,
      stage: "production",
    });

    expect(Result.isSuccess(configuration)).toBe(true);
    if (Result.isSuccess(configuration)) {
      expect(configuration.success).toEqual({ contractDigest, gitRevision });
    }
  });
});

describe("Production topology contract", () => {
  it("assigns only the agreed public hostnames and apex redirect", () => {
    expect(productionTopology.web).toEqual({
      adoptExistingWorker: true,
      hostname: "app.fidyapp.com",
      localPort: 5173,
      redirects: ["fidyapp.com"],
      workerName: "fidy-web",
      workersDev: false,
    });
    expect(productionTopology.ingress.hostname).toBe("api.fidyapp.com");
    expect(productionTopology.core).toEqual({
      d1Binding: "DB",
      localPort: 8788,
      workersDev: false,
    });
  });

  it("keeps every edge enforcement path free of human challenges", () => {
    expect(Object.values(edgeSecurityPolicy.rulesets).map(({ phase }) => phase)).toEqual([
      "http_request_firewall_custom",
      "ddos_l7",
      "http_request_firewall_managed",
      "http_ratelimit",
    ]);
    expect(JSON.stringify(edgeSecurityPolicy.rulesets)).not.toContain("challenge");
    expect(edgeSecurityPolicy.rulesets.customFirewall.rules[0]).toMatchObject({
      action: "skip",
      actionParameters: {
        phases: ["http_request_sbfm"],
        products: ["bic", "hot", "securityLevel", "uaBlock", "zoneLockdown"],
      },
      expression: '(http.host eq "api.fidyapp.com")',
    });
    expect(edgeSecurityPolicy.rulesets.managedFirewall.rules[0]).toMatchObject({
      action: "execute",
      actionParameters: { id: "77454fe2d30c4220b5701f6fdfb893ba" },
    });
    expect(edgeSecurityPolicy.rulesets.managedFirewall.rules[0]).not.toHaveProperty(
      "actionParameters.overrides"
    );
    expect(edgeSecurityPolicy.rulesets.httpDdos.rules[0]).toMatchObject({
      actionParameters: { overrides: { action: "block", sensitivityLevel: "default" } },
    });
  });

  it("permits declared canonical methods through production ingress for Worker-level route enforcement", () => {
    expect(edgeSecurityPolicy.rulesets.customFirewall.rules[2]).toMatchObject({
      action: "block",
      expression:
        '(http.host eq "api.fidyapp.com" and not (http.request.method in {"GET" "POST" "OPTIONS" "DELETE" "PUT" "PATCH"}))',
    });
  });

  it("uses one launch-zone-compatible IP budget for every published or reserved HTTP path", () => {
    const rateLimits = edgeSecurityPolicy.rulesets.rateLimits.rules;

    expect(rateLimits).toHaveLength(1);
    expect(rateLimits[0]?.expression).toContain('"/providers/kapso/callback"');
    expect(rateLimits[0]).toMatchObject({
      action: "block",
      ratelimit: {
        characteristics: ["cf.colo.id", "ip.src"],
        mitigationTimeout: 10,
        period: 10,
        requestsPerPeriod: 60,
      },
    });
  });

  it("assigns proof and replay ownership to every reserved provider ingress", () => {
    const providerPolicies = [
      edgeSecurityPolicy.reservedIngress.emailEvent,
      ...Object.values(edgeSecurityPolicy.reservedIngress.httpCallbacks),
    ];

    expect(providerPolicies.map(({ provider }) => provider)).toEqual([
      "cloudflare-email",
      "kapso",
      "wompi",
    ]);
    expect(providerPolicies.every(({ proof }) => proof.includes("replay"))).toBe(true);
    const expression = edgeSecurityPolicy.rulesets.rateLimits.rules[0]?.expression ?? "";
    for (const callback of Object.values(edgeSecurityPolicy.reservedIngress.httpCallbacks)) {
      expect(expression).toContain(`"${callback.path}"`);
    }
    expect(expression).toContain('starts_with(http.request.uri.path, "/budgets/")');
    expect(expression).not.toContain("http.host");
  });

  it("pins local ports for the browser-to-ingress and ingress-to-Core path", () => {
    expect(productionTopology.ingress.localPort).toBe(8787);
    expect(productionTopology.core.localPort).toBe(8788);
  });

  it("exposes Core only as the ingress service binding", () => {
    expect(productionTopology.ingress.coreBinding).toBe("CORE");
    expect(productionTopology.ingress).not.toHaveProperty("d1Binding");
    expect(productionTopology.core).not.toHaveProperty("hostname");
  });
});

describe("Cloudflare Worker topology", () => {
  it.effect("returns only bounded release and health metadata from Core", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        coreWorker.fetch(new Request("https://core.internal/health"), coreEnvironment)
      );
      const body = yield* Effect.promise(() => response.json());

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({
        contractDigest,
        gitRevision,
        status: "available",
      });
    })
  );

  it.effect("fails closed without disclosing malformed release configuration", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        coreWorker.fetch(new Request("https://core.internal/health"), {
          ...coreEnvironment,
          CONTRACT_DIGEST: "secret configuration",
          HOSTED_AI_MODEL: "unsupported private model",
          RELEASE_GIT_SHA: "wrong",
        })
      );
      const body = response.clone();
      const json = yield* Effect.promise(() => response.json());
      const text = yield* Effect.promise(() => body.text());

      expect(response.status).toBe(503);
      expect(json).toEqual({ status: "unavailable" });
      expect(text).not.toContain("secret configuration");
    })
  );

  it.effect("reaches health through the Core service binding", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/health"),
          makePublicEnvironment({
            CORE: {
              fetch: (request) => {
                const coreRequest = new Request(request);
                requests.push(coreRequest);
                return Promise.resolve(coreWorker.fetch(coreRequest, coreEnvironment));
              },
            },
          })
        )
      );
      const body = yield* Effect.promise(() => response.json());

      expect(requests).toHaveLength(1);
      const coreRequest = requests.at(0);
      expect(coreRequest).toBeDefined();
      expect(new URL(coreRequest?.url ?? "https://invalid.example").pathname).toBe("/health");
      expect(response.status).toBe(200);
      expect(body).toEqual({
        contractDigest,
        gitRevision,
        status: "available",
      });
    })
  );

  it.effect("gives each Worker invocation one closed telemetry span", () =>
    Effect.gen(function* () {
      const records: Array<TelemetryWorkRecord> = [];
      const telemetry = collectingTelemetry(records);
      const observedCore = makeCoreWorker(telemetry);
      const observedPublic = makePublicWorker(telemetry);
      const response = yield* Effect.promise(() =>
        observedPublic.fetch(
          new Request("https://api.fidyapp.com/health"),
          makePublicEnvironment({
            CORE: {
              fetch: (request) => observedCore.fetch(new Request(request), coreEnvironment),
            },
          })
        )
      );

      expect(response.status).toBe(200);
      expect(records).toHaveLength(2);
      expect(records.map(({ operation }) => operation).sort()).toEqual([
        "worker.core.fetch",
        "worker.public.fetch",
      ]);
      for (const record of records) {
        expect(record).toMatchObject({
          release: gitRevision,
          provider: "cloudflare-workers",
          statusClass: "2xx",
          outcome: "succeeded",
          attempt: 1,
        });
        expect(Object.keys(record).sort()).toEqual([
          "attempt",
          "latencyMilliseconds",
          "operation",
          "outcome",
          "provider",
          "release",
          "statusClass",
        ]);
      }
    })
  );

  it.effect("retains one owning span when runtime release metadata is malformed", () =>
    Effect.gen(function* () {
      const records: Array<TelemetryWorkRecord> = [];
      const observedPublic = makePublicWorker(collectingTelemetry(records));
      const response = yield* Effect.promise(() =>
        observedPublic.fetch(
          new Request("https://api.fidyapp.com/not-published"),
          makePublicEnvironment({
            CORE: { fetch: () => Promise.resolve(Response.json({ unexpected: true })) },
            RELEASE_GIT_SHA: "not-a-release",
          })
        )
      );

      expect(response.status).toBe(404);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        release: "unknown",
        operation: "worker.public.fetch",
        outcome: "rejected",
        statusClass: "4xx",
      });
    })
  );

  it.effect("permits credentialed browser reads only from the configured application origin", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/categories", {
            headers: {
              authorization: `Bearer ${localCanonicalReadBearer}`,
              origin: "https://app.fidyapp.com",
            },
          }),
          makePublicEnvironment({
            CORE: { fetch: () => Promise.resolve(Response.json({ data: [], next: [] })) },
          })
        )
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.fidyapp.com");
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("vary")).toContain("Origin");
    })
  );

  it.effect("rejects an unapproved browser origin before invoking Core", () =>
    Effect.gen(function* () {
      let delegated = false;
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/categories", {
            headers: { origin: "https://attacker.example" },
          }),
          makePublicEnvironment({
            CORE: {
              fetch: () => {
                delegated = true;
                return Promise.resolve(Response.json({}));
              },
            },
          })
        )
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(delegated).toBe(false);
    })
  );

  it.effect("fails closed when the configured browser origin is outside the topology", () =>
    Effect.gen(function* () {
      let delegated = false;
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/health"),
          makePublicEnvironment({
            BROWSER_ORIGIN: "https://attacker.example",
            CORE: {
              fetch: () => {
                delegated = true;
                return Promise.resolve(Response.json({}));
              },
            },
          })
        )
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(delegated).toBe(false);
    })
  );

  it.effect("answers only bounded preflight requests for an owned browser route", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/categories", {
            headers: {
              "access-control-request-headers": "authorization",
              "access-control-request-method": "GET",
              origin: "https://app.fidyapp.com",
            },
            method: "OPTIONS",
          }),
          makePublicEnvironment()
        )
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.fidyapp.com");
      expect(response.headers.get("access-control-allow-methods")).toBe("GET");
      expect(response.headers.get("access-control-allow-headers")).toBe("authorization");
      expect(response.headers.get("access-control-max-age")).toBe("600");
    })
  );

  it.effect("applies non-cacheable API security headers to rejection responses", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(new Request("https://api.fidyapp.com/internal"), makePublicEnvironment())
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; frame-ancestors 'none'"
      );
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-site");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    })
  );

  it.effect("rejects an unauthenticated Categories request before querying D1", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/categories"),
          makePublicEnvironment({
            CORE: { fetch: (request) => coreWorker.fetch(new Request(request), coreEnvironment) },
          })
        )
      );
      const body = yield* Effect.promise(() => response.json());

      expect(response.status).toBe(401);
      expect(body).toEqual({
        error: { code: "unauthenticated", message: "Present a valid credential and retry." },
        next: [],
      });
    })
  );

  it.effect("reports each failed Worker Work once without exposing SQL or topology", () =>
    Effect.gen(function* () {
      const records: Array<TelemetryWorkRecord> = [];
      const telemetry = collectingTelemetry(records);
      const observedCore = makeCoreWorker(telemetry);
      const observedPublic = makePublicWorker(telemetry);
      const response = yield* Effect.promise(() =>
        observedPublic.fetch(
          new Request("https://api.fidyapp.com/categories", {
            headers: { authorization: `Bearer ${localCanonicalReadBearer}` },
          }),
          makePublicEnvironment({
            CORE: {
              fetch: (request) =>
                observedCore.fetch(new Request(request), {
                  ...coreEnvironment,
                  DB: failingDatabase,
                }),
            },
          })
        )
      );
      const text = yield* Effect.promise(() => response.text());

      expect(response.status).toBe(503);
      expect(text).toBe(
        '{"error":{"code":"unavailable","message":"Categories are temporarily unavailable. Retry later."},"next":[]}'
      );
      expect(text).not.toContain("no such table");
      expect(text).not.toContain("SELECT");
      expect(text).not.toContain("internal_topology");
      expect(text).not.toContain("DB");
      expect(records).toHaveLength(2);
      expect(records.every(({ outcome }) => outcome === "failed")).toBe(true);
      expect(records.every(({ statusClass }) => statusClass === "5xx")).toBe(true);
      expect(records.filter(({ operation }) => operation === "worker.core.fetch")).toHaveLength(1);
      expect(records.filter(({ operation }) => operation === "worker.public.fetch")).toHaveLength(
        1
      );
      expect(records).not.toContainEqual(expect.objectContaining({ sql: privateFailureDetail }));
    })
  );

  it.effect("rejects other public routes before invoking Core", () =>
    Effect.gen(function* () {
      let delegated = false;
      const response = yield* Effect.promise(() =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/internal"),
          makePublicEnvironment({
            CORE: {
              fetch: () => {
                delegated = true;
                return Promise.resolve(Response.json({}));
              },
            },
          })
        )
      );

      expect(response.status).toBe(404);
      expect(delegated).toBe(false);
    })
  );
});
