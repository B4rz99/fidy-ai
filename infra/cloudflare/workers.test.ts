import { it } from "@effect/vitest";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import type { TelemetryService, TelemetryWorkRecord } from "@fidy/server/telemetry";
import { type Cause, Clock, DateTime, Effect, Result, Schema } from "effect";
import { describe, expect, vi } from "vitest";
import { Miniflare } from "miniflare";
import coreWorker, { makeCoreWorker } from "../../apps/server/cloudflare/core-worker";
import { resolveDeploymentConfiguration, resolveStateBackend } from "./deployment-configuration";
import { edgeSecurityPolicy } from "./edge-security";
import {
  SyntheticBindings,
  unavailableBucket,
  unavailableQueue,
  unavailableWorkflow,
} from "./incomplete-platform-fixture";
import publicWorker, { makePublicWorker } from "../../apps/server/cloudflare/public-worker";
import { makeWorkerTelemetry } from "../../apps/server/cloudflare/runtime/telemetry";
import {
  localCanonicalReadBearer,
  productionTopology,
} from "../../apps/server/cloudflare/runtime/topology";

const withIsolatedD1 = <A, E, R>(
  name: string,
  use: (db: D1Database) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | Cause.UnknownError, R> =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.sync(
        () =>
          new Miniflare({
            workers: [
              {
                config: {
                  name,
                  type: "worker",
                  compatibilityDate: "2026-09-08",
                  env: { DB: { id: name, type: "d1" } },
                  manifest: {
                    mainModule: "index.mjs",
                    modules: {
                      "index.mjs": {
                        contents: "export default { fetch() { return new Response('ok') } }",
                        type: "esm",
                      },
                    },
                  },
                },
              },
            ],
          })
      ),
      (instance) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() => instance.ready);
          const db = yield* Effect.tryPromise(() => instance.getD1Database("DB"));
          return yield* use(db);
        }),
      (instance) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
    )
  );

const withMethods = SyntheticBindings.withMethods;
const gitRevision = "0123456789abcdef0123456789abcdef01234567";
const contractDigest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const smokeBody = (coreVersion: string): string =>
  JSON.stringify({
    protocolVersion: 1,
    probeId: "b".repeat(32),
    expectedPublicVersionId: "dc8dcd28-271b-4367-9840-6c244f84cb40",
    expectedCoreVersionId: coreVersion,
    expectedGitRevision: gitRevision,
    expectedContractDigest: contractDigest,
  });

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

