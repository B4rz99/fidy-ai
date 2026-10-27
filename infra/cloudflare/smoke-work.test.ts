import { it } from "@effect/vitest";
import { Clock, DateTime, Deferred, Effect, Option, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  SyntheticBindings,
  smokeEnvironment,
  unavailableBucket,
  unavailableDatabase,
  unavailableQueue,
  unavailableWorkflow,
} from "./incomplete-platform-fixture";
import {
  handleSmoke,
  receiveSmoke,
} from "../../apps/server/cloudflare/runtime/release-smoke/operations";

const withMethods = SyntheticBindings.withMethods;
const revision = "0123456789abcdef0123456789abcdef01234567";
const digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const version = "dc8dcd28-271b-4367-9840-6c244f84cb40";
const proof = "a".repeat(64);
const body = JSON.stringify({
  protocolVersion: 1,
  probeId: "b".repeat(32),
  expectedPublicVersionId: version,
  expectedCoreVersionId: version,
  expectedGitRevision: revision,
  expectedContractDigest: digest,
});

describe("private release smoke", () => {
  it.live("bounds Workflow handoffs at four and leaves only failed work unacknowledged", () =>
    Effect.gen(function* () {
      const filled = yield* Deferred.make<void>();
      const release = Promise.withResolvers<void>();
      let active = 0;
      let maximum = 0;
      let started = 0;
      const acknowledged: string[] = [];
      const retried: string[] = [];
      const environment = smokeEnvironment({
        SMOKE_QUEUE_NAME: "reserved-smoke",
        SMOKE_WORKFLOW: withMethods(unavailableWorkflow, {
          create: (): Promise<object> => {
            const ordinal = ++started;
            maximum = Math.max(maximum, ++active);
            if (active === 4) Deferred.doneUnsafe(filled, Effect.void);
            return release.promise
              .then(() => {
                if (ordinal === 9) throw new Error("handoff unavailable");
                return {};
              })
              .finally(() => {
                active--;
              });
          },
          get: (): Promise<object> => Promise.reject(new Error("handoff unavailable")),
        }),
      });
      const now = yield* Clock.currentTimeMillis;
      const messages = Array.from({ length: 9 }, (_, index) => ({
        id: `smoke-${index}`,
        timestamp: DateTime.toDate(DateTime.makeUnsafe(0)),
        body: {
          protocolVersion: 2,
          probeId: (index + 1).toString(16).repeat(32),
          gitRevision: revision,
          contractDigest: digest,
          coreVersionId: version,
          expiresAtMs: now + 300000,
        },
        attempts: 1,
        ack: (): void => {
          acknowledged.push(`smoke-${index}`);
        },
        retry: (): void => {
          retried.push(`smoke-${index}`);
        },
      }));
      const completed = receiveSmoke({
        environment,
        batch: {
          queue: "reserved-smoke",
          messages,
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          ackAll: (): void => {
            acknowledged.push("all");
          },
          retryAll: (): void => {
            retried.push("all");
          },
        },
      }).then(
        () => ({ _tag: "UnexpectedSuccess" }),
        (failure: unknown) =>
          Schema.decodeUnknownSync(
            Schema.TaggedStruct("SmokeBindingFailed", { stage: Schema.Literal("platform") })
          )(failure)
      );
      yield* Deferred.await(filled);
      yield* Effect.yieldNow;
      const held = { active, started, maximum };
      release.resolve();
      expect(yield* Effect.tryPromise(() => completed)).toEqual({
        _tag: "SmokeBindingFailed",
        stage: "platform",
      });
      expect(held).toEqual({ active: 4, started: 4, maximum: 4 });
      expect({ active, started, maximum }).toEqual({ active: 0, started: 9, maximum: 4 });
      expect(acknowledged.sort()).toEqual(messages.slice(0, 8).map(({ id }) => id));
      expect(retried).toEqual([]);
    })
  );
  it.effect(
    "rejects missing authority, oversized input, and wrong Core version without touching any binding",
    () =>
      Effect.gen(function* () {
        let effects = 0;
        const binding = (): never => {
          effects++;
          throw new Error("must not run");
        };
        const environment = smokeEnvironment({
          DB: withMethods(unavailableDatabase, { prepare: binding }),
          SMOKE_BUCKET: withMethods(unavailableBucket, { put: binding }),
          SMOKE_QUEUE: withMethods(unavailableQueue, { send: binding }),
          SMOKE_WORKFLOW: withMethods(unavailableWorkflow, { create: binding }),
          USER_TRANSACTION_COORDINATOR: { getByName: binding },
          CF_VERSION_METADATA: { id: "db7cd8d3-4425-4fe7-8c81-01bf963b6067" },
          SMOKE_QUEUE_NAME: "smoke",
          SMOKE_PROOF: proof,
          RELEASE_GIT_SHA: revision,
          CONTRACT_DIGEST: digest,
          KAPSO_API_KEY: "configured",
          KAPSO_WEBHOOK_SECRET: "configured",
          RESEND_API_KEY: "configured",
          WOMPI_PRIVATE_KEY: "configured",
          WOMPI_INTEGRITY_SECRET: "configured",
          WOMPI_EVENT_SECRET: "configured",
        });
        const request = (payload: string, authorized: boolean): Request =>
          new Request("https://core.internal/internal/release-smoke", {
            method: "POST",
            body: payload,
            headers: {
              "content-type": "application/json",
              ...(authorized ? { "x-fidy-smoke-proof": proof } : {}),
            },
          });
        expect(
          (yield* Effect.tryPromise(() =>
            handleSmoke({
              bankAuthentication: Option.none(),
              request: request(body, false),
              environment,
            })
          )).status
        ).toBe(404);
        expect(
          (yield* Effect.tryPromise(() =>
            handleSmoke({
              bankAuthentication: Option.none(),
              request: request("a".repeat(513), true),
              environment,
            })
          )).status
        ).toBe(404);
        const refusedReadiness = yield* Effect.tryPromise(() =>
          handleSmoke({
            bankAuthentication: Option.none(),
            request: new Request("https://core.internal/internal/release-smoke?readiness=1"),
            environment,
          })
        );
        expect(refusedReadiness.status).toBe(404);
        expect(refusedReadiness.headers.get("x-fidy-smoke-failure")).toBeNull();
        expect(refusedReadiness.headers.get("x-fidy-smoke-identity")).toBeNull();
        expect(refusedReadiness.headers.get("x-fidy-smoke-core-version")).toBeNull();
        const ready = yield* Effect.tryPromise(() =>
          handleSmoke({
            bankAuthentication: Option.none(),
            request: new Request("https://core.internal/internal/release-smoke?readiness=1", {
              headers: { "x-fidy-smoke-proof": proof },
            }),
            environment,
          })
        );
        expect(ready.status).toBe(200);
        expect(yield* Effect.tryPromise(() => ready.json())).toMatchObject({
          status: "pending",
          core: { workerVersionId: environment.CF_VERSION_METADATA.id },
        });
        const deniedLimiter: RateLimit = {
          limit: ({ key }): Promise<{ success: boolean }> => {
            expect(key).toBe("release-smoke");
            return Promise.resolve({ success: false });
          },
        };
        const limitedEnvironment = {
          ...environment,
          CF_VERSION_METADATA: { id: version },
          SMOKE_LIMITER: deniedLimiter,
        };
        const requests = Array.from({ length: 32 }, () => request(body, true));
        const responses = requests.map((value) =>
          handleSmoke({
            bankAuthentication: Option.none(),
            request: value,
            environment: limitedEnvironment,
          })
        );
        const limited = yield* Effect.tryPromise(() => Promise.all(responses));
        expect(
          limited.every(
            (response) =>
              response.status === 503 &&
              response.headers.get("x-fidy-smoke-failure") === "admission"
          )
        ).toBe(true);
        expect(effects).toBe(0);
        const mismatch = yield* Effect.tryPromise(() =>
          handleSmoke({
            bankAuthentication: Option.none(),
            request: request(body, true),
            environment,
          })
        );
        expect(mismatch.status).toBe(503);
        expect(mismatch.headers.get("x-fidy-smoke-failure")).toBe("identity");
        expect(mismatch.headers.get("x-fidy-smoke-identity")).toBe("011");
        expect(mismatch.headers.get("x-fidy-smoke-core-version")).toBe(
          environment.CF_VERSION_METADATA.id
        );
        const diagnosticBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          protocolVersion: 1,
          probeId: "b".repeat(32),
          expectedPublicVersionId: version,
          expectedCoreVersionId: version,
          expectedGitRevision: "0".repeat(40),
          expectedContractDigest: digest,
        });
        const diagnostic = yield* Effect.tryPromise(() =>
          handleSmoke({
            bankAuthentication: Option.none(),
            request: request(diagnosticBody, true),
            environment: {
              ...environment,
              CF_VERSION_METADATA: { id: version },
              RELEASE_GIT_SHA: "0".repeat(40),
            },
          })
        );
        expect(diagnostic.status).toBe(503);
        expect(diagnostic.headers.get("x-fidy-smoke-core-version")).toBe(version);
        expect(diagnostic.headers.get("x-fidy-smoke-identity")).toBe("111");
        for (const overrides of [
          { RELEASE_GIT_SHA: "f".repeat(40), expected: "101" },
          { CONTRACT_DIGEST: "f".repeat(64), expected: "110" },
        ]) {
          const rejection = yield* Effect.tryPromise(() =>
            handleSmoke({
              bankAuthentication: Option.none(),
              request: request(body, true),
              environment: { ...environment, CF_VERSION_METADATA: { id: version }, ...overrides },
            })
          );
          expect(rejection.status).toBe(503);
          expect(rejection.headers.get("x-fidy-smoke-identity")).toBe(overrides.expected);
          expect(yield* Effect.tryPromise(() => rejection.text())).toBe('{"status":"unavailable"}');
        }
        const admissionFailure = yield* Effect.tryPromise(() =>
          handleSmoke({
            bankAuthentication: Option.none(),
            request: request(body, true),
            environment: {
              ...environment,
              CF_VERSION_METADATA: { id: version },
              DB: withMethods(unavailableDatabase, {
                prepare: () => {
                  throw Error("secret-provider-body");
                },
              }),
            },
          })
        );
        expect(admissionFailure.status).toBe(503);
        expect(admissionFailure.headers.get("x-fidy-smoke-failure")).toBe("schema");
        expect(yield* Effect.tryPromise(() => admissionFailure.text())).not.toContain(
          "secret-provider-body"
        );
        const executionFailure = yield* Effect.tryPromise(() =>
          handleSmoke({
            bankAuthentication: Option.none(),
            request: request(body, true),
            environment: {
              ...environment,
              CF_VERSION_METADATA: {
                get id(): string {
                  throw Error("secret-runtime-defect");
                },
              },
            },
          })
        );
        expect(executionFailure.status).toBe(503);
        expect(executionFailure.headers.get("x-fidy-smoke-failure")).toBe("platform");
        expect(yield* Effect.tryPromise(() => executionFailure.text())).not.toContain(
          "secret-runtime-defect"
        );
        expect(effects).toBe(0);
      })
  );
});

