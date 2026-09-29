import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { verifySmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";
import { handleSmoke } from "../../apps/server/cloudflare/runtime/smoke-work";
import publicWorker from "../../apps/server/cloudflare/public-worker";
import {
  SyntheticBindings,
  smokeEnvironment,
  unavailableBucket,
  unavailableDatabase,
  unavailableQueue,
  unavailableWorkflow,
} from "./incomplete-platform-fixture";

const withMethods = SyntheticBindings.withMethods;
const revision = "0123456789abcdef0123456789abcdef01234567";
const digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const version = "dc8dcd28-271b-4367-9840-6c244f84cb40";
const candidate = { gitRevision: revision, contractDigest: digest, workerVersionId: version };

describe("production smoke identity", () => {
  it("refuses a healthy stable Worker when the requested candidate override was ignored", () => {
    expect(
      verifySmokeIdentity({
        expected: candidate,
        observed: {
          ...candidate,
          workerVersionId: "db7cd8d3-4425-4fe7-8c81-01bf963b6067",
        },
      })
    ).toBe(false);
  });

  it("requires the exact candidate version and compatible release metadata", () => {
    expect(verifySmokeIdentity({ expected: candidate, observed: candidate })).toBe(true);
    expect(
      verifySmokeIdentity({
        expected: candidate,
        observed: { ...candidate, contractDigest: "0".repeat(64) },
      })
    ).toBe(false);
    expect(
      verifySmokeIdentity({
        expected: candidate,
        observed: { ...candidate, gitRevision: "0".repeat(40) },
      })
    ).toBe(false);
  });
});

describe("production smoke ingress", () => {
  it.effect(
    "rejects unauthorized smoke requests before the private Core binding or any work runs",
    () =>
      Effect.gen(function* () {
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
        const requests = [new Headers(), new Headers({ "x-fidy-smoke-proof": "invalid" })].map(
          (headers) =>
            publicWorker.fetch(
              new Request("https://api.fidyapp.com/internal/release-smoke", {
                method: "POST",
                headers,
              }),
              environment
            )
        );
        const refusals = yield* Effect.tryPromise(() => Promise.all(requests));
        for (const response of refusals) {
          expect(response.status).toBe(404);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("x-fidy-smoke-failure")).toBeNull();
        }
        expect(coreCalls).toBe(0);
        const authorized = yield* Effect.tryPromise(() =>
          publicWorker.fetch(
            new Request("https://api.fidyapp.com/internal/release-smoke", {
              method: "POST",
              headers: {
                "x-fidy-smoke-proof": "a".repeat(64),
                "cloudflare-workers-version-overrides":
                  'fidy-core="dc8dcd28-271b-4367-9840-6c244f84cb40"',
              },
            }),
            environment
          )
        );
        expect(authorized.status).toBe(200);
        expect(coreCalls).toBe(1);
        expect(yield* Effect.tryPromise(() => authorized.json())).toMatchObject({
          public: candidate,
          core: candidate,
        });
        const failed = yield* Effect.tryPromise(() =>
          publicWorker.fetch(
            new Request("https://api.fidyapp.com/internal/release-smoke", {
              method: "POST",
              headers: { "x-fidy-smoke-proof": "a".repeat(64) },
            }),
            { ...environment, CORE: { fetch: () => Promise.reject(Error("secret-provider-body")) } }
          )
        );
        expect(failed.status).toBe(503);
        expect(failed.headers.get("x-fidy-smoke-failure")).toBe("public_forwarding");
        expect(yield* Effect.tryPromise(() => failed.text())).not.toContain("secret-provider-body");
        for (const stage of ["schema", "secret-provider-body", ""]) {
          const sanitized = yield* Effect.tryPromise(() =>
            publicWorker.fetch(
              new Request("https://api.fidyapp.com/internal/release-smoke", {
                method: "POST",
                headers: { "x-fidy-smoke-proof": "a".repeat(64) },
              }),
              {
                ...environment,
                CORE: {
                  fetch: () =>
                    Promise.resolve(
                      new Response("secret-provider-body", {
                        status: 503,
                        headers: { "x-fidy-smoke-failure": stage },
                      })
                    ),
                },
              }
            )
          );
          expect(sanitized.status).toBe(503);
          expect(sanitized.headers.get("x-fidy-smoke-failure")).toBe(
            stage === "schema" ? "schema" : "core_response"
          );
          expect(yield* Effect.tryPromise(() => sanitized.text())).not.toContain(
            "secret-provider-body"
          );
        }
      })
  );

  it.effect("reports the public digest independently rather than copying the Core digest", () =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise(() =>
        publicWorker.fetch(
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
        )
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
        core: { contractDigest: digest },
        public: { contractDigest: "0".repeat(64) },
      });
    })
  );

  it.effect(
    "rejects excess authorized probes at the public-to-Core boundary before synthetic work",
    () =>
      Effect.gen(function* () {
        const actions: string[] = [];
        const blocked = (): never => {
          actions.push("binding");
          throw new Error("synthetic work should not run");
        };
        const coreEnvironment = smokeEnvironment({
          DB: withMethods(unavailableDatabase, {
            prepare: (sql: string): object => {
              actions.push(sql.startsWith("INSERT") ? "admission" : "read");
              return {
                bind: (): object => ({
                  run: (): Promise<void> => Promise.resolve(),
                  first: (): Promise<unknown> => Promise.resolve(null),
                }),
              };
            },
          }),
          SMOKE_BUCKET: withMethods(unavailableBucket, { put: blocked }),
          SMOKE_QUEUE: withMethods(unavailableQueue, { send: blocked }),
          SMOKE_WORKFLOW: withMethods(unavailableWorkflow, { create: blocked }),
          USER_TRANSACTION_COORDINATOR: { getByName: blocked },
          CF_VERSION_METADATA: { id: version },
          SMOKE_PROOF: "a".repeat(64),
          RELEASE_GIT_SHA: revision,
          CONTRACT_DIGEST: digest,
        });
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          protocolVersion: 1,
          probeId: "b".repeat(32),
          expectedPublicVersionId: version,
          expectedCoreVersionId: version,
          expectedGitRevision: revision,
          expectedContractDigest: digest,
        });
        const response = yield* Effect.tryPromise(() =>
          publicWorker.fetch(
            new Request("https://api.fidyapp.com/internal/release-smoke", {
              method: "POST",
              headers: { "x-fidy-smoke-proof": "a".repeat(64), "content-type": "application/json" },
              body,
            }),
            {
              BROWSER_ORIGIN: "https://app.fidyapp.com",
              CORE: {
                fetch: (request: Request): Promise<Response> =>
                  handleSmoke({ request, environment: coreEnvironment }),
              },
              LOCAL_CANONICAL_READ_BEARER: "",
              PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
              RELEASE_GIT_SHA: revision,
              CONTRACT_DIGEST: digest,
              SMOKE_PROOF: "a".repeat(64),
              CF_VERSION_METADATA: { id: version },
            }
          )
        );
        expect(response.status).toBe(503);
        expect(actions).toEqual(["admission", "read"]);
        expect(response.headers.get("x-fidy-smoke-failure")).toBe("probe_state");
      })
  );
});