const coreEnvironment: Parameters<typeof coreWorker.fetch>[1] = {
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

const queueBatch = (body: unknown): MessageBatch<unknown> => ({
  queue: "OnboardingEmailQueue",
  messages: [
    {
      id: "opaque-test-message",
      timestamp: DateTime.toDate(DateTime.makeUnsafe(0)),
      body,
      attempts: 1,
      retry: () => {},
      ack: () => {},
    },
  ],
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  retryAll: () => {},
  ackAll: () => {},
});

const scheduledController: ScheduledController = {
  scheduledTime: 0,
  cron: "* * * * *",
  noRetry: () => {},
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

describe("Core smoke adapter", () => {
  it.effect("routes the reserved endpoint and dedicated Queue without touching User work", () =>
    Effect.gen(function* () {
      const proof = "a".repeat(64);
      const environment: Parameters<typeof coreWorker.fetch>[1] = {
        ...coreEnvironment,
        SMOKE_PROOF: proof,
        CF_VERSION_METADATA: { id: "dc8dcd28-271b-4367-9840-6c244f84cb40" },
        SMOKE_QUEUE_NAME: "SmokeQueue",
        SMOKE_QUEUE: withMethods(unavailableQueue, { send: failDatabaseOperation }),
        SMOKE_BUCKET: withMethods(unavailableBucket, { put: failDatabaseOperation }),
        SMOKE_WORKFLOW: withMethods(unavailableWorkflow, { create: failDatabaseOperation }),
      };
      const response = yield* Effect.tryPromise(() =>
        coreWorker.fetch(
          new Request("https://core.internal/internal/release-smoke", {
            method: "POST",
            headers: { "x-fidy-smoke-proof": proof, "content-type": "application/json" },
            body: smokeBody("db7cd8d3-4425-4fe7-8c81-01bf963b6067"),
          }),
          environment
        )
      );
      expect(response.status).toBe(503);

      let acked = false;
      const queueEnvironment: Parameters<typeof coreWorker.queue>[1] = {
        ...environment,
        DB: withMethods(failingDatabase, {
          prepare: (): object => ({
            bind: (): object => ({
              first: (): Promise<{ expires_at_ms: number }> =>
                Promise.resolve({ expires_at_ms: 0 }),
            }),
          }),
        }),
      };
      const fixtureMessage = queueBatch({}).messages.at(0);
      if (fixtureMessage === undefined) throw new Error("Missing Queue fixture message");
      yield* Effect.tryPromise(() =>
        coreWorker.queue(
          {
            ...queueBatch({ protocolVersion: 1, probeId: "b".repeat(32), gitRevision }),
            queue: "SmokeQueue",
            messages: [
              {
                ...fixtureMessage,
                body: { protocolVersion: 1, probeId: "b".repeat(32), gitRevision },
                ack: (): void => {
                  acked = true;
                },
              },
            ],
          },
          queueEnvironment
        )
      );
      expect(acked).toBe(true);
    })
  );

  it.effect(
    "publishes an admitted probe through Core fetch and hands it to the Workflow via Core Queue",
    () =>
      Effect.gen(function* () {
        let work: unknown;
        let started: unknown;
        let acked = false;
        let claimed = false;
        const database = {
          prepare: (sql: string): object => ({
            all: (): Promise<object> => Promise.resolve({}),
            bind: (): object => ({
              run: (): Promise<object> => {
                if (sql.startsWith("UPDATE")) claimed = true;
                return Promise.resolve({ meta: { changes: 1 } });
              },
              first: (): Promise<unknown> =>
                Promise.resolve(
                  sql.includes("expires_at_ms FROM")
                    ? { expires_at_ms: Number.MAX_SAFE_INTEGER }
                    : {
                        git_revision: gitRevision,
                        expires_at_ms: Number.MAX_SAFE_INTEGER,
                        status: claimed ? "queued" : "pending",
                      }
                ),
            }),
          }),
        };
        const environment: Parameters<typeof coreWorker.fetch>[1] = {
          ...coreEnvironment,
          DB: withMethods(failingDatabase, { prepare: database.prepare }),
          SMOKE_PROOF: "a".repeat(64),
          CF_VERSION_METADATA: { id: "dc8dcd28-271b-4367-9840-6c244f84cb40" },
          SMOKE_QUEUE_NAME: "SmokeQueue",
          SMOKE_QUEUE: withMethods(unavailableQueue, {
            send: (value: unknown): Promise<void> => {
              work = value;
              return Promise.resolve();
            },
          }),
          SMOKE_BUCKET: withMethods(unavailableBucket, {
            put: (): Promise<void> => Promise.resolve(),
            get: (): Promise<object> => Promise.resolve({}),
          }),
          SMOKE_WORKFLOW: withMethods(unavailableWorkflow, {
            create: (value: unknown): Promise<object> => {
              started = value;
              return Promise.resolve({});
            },
          }),
          USER_TRANSACTION_COORDINATOR: {
            getByName: (): Pick<Fetcher, "fetch"> => ({
              fetch: (): Promise<Response> =>
                Promise.resolve(Response.json({ status: "compatible" })),
            }),
          },
          KAPSO_API_KEY: "configured",
          KAPSO_WEBHOOK_SECRET: "configured",
          RESEND_API_KEY: "configured",
          WOMPI_PRIVATE_KEY: "configured",
          WOMPI_INTEGRITY_SECRET: "configured",
          WOMPI_EVENT_SECRET: "configured",
        };
        const response = yield* Effect.tryPromise(() =>
          coreWorker.fetch(
            new Request("https://core.internal/internal/release-smoke", {
              method: "POST",
              headers: { "x-fidy-smoke-proof": "a".repeat(64), "content-type": "application/json" },
              body: smokeBody("dc8dcd28-271b-4367-9840-6c244f84cb40"),
            }),
            environment
          )
        );
        expect(response.status).toBe(202);
        expect(work).toEqual({ protocolVersion: 1, probeId: "b".repeat(32), gitRevision });
        const fixtureMessage = queueBatch({}).messages.at(0);
        if (fixtureMessage === undefined) throw new Error("Missing Queue fixture message");
        yield* Effect.tryPromise(() =>
          coreWorker.queue(
            {
              ...queueBatch(work),
              queue: "SmokeQueue",
              messages: [
                {
                  ...fixtureMessage,
                  body: work,
                  ack: (): void => {
                    acked = true;
                  },
                },
              ],
            },
            environment
          )
        );
        expect(acked).toBe(true);
        expect(started).toEqual({
          id: `release-smoke-${"b".repeat(32)}`,
          params: work,
        });
      })
  );
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
    const expression = rateLimits[0]?.expression ?? "";
    for (const path of [
      "/providers/kapso/callback",
      "/providers/wompi/billing-events",
      "/web/hosted-turns",
      "/web/hosted-turns/delivery",
      "/web/subscription/card-enrollments/prepare",
      "/web/subscription/card-enrollments/submit",
    ]) {
      expect(expression).toContain(`"${path}"`);
    }
    for (const prefix of [
      "/web/subscription/card-enrollments/",
      "/web/subscription/billing-attempts/",
    ]) {
      expect(expression).toContain(`starts_with(http.request.uri.path, "${prefix}")`);
    }
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
      const response = yield* Effect.tryPromise(() =>
        coreWorker.fetch(new Request("https://core.internal/health"), coreEnvironment)
      );
      const body = yield* Effect.tryPromise(() => response.json());

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
      const response = yield* Effect.tryPromise(() =>
        coreWorker.fetch(new Request("https://core.internal/health"), {
          ...coreEnvironment,
          CONTRACT_DIGEST: "secret configuration",
          HOSTED_AI_MODEL: "unsupported private model",
          RELEASE_GIT_SHA: "wrong",
        })
      );
      const body = response.clone();
      const json = yield* Effect.tryPromise(() => response.json());
      const text = yield* Effect.tryPromise(() => body.text());

      expect(response.status).toBe(503);
      expect(json).toEqual({ status: "unavailable" });
      expect(text).not.toContain("secret configuration");
    })
  );

  it.effect("reaches health through the Core service binding", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = [];
      const response = yield* Effect.tryPromise(() =>
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
      const body = yield* Effect.tryPromise(() => response.json());

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
      const response = yield* Effect.tryPromise(() =>
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

  it.effect(
    "reports an unavailable Queue invocation once without exposing its payload or changing rejection",
    () =>
      Effect.gen(function* () {
        const records: Array<TelemetryWorkRecord> = [];
        const worker = makeCoreWorker(collectingTelemetry(records));
        const payload = "private-queue-payload-canary";
        const batch = queueBatch(payload);

        yield* Effect.tryPromise(() =>
          expect(worker.queue(batch, coreEnvironment)).rejects.toThrow(
            "Onboarding email unavailable"
          )
        );
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          release: gitRevision,
          operation: "worker.core.queue",
          outcome: "failed",
          attempt: 1,
        });
        const exported = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Array(Schema.Unknown))
        )(records);
        expect(exported).not.toContain(payload);
      })
  );

  it.effect("does not let a throwing telemetry exporter acknowledge failed Queue Work", () =>
    Effect.gen(function* () {
      const worker = makeCoreWorker(
        makeWorkerTelemetry(() => {
          throw new Error("export unavailable");
        })
      );
      const batch = queueBatch("no-provider-binding");

      yield* Effect.tryPromise(() =>
        expect(worker.queue(batch, coreEnvironment)).rejects.toThrow("Onboarding email unavailable")
      );
    })
  );
});