it.effect(
  "refuses sandbox authentication without deployment authority, matching identity, or request budget",
  () =>
    Effect.gen(function* () {
      let bankCalls = 0;
      const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        protocolVersion: 1,
        probeId: "b".repeat(32),
        expectedPublicVersionId: version,
        expectedCoreVersionId: version,
        expectedGitRevision: revision,
        expectedContractDigest: digest,
        verifyBancolombiaSandbox: true,
      });
      const environment = smokeEnvironment({
        BANCOLOMBIA_SANDBOX_MTLS: {
          fetch: (): Promise<Response> => {
            bankCalls += 1;
            return Promise.resolve(Response.json({}));
          },
        },
      });
      for (const scenario of [
        { authorized: false, environment, stage: null, status: 404 },
        {
          authorized: true,
          environment: { ...environment, RELEASE_GIT_SHA: "f".repeat(40) },
          stage: "identity",
          status: 503,
        },
        {
          authorized: true,
          environment: {
            ...environment,
            SMOKE_LIMITER: {
              limit: (): Promise<{ success: boolean }> => Promise.resolve({ success: false }),
            },
          },
          stage: "admission",
          status: 503,
        },
      ]) {
        const response = yield* Effect.tryPromise(() =>
          handleSmoke({
            bankAuthentication: Option.none(),
            request: new Request("https://core.internal/internal/release-smoke", {
              method: "POST",
              headers: scenario.authorized
                ? { "content-type": "application/json", "x-fidy-smoke-proof": proof }
                : { "content-type": "application/json" },
              body: payload,
            }),
            environment: scenario.environment,
          })
        );
        expect(response.status).toBe(scenario.status);
        expect(response.headers.get("x-fidy-smoke-failure")).toBe(scenario.stage);
      }
      expect(bankCalls).toBe(0);
    })
);
