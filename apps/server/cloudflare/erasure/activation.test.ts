import { it as effectIt } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, expect, vi } from "vitest";
import { fixtureNativeHttpClient } from "../core-worker.test-fixture";
import { installRetentionTestSchema } from "../d1-test-fixture";
import { nativeErasurePlatform, seedPersonalClasses } from "./native.test-fixture";
import { executeErasureAdmission } from "./operations";
import { handleErasureOperator } from "./runtime";
import { nativeRecoveryAdmission } from "../recovery-activation/native.test-fixture";

const issuer = "https://erasure-test.cloudflareaccess.com";
const audience = "erasure-only";
const activationId = "18500000-0000-4000-8000-000000000001";
const target = {
  namespaceId: "source-native",
  objectId: "source-object",
  manifest: "sealed-source",
  epoch: "source-epoch",
};
const userId = "18500000-0000-4000-8000-000000000099";
const servingTarget = { ...target, namespaceId: "serving-native", epoch: "serving-epoch" };
afterEach(() => vi.restoreAllMocks());

effectIt.layer(NodeFileSystem.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "keeps activation admission closed when response and provider work have no drain proof",
    () =>
      Effect.gen(function* () {
        const platform = yield* nativeErasurePlatform;
        const native = yield* Effect.tryPromise(() => platform.acquire());
        yield* Effect.tryPromise(() => installRetentionTestSchema(native.db));
        const current = yield* Clock.currentTimeMillis;
        const { publicKey, privateKey } = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
        const jwk = {
          ...(yield* Effect.tryPromise(() => exportJWK(publicKey))),
          kid: "activation",
          alg: "RS256",
        };
        vi.spyOn(globalThis, "fetch").mockImplementation(() =>
          Promise.resolve(Response.json({ keys: [jwk] }))
        );
        const token = yield* Effect.tryPromise(() =>
          new SignJWT({ email: "obarboza@fidyapp.com" })
            .setProtectedHeader({ alg: "RS256", kid: "activation" })
            .setIssuer(issuer)
            .setAudience(audience)
            .setSubject("operator")
            .setIssuedAt(Math.floor(current / 1000))
            .setExpirationTime(Math.floor(current / 1000) + 300)
            .sign(privateKey)
        );
        yield* seedPersonalClasses({ db: native.db, userId, current, index: 0 });
        const interruptedRegistry = new Proxy(native.registry, {
          get: (registry, property): unknown =>
            property === "put"
              ? (): Promise<never> =>
                  Promise.reject(new Error("Interrupted before independent marker publication"))
              : Reflect.get(registry, property, registry),
        });
        const accepted = yield* executeErasureAdmission({
          db: native.db,
          userId,
          candidate: {
            userId,
            sessionId: userId,
            digest: Array.from(new Uint8Array(32).fill(1)),
            deadlineMs: current + 5000,
          },
          signal: yield* Effect.abortSignal,
          stores: [],
          recovery: { db: native.db, bucket: Option.some(interruptedRegistry) },
        });
        expect(accepted.status).toBe(503);
        expect(
          (yield* Effect.tryPromise(() => native.registry.list({ prefix: "recovery/cases/" })))
            .objects
        ).toHaveLength(0);
        const admission = yield* nativeRecoveryAdmission;
        expect(
          yield* Effect.tryPromise(() =>
            admission.enter({ epoch: target.epoch, leaseId: "unsettled-provider" })
          )
        ).toBe(true);
        const control = {
          inspect: (): Promise<unknown> => Promise.reject(new Error("No Store control configured")),
          close: (): Promise<unknown> => Promise.reject(new Error("No Store control configured")),
        };
        const http = yield* fixtureNativeHttpClient;
        const operationSignal = yield* Effect.abortSignal;
        const send = (
          signal: AbortSignal = operationSignal
        ): Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError> =>
          Effect.gen(function* () {
            return yield* handleErasureOperator({
              request: new Request("https://operator/internal/titular-erasure", {
                method: "POST",
                signal,
                headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
                body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  action: "Activation",
                  activationId,
                }),
              }),
              environment: {
                DB: native.snapshot,
                ERASURE_BUCKET: native.registry,
                ERASURE_ACTIVATION: {
                  admission,
                  source: control,
                  serving: control,
                  sourceDb: native.db,
                  sourceTarget: target,
                  servingTarget,
                },
                CLOUDFLARE_ACCESS_ISSUER: issuer,
                CLOUDFLARE_ACCESS_AUDIENCE: "recovery-only",
                ERASURE_SUPPORT_AUDIENCE: audience,
                USER_TRANSACTION_COORDINATOR: native.coordinator,
              },
            }).pipe(Effect.provideService(HttpClient.HttpClient, http));
          });
        const response = yield* send();
        expect(response.status).toBe(202);
        const body: unknown = yield* Effect.tryPromise(() => response.json());
        expect(body).toMatchObject({ phase: "AwaitingDrain", providerIsolation: "Unqualified" });
        const stored = yield* Effect.tryPromise(() => native.registry.get("recovery/activation"));
        expect(stored).not.toBeNull();
        const record = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* Effect.tryPromise(() =>
            stored === null ? Promise.reject(new Error("Missing activation record")) : stored.text()
          )
        );
        expect(record).toMatchObject({ activationId, phase: "AwaitingDrain" });
        expect(
          yield* Effect.tryPromise(() =>
            admission.enter({ epoch: target.epoch, leaseId: "stale-background" })
          )
        ).toBe(false);
        expect(
          yield* Effect.tryPromise(() =>
            admission.complete({ epoch: target.epoch, leaseId: "unsettled-provider" })
          )
        ).toBe(false);
        expect(yield* Effect.tryPromise(() => admission.inspect())).toMatchObject({
          closed: true,
          leases: 0,
        });
        const aborted = yield* send(AbortSignal.abort());
        expect(aborted.status).toBe(401);
        yield* Effect.tryPromise(() =>
          native.db.prepare("ALTER TABLE erasure_requests RENAME TO unavailable_requests").run()
        );
        const unavailableSource = yield* send();
        expect(unavailableSource.status).toBe(503);
        expect(
          (yield* Effect.tryPromise(() => native.registry.list({ prefix: "recovery/cases/" })))
            .objects
        ).toHaveLength(0);
        expect(yield* Effect.tryPromise(() => admission.inspect())).toMatchObject({
          closed: true,
          leases: 0,
        });
        yield* Effect.tryPromise(() =>
          native.db.prepare("ALTER TABLE unavailable_requests RENAME TO erasure_requests").run()
        );
        const resumed = yield* send();
        expect(resumed.status).toBe(202);
        expect(yield* Effect.tryPromise(() => resumed.json())).toMatchObject({
          phase: "AwaitingProvider",
          providerIsolation: "Unqualified",
        });
        const cases = yield* Effect.tryPromise(() =>
          native.registry.list({ prefix: "recovery/cases/" })
        );
        expect(cases.objects).toHaveLength(1);
        const markerKey = cases.objects[0]?.key ?? "missing-marker";
        const marker = yield* Effect.tryPromise(() => native.registry.get(markerKey));
        const intent = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* Effect.tryPromise(() =>
            marker === null ? Promise.reject(new Error("Missing preserved erasure")) : marker.text()
          )
        );
        expect(intent).toMatchObject({ userId, sealed: false });
        const repeated = yield* send();
        expect(repeated.status).toBe(202);
        expect(
          (yield* Effect.tryPromise(() => native.registry.list({ prefix: "recovery/cases/" })))
            .objects
        ).toHaveLength(1);
      }).pipe(Effect.scoped)
  );
});