it.live("routes the private canary Queue to a real Workflow handoff, not to application work", () =>
  withIsolatedD1("canary-queue-test", (db) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TABLE operational_canary (kind TEXT PRIMARY KEY, last_succeeded_ms INTEGER NOT NULL)"
          )
          .run()
      );
      let created = false;
      const done = (): Promise<void> => Promise.resolve();
      const canaryInstance: WorkflowInstance = {
        id: "canary",
        status: () => Promise.resolve({ status: "complete" }),
        pause: done,
        resume: done,
        restart: done,
        terminate: done,
        delete: done,
        sendEvent: done,
        subscribe: () =>
          Promise.resolve({
            next: () => Promise.resolve({ done: true as const, value: undefined }),
            [Symbol.dispose]: () => {},
          }),
      };
      const workflow: Workflow = {
        create: () => {
          created = true;
          return Promise.resolve(canaryInstance);
        },
        get: () => Promise.resolve(canaryInstance),
        createBatch: () => Promise.resolve([]),
        deleteBatch: () => Promise.resolve({ deleted: [], errors: [] }),
      };
      const now = yield* Clock.currentTimeMillis;
      const batch = {
        ...queueBatch({ version: 1, sentAtMs: Math.floor(now / 300_000) * 300_000 }),
        queue: "OperationalCanaryQueue",
      };
      yield* Effect.tryPromise(() =>
        makeCoreWorker(collectingTelemetry([])).queue(batch, {
          ...coreEnvironment,
          DB: db,
          OPERATIONAL_CANARY_QUEUE_NAME: "OperationalCanaryQueue",
          OPERATIONAL_CANARY_WORKFLOW: workflow,
        })
      );
      expect(created).toBe(true);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT kind FROM operational_canary").all())
      ).toMatchObject({
        results: [{ kind: "queueExecution" }],
      });
    })
  )
);

