import { it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Schema } from "effect";
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
  it.effect("bounds Workflow handoffs at four and leaves only failed work unacknowledged", () =>
    Effect.gen(function* () {
      const filled = yield* Deferred.make<void>();
      const release = Promise.withResolvers<void>();
      let active = 0;
      let maximum = 0;
      let started = 0;
      const acknowledged: string[] = [];
      const retried: string[] = [];
      const database = {
        prepare: (): { bind: () => { first: () => Promise<unknown> } } => ({
          bind: (): { first: () => Promise<unknown> } => ({
            first: (): Promise<unknown> =>
              Promise.resolve({ expires_at_ms: Number.MAX_SAFE_INTEGER }),
          }),
        }),
      };
      const environment = smokeEnvironment({
        DB: withMethods(unavailableDatabase, { prepare: database.prepare }),
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
      const messages = Array.from({ length: 9 }, (_, index) => ({
        id: `smoke-${index}`,
        timestamp: DateTime.toDate(DateTime.makeUnsafe(0)),
        body: {
          protocolVersion: 1,
          probeId: (index + 1).toString(16).repeat(32),
          gitRevision: revision,
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
            handleSmoke({ request: request(body, false), environment })
          )).status
        ).toBe(404);
        expect(
          (yield* Effect.tryPromise(() =>
            handleSmoke({ request: request("a".repeat(513), true), environment })
          )).status
        ).toBe(404);
        const refusedReadiness = yield* Effect.tryPromise(() =>
          handleSmoke({
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
        const mismatch = yield* Effect.tryPromise(() =>
          handleSmoke({ request: request(body, true), environment })
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
        expect(admissionFailure.headers.get("x-fidy-smoke-failure")).toBe("admission");
        expect(yield* Effect.tryPromise(() => admissionFailure.text())).not.toContain(
          "secret-provider-body"
        );
        const executionFailure = yield* Effect.tryPromise(() =>
          handleSmoke({
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

  it.effect(
    "uses only reserved bindings and allows a stable consumer to hand off candidate synthetic work",
    () =>
      Effect.gen(function* () {
        const actions: Array<string> = [];
        let offered: unknown;
        let claimed = false;
        const database = {
          prepare: (
            sql: string
          ): {
            all: () => Promise<unknown>;
            bind: (...values: ReadonlyArray<unknown>) => {
              run: () => Promise<unknown>;
              first: () => Promise<unknown>;
            };
          } => ({
            all: (): Promise<unknown> => {
              actions.push("schema");
              return Promise.resolve({});
            },
            bind: (
              ...values: ReadonlyArray<unknown>
            ): { run: () => Promise<unknown>; first: () => Promise<unknown> } => ({
              run: (): Promise<unknown> => {
                actions.push(sql.startsWith("UPDATE") ? "synthetic-claim" : "synthetic-insert");
                if (sql.startsWith("UPDATE")) claimed = true;
                return Promise.resolve({ meta: { changes: 1 } });
              },
              first: (): Promise<unknown> => {
                actions.push("synthetic-read");
                return Promise.resolve(
                  sql.includes("expires_at_ms FROM")
                    ? { expires_at_ms: Number.MAX_SAFE_INTEGER }
                    : {
                        git_revision: revision,
                        expires_at_ms: Number.MAX_SAFE_INTEGER,
                        status: claimed ? "queued" : "pending",
                        id: values[0],
                      }
                );
              },
            }),
          }),
        };
        const environment = smokeEnvironment({
          DB: withMethods(unavailableDatabase, { prepare: database.prepare }),
          SMOKE_BUCKET: withMethods(unavailableBucket, {
            put: (): Promise<void> => {
              actions.push("marker-write");
              return Promise.resolve();
            },
            get: (): Promise<object> => {
              actions.push("marker-read");
              return Promise.resolve({});
            },
          }),
          SMOKE_QUEUE: withMethods(unavailableQueue, {
            send: (value: unknown): Promise<void> => {
              offered = value;
              actions.push("queue");
              return Promise.resolve();
            },
          }),
          SMOKE_WORKFLOW: withMethods(unavailableWorkflow, {
            create: (): Promise<object> => {
              actions.push("workflow");
              return Promise.resolve({});
            },
          }),
          USER_TRANSACTION_COORDINATOR: {
            getByName: (name: string): { fetch: () => Promise<Response> } => ({
              fetch: (): Promise<Response> => {
                actions.push(name);
                return Promise.resolve(Response.json({ status: "compatible" }));
              },
            }),
          },
          CF_VERSION_METADATA: { id: version },
        });
        const result = yield* Effect.tryPromise(() =>
          handleSmoke({
            request: new Request("https://core.internal/internal/release-smoke", {
              method: "POST",
              headers: { "content-type": "application/json", "x-fidy-smoke-proof": proof },
              body,
            }),
            environment,
          })
        );
        expect(result.status).toBe(202);
        expect(actions).toEqual([
          "synthetic-insert",
          "synthetic-read",
          "synthetic-claim",
          "schema",
          "schema",
          "marker-write",
          "marker-read",
          "_release-smoke-v1",
          "queue",
        ]);
        expect(offered).toEqual({
          protocolVersion: 1,
          probeId: "b".repeat(32),
          gitRevision: revision,
        });
        const replay = yield* Effect.tryPromise(() =>
          handleSmoke({
            request: new Request("https://core.internal/internal/release-smoke", {
              method: "POST",
              headers: { "content-type": "application/json", "x-fidy-smoke-proof": proof },
              body,
            }),
            environment,
          })
        );
        expect(replay.status).toBe(202);
        expect(actions.filter((action) => action === "queue")).toHaveLength(1);
        expect(actions.filter((action) => action === "marker-write")).toHaveLength(1);
        const candidateWork = offered;
        const stableConsumer = { ...environment, RELEASE_GIT_SHA: "0".repeat(40) };
        yield* Effect.tryPromise(() =>
          receiveSmoke({
            batch: {
              queue: "reserved-smoke",
              messages: [
                {
                  id: "synthetic-fixture",
                  timestamp: DateTime.toDate(DateTime.makeUnsafe(0)),
                  body: candidateWork,
                  attempts: 1,
                  retry: (): void => {},
                  ack: (): void => {
                    actions.push("ack");
                  },
                },
              ],
              metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
              retryAll: () => {},
              ackAll: () => {},
            },
            environment: stableConsumer,
          })
        );
        expect(actions.slice(-3)).toEqual(["synthetic-read", "workflow", "ack"]);
      })
  );
});
