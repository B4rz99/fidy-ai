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
import { handleErasureCandidateOperator, handleErasureOperator } from "./runtime";
import { nativeRecoveryAdmissions } from "../recovery-activation/native.test-fixture";

const issuer = "https://erasure-test.cloudflareaccess.com";
const audience = "erasure-only";
const activationId = "18500000-0000-4000-8000-000000000001";
const target = {
  kind: "D1" as const,
  databaseId: "18500000-0000-4000-8000-000000000002",
  epoch: "source-epoch",
};
const control = {
  inspect: (): Promise<unknown> => Promise.reject(new Error("No Store control configured")),
  close: (): Promise<unknown> => Promise.reject(new Error("No Store control configured")),
};

const userId = "18500000-0000-4000-8000-000000000099";
const servingTarget = {
  namespaceId: "serving-native",
  objectId: "serving-object",
  manifest: "sealed-serving",
  epoch: "serving-epoch",
};
afterEach(() => vi.restoreAllMocks());

const operatorToken = (current: number): Effect.Effect<string, Cause.UnknownError> =>
  Effect.gen(function* () {
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
    return token;
  });

const readActivationRecord = (
  registry: R2Bucket
): Effect.Effect<unknown, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise(() => registry.get("recovery/activation"));
    expect(stored).not.toBeNull();
    const record = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      yield* Effect.tryPromise(() =>
        stored === null ? Promise.reject(new Error("Missing activation record")) : stored.text()
      )
    );
    return record;
  });

effectIt.layer(NodeFileSystem.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "preserves DB-first erasure intent across source loss while awaiting a complete owner drain",
    () =>
      Effect.gen(function* () {
        const platform = yield* nativeErasurePlatform;
        const native = yield* Effect.tryPromise(() => platform.acquire());
        yield* Effect.tryPromise(() => installRetentionTestSchema(native.db));
        const current = yield* Clock.currentTimeMillis;
        const token = yield* operatorToken(current);
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
        const { source: admission, replacement } = yield* nativeRecoveryAdmissions;
        let selectedAdmission = admission;
        expect(
          yield* Effect.tryPromise(() =>
            admission.enter({ epoch: target.epoch, leaseId: "unsettled-provider" })
          )
        ).toBe(true);
        let sourceTarget = target;
        const http = yield* fixtureNativeHttpClient;
        const operationSignal = yield* Effect.abortSignal;
        let operatorDb = native.snapshot;
        const send = (
          signal: AbortSignal = operationSignal,
          action: "Activation" | "Restore" | "ReleaseRestore" | "Initialize" = "Activation",
          candidate: boolean = false
        ): Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError> =>
          Effect.gen(function* () {
            const handle = candidate ? handleErasureCandidateOperator : handleErasureOperator;
            return yield* handle({
              request: new Request("https://operator/internal/titular-erasure", {
                method: "POST",
                signal,
                headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
                body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  action,
                  ...(action === "Activation" ? { activationId } : {}),
                }),
              }),
              environment: {
                DB: operatorDb,
                RECOVERY_ADMISSION: { getByName: () => selectedAdmission },
                RECOVERY_SOURCE_EPOCH: target.epoch,
                ERASURE_CANDIDATE_DATABASE_ID: "candidate-native",
                ERASURE_SERVING_DATABASE_ID: "serving-native",
                ERASURE_BUCKET: native.registry,
                ERASURE_ACTIVATION: {
                  admission: selectedAdmission,
                  serving: control,
                  sourceDb: native.db,
                  sourceTarget,
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
        expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
          phase: "AwaitingDrain",
          providerIsolation: "Unqualified",
        });
        const record = yield* readActivationRecord(native.registry);
        expect(record).toMatchObject({ activationId, phase: "AwaitingDrain", source: target });
        operatorDb = native.db;
        expect((yield* send(operationSignal, "Restore")).status).toBe(503);
        expect((yield* send(operationSignal, "ReleaseRestore")).status).toBe(503);
        operatorDb = native.snapshot;
        yield* Effect.tryPromise(() => installRetentionTestSchema(native.snapshot));
        expect((yield* send(operationSignal, "Restore", true)).status).toBe(202);
        sourceTarget = { ...target, databaseId: "18500000-0000-4000-8000-000000000003" };
        expect((yield* send()).status).toBe(503);
        sourceTarget = target;
        selectedAdmission = replacement;
        expect((yield* send()).status).toBe(503);
        selectedAdmission = admission;
        expect(
          yield* Effect.tryPromise(() =>
            admission.enter({ epoch: target.epoch, leaseId: "stale-background" })
          )
        ).toBe(false);
        expect(
          yield* Effect.tryPromise(() =>
            admission.complete({ epoch: target.epoch, leaseId: "unsettled-provider" })
          )
        ).toBe(true);
        expect(yield* Effect.tryPromise(() => admission.inspect())).toMatchObject({
          closed: false,
          paused: true,
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
          closed: false,
          paused: true,
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
        expect(yield* Effect.tryPromise(() => admission.inspect())).toMatchObject({
          closed: false,
          paused: true,
          leases: 0,
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
        yield* Effect.tryPromise(() =>
          native.db
            .prepare(`INSERT INTO pending_consent_exchanges(
          id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,
          correlation_token,disclosure_json,created_at_ms,expires_at_ms,state
        ) VALUES('pre-user','portfolio','scoped','phone','message',?,
          '18500000-0000-4000-8000-000000000004','{}',0,86400000,'awaiting_delivery')`)
            .bind("0".repeat(64))
            .run()
        );
        const retainedPreUser = yield* send();
        expect(retainedPreUser.status).toBe(202);
        expect(yield* Effect.tryPromise(() => retainedPreUser.json())).toMatchObject({
          phase: "AwaitingOwnerDrain",
          providerIsolation: "Unqualified",
        });

        yield* Effect.tryPromise(() =>
          native.db
            .prepare(
              "ALTER TABLE pending_consent_exchanges RENAME TO unavailable_consent_exchanges"
            )
            .run()
        );
        expect((yield* send()).status).toBe(503);
        expect(yield* Effect.tryPromise(() => admission.inspect())).toMatchObject({
          closed: false,
          paused: true,
          leases: 0,
        });
        yield* Effect.tryPromise(() =>
          native.db
            .prepare(
              "ALTER TABLE unavailable_consent_exchanges RENAME TO pending_consent_exchanges"
            )
            .run()
        );
        expect((yield* send(operationSignal, "Initialize")).status).toBe(204);
        const repeated = yield* send();
        expect(repeated.status).toBe(202);
        expect(
          (yield* Effect.tryPromise(() => native.registry.list({ prefix: "recovery/cases/" })))
            .objects
        ).toHaveLength(1);
        yield* Effect.tryPromise(() => admission.close({ activationId, epoch: target.epoch }));
        expect((yield* send(operationSignal, "Initialize")).status).toBe(503);
      }).pipe(Effect.scoped)
  );
});