describe("Cloudflare Worker topology (scheduled)", () => {
  it.effect("reports a failed cron invocation after attempting independent activities", () =>
    Effect.gen(function* () {
      const records: Array<TelemetryWorkRecord> = [];
      const worker = makeCoreWorker(collectingTelemetry(records));

      yield* Effect.tryPromise(() =>
        expect(worker.scheduled(scheduledController, coreEnvironment)).rejects.toThrow()
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        operation: "worker.core.scheduled",
        outcome: "failed",
        release: gitRevision,
      });
      const exported = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(Schema.Unknown))
      )(records);
      expect(exported).not.toContain(privateFailureDetail);
    })
  );
});

it.live(
  "expires retired Tail-event buckets without deleting current Workflow-failure evidence",
  () =>
    withIsolatedD1("event-retention-test", (db) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "CREATE TABLE operational_event_buckets (kind TEXT NOT NULL, bucket_ms INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, bucket_ms))"
            )
            .run()
        );
        const minuteMs = 60_000;
        const current = Math.floor((yield* Clock.currentTimeMillis) / minuteMs) * minuteMs;
        const oldBuckets = Array.from({ length: 200 }, (_, index) =>
          db
            .prepare("INSERT INTO operational_event_buckets VALUES ('worker_exception', ?, 1)")
            .bind(current - 172_800_000 - index * minuteMs)
        );
        yield* Effect.tryPromise(() => db.batch(oldBuckets.slice(0, 100)));
        yield* Effect.tryPromise(() => db.batch(oldBuckets.slice(100)));
        yield* Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO operational_event_buckets VALUES ('workflow_failure', ?, 1)")
            .bind(current)
            .run()
        );
        const worker = makeCoreWorker(collectingTelemetry([]));
        const environment: Parameters<typeof coreWorker.scheduled>[1] = {
          ...coreEnvironment,
          DB: db,
          ASYNC_HEALTH_ENABLED: "enabled",
        };
        yield* Effect.tryPromise(() =>
          expect(worker.scheduled(scheduledController, environment)).rejects.toThrow()
        );
        const exceptionCount = (): Promise<unknown> =>
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM operational_event_buckets WHERE kind = 'worker_exception'"
            )
            .first();
        expect(yield* Effect.tryPromise(exceptionCount)).toEqual({ count: 72 });
        yield* Effect.tryPromise(() =>
          expect(worker.scheduled(scheduledController, environment)).rejects.toThrow()
        );
        expect(yield* Effect.tryPromise(exceptionCount)).toEqual({ count: 0 });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM operational_event_buckets WHERE kind = 'workflow_failure'"
              )
              .first()
          )
        ).toEqual({ count: 1 });
      })
    )
);

const rejectedOperatorFetch = (): Promise<Response> =>
  Promise.resolve(new Response('{"message":"rejected"}', { status: 400 }));

const inspectRejectedAlert = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      db
        .prepare(`CREATE TABLE operational_alerts (
          kind TEXT NOT NULL, owner TEXT NOT NULL, severity TEXT NOT NULL, state TEXT NOT NULL,
          first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL, last_attempt_ms INTEGER,
          attempt_started_ms INTEGER, delivery_confirmed INTEGER NOT NULL DEFAULT 0,
          next_attempt_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          acknowledged_ms INTEGER, PRIMARY KEY (kind, owner)
        )`)
        .run()
    );
    const worker = makeCoreWorker(collectingTelemetry([]));
    yield* Effect.tryPromise(() =>
      expect(
        worker.scheduled(scheduledController, {
          ...coreEnvironment,
          DB: db,
          ASYNC_HEALTH_ENABLED: "enabled",
          ASYNC_DEAD_LETTERS: {
            metrics: () => Promise.resolve({ backlogCount: 1, backlogBytes: 20 }),
          },
          OPERATOR_ALERT_EMAIL: "operator@example.com",
          RESEND_API_KEY: "fake-test-key",
        })
      ).rejects.toThrow()
    );
    const states = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT kind, state, delivery_confirmed, acknowledged_ms FROM operational_alerts WHERE kind = 'dead_letters'"
        )
        .all()
    );
    expect(states.results).toEqual([
      {
        kind: "dead_letters",
        state: "firing",
        delivery_confirmed: 0,
        acknowledged_ms: null,
      },
    ]);
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM operational_alerts WHERE delivery_confirmed = 1")
          .first()
      )
    ).toEqual({ count: 0 });
  });

it.effect(
  "keeps alerts unconfirmed after a rejected provider response at the scheduled Worker boundary",
  () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(globalThis, "fetch").mockImplementation(rejectedOperatorFetch)),
        () => withIsolatedD1("operator-alert-worker", inspectRejectedAlert),
        (fetch) => Effect.sync(() => fetch.mockRestore())
      )
    ),
  { timeout: 15_000 }
);

describe("Cloudflare Worker topology (continued)", () => {
  it.effect("retains one owning span when runtime release metadata is malformed", () =>
    Effect.gen(function* () {
      const records: Array<TelemetryWorkRecord> = [];
      const observedPublic = makePublicWorker(collectingTelemetry(records));
      const response = yield* Effect.tryPromise(() =>
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
      const response = yield* Effect.tryPromise(() =>
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
      const response = yield* Effect.tryPromise(() =>
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
      const response = yield* Effect.tryPromise(() =>
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
      const response = yield* Effect.tryPromise(() =>
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
      const response = yield* Effect.tryPromise(() =>
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
      const response = yield* Effect.tryPromise(() =>
        publicWorker.fetch(
          new Request("https://api.fidyapp.com/categories"),
          makePublicEnvironment({
            CORE: { fetch: (request) => coreWorker.fetch(new Request(request), coreEnvironment) },
          })
        )
      );
      const body = yield* Effect.tryPromise(() => response.json());

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
      const response = yield* Effect.tryPromise(() =>
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
      const text = yield* Effect.tryPromise(() => response.text());

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
      const response = yield* Effect.tryPromise(() =>
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
