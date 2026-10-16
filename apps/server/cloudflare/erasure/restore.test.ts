import { type ErasureDecision, ErasureOperatorReceipt } from "../../src/core/erasure/contract";
import { it as effectIt } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { type Cause, Clock, Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, expect, vi } from "vitest";
import { fixtureNativeHttpClient } from "../core-worker.test-fixture";
import { installRetentionTestSchema } from "../d1-test-fixture";
import { deletionDecision } from "./erasure.test-fixture";
import { nativeErasurePlatform, seedPersonalClasses } from "./native.test-fixture";
import { handleErasureOperator, withErasureRecovery } from "./runtime";

const userId = "12740000-0000-4000-8000-000000000001";
const foreignUser = "12740000-0000-4000-8000-000000000099";
const reference = "12740000-0000-4000-8000-000000000002";
const issuer = "https://erasure-test.cloudflareaccess.com";
const audience = "erasure-only";
const json = Schema.fromJsonString(Schema.Unknown);
afterEach(() => vi.restoreAllMocks());
const advanceToExternal = (
  input: Readonly<{
    db: () => D1Database;
    send: (command: unknown) => Effect.Effect<Response, Schema.SchemaError>;
  }>
): Effect.Effect<void, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    for (let count = 0; count < 450; count++) {
      expect(
        (yield* input.send({ action: "Continue", userId, reference })).status,
        `continuation ${count}`
      ).toBe(202);
      if (
        (yield* Effect.tryPromise(() =>
          input
            .db()
            .prepare("SELECT state FROM erasure_requests WHERE id=?")
            .bind(reference)
            .first("state")
        )) === "ExternalPending"
      ) {
        return;
      }
    }
    expect.fail("Erasure did not reach ExternalPending");
  });

const verifyProcessorEvidence = (
  send: (command: unknown) => Effect.Effect<Response, Schema.SchemaError>,
  decision: ErasureDecision
): Effect.Effect<void, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* verifyControlReview({ send, decision });
    expect(
      (yield* send({
        action: "CustodyEvidence",
        userId,
        evidence: {
          reference,
          custodian: "Cloudflare",
          evidenceRef: "12740000-0000-4000-8000-000000000070",
          outcome: { status: "Verified" },
        },
      })).status
    ).toBe(409);
    expect(
      (yield* send({
        action: "CustodyEvidence",
        userId,
        evidence: {
          reference,
          custodian: "CaseEvidence",
          evidenceRef: "12740000-0000-4000-8000-000000000071",
          outcome: { status: "NotApplicable" },
        },
      })).status
    ).toBe(409);
    expect(
      (yield* send({
        action: "CustodyEvidence",
        userId,
        evidence: {
          reference,
          custodian: "Kapso",
          evidenceRef: "12740000-0000-4000-8000-000000000072",
          outcome: { status: "Accepted" },
        },
      })).status
    ).toBe(202);
    expect(
      (yield* send({
        action: "CustodyEvidence",
        userId,
        evidence: {
          reference,
          custodian: "Kapso",
          evidenceRef: "12740000-0000-4000-8000-000000000073",
          outcome: { status: "Unresolved", reason: "retention-conflict" },
        },
      })).status
    ).toBe(202);
    const pendingReceipt = yield* send({ action: "Receipt", userId, reference });
    const pendingBody: unknown = yield* Effect.tryPromise(() => pendingReceipt.json());
    const observed = yield* Schema.decodeUnknownEffect(ErasureOperatorReceipt)(pendingBody);
    expect(observed.state).toBe("ExternalPending");
    expect(observed.custodians).toContainEqual({
      custodian: "Kapso",
      status: "Unresolved",
      reason: "retention-conflict",
    });
  });

const verifyControlReview = (
  input: Readonly<{
    send: (command: unknown) => Effect.Effect<Response, Schema.SchemaError>;
    decision: ErasureDecision;
  }>
): Effect.Effect<void, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const reviewRef = "12740000-0000-4000-8000-000000000060";
    const renewal = { reviewRef, reviewAtMs: current + 86400000, untilMs: current + 45 * 86400000 };
    expect(
      (yield* input.send({
        action: "ReviewRetention",
        userId,
        reference,
        previousReviewRef: input.decision.receiptRetention.reviewRef,
        receiptRetention: { ...input.decision.receiptRetention, ...renewal },
        recoveryRetention: { ...input.decision.recovery.retention, ...renewal },
      })).status
    ).toBe(202);
    const response = yield* input.send({ action: "Receipt", userId, reference });
    expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
      controlRetention: { receipt: { reviewRef }, recovery: { reviewRef } },
      state: "ExternalPending",
    });
  });

const verifyRestore = Effect.gen(function* () {
  const platform = yield* nativeErasurePlatform;
  let native = yield* Effect.tryPromise(() => platform.acquire());
  const current = yield* Clock.currentTimeMillis;
  for (const db of [native.db, native.snapshot]) {
    yield* Effect.tryPromise(() => installRetentionTestSchema(db));
    yield* Effect.tryPromise(() =>
      db.batch([
        ...[userId, foreignUser].map((id) =>
          db
            .prepare("INSERT INTO users VALUES(?,'CO','es-CO','America/Bogota',?)")
            .bind(id, current)
        ),
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,?,'AwaitingReview')"
          )
          .bind(reference, userId, current),
      ])
    );
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO memories VALUES('target-memory',?,'Retener','2026-10-15','2026-10-15')"
          )
          .bind(userId),
        db
          .prepare(
            "INSERT INTO memories VALUES('foreign-memory',?,'Conservar','2026-10-15','2026-10-15')"
          )
          .bind(foreignUser),
      ])
    );
    yield* seedPersonalClasses({ db, userId, current, index: 0 });
    yield* seedPersonalClasses({ db, userId: foreignUser, current, index: 1 });
  }
  yield* Effect.tryPromise(() =>
    native.snapshot.batch([
      native.snapshot
        .prepare("INSERT INTO hosted_agent_sessions VALUES(?,?,'{}',?,?,'active')")
        .bind("12740000-0000-4000-8000-000000000050", userId, current, current),
      native.snapshot
        .prepare(
          "INSERT INTO hosted_turns(id,user_id,hosted_session_id,started_at_ms,status) VALUES(?,?,?,?,'pending')"
        )
        .bind(
          "12740000-0000-4000-8000-000000000051",
          userId,
          "12740000-0000-4000-8000-000000000050",
          current
        ),
    ])
  );
  const { publicKey, privateKey } = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
  const jwk = {
    ...(yield* Effect.tryPromise(() => exportJWK(publicKey))),
    kid: "erasure-key",
    alg: "RS256",
    use: "sig",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation((request): Promise<Response> => {
    expect(request instanceof Request ? request.url : request.toString()).toBe(
      `${issuer}/cdn-cgi/access/certs`
    );
    return Promise.resolve(Response.json({ keys: [jwk] }));
  });
  const http = yield* fixtureNativeHttpClient;
  const token = yield* Effect.tryPromise(() =>
    new SignJWT({ email: "obarboza@fidyapp.com" })
      .setProtectedHeader({ alg: "RS256", kid: "erasure-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("operator")
      .setIssuedAt(Math.floor(current / 1000))
      .setExpirationTime(Math.floor(current / 1000) + 300)
      .sign(privateKey)
  );
  const send = (
    command: unknown,
    assertion: string = token
  ): Effect.Effect<Response, Schema.SchemaError> =>
    Effect.gen(function* () {
      const body = yield* Schema.encodeEffect(json)(command);
      return yield* handleErasureOperator({
        request: new Request("https://api.fidyapp.com/internal/titular-erasure", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-access-jwt-assertion": assertion },
          body,
        }),
        environment: {
          DB: native.db,
          ERASURE_BUCKET: native.registry,
          ERASURE_REQUIRED: "true",
          CLOUDFLARE_ACCESS_ISSUER: issuer,
          CLOUDFLARE_ACCESS_AUDIENCE: "recovery-only",
          ERASURE_SUPPORT_AUDIENCE: audience,
          USER_TRANSACTION_COORDINATOR: native.coordinator,
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    });
  for (const invalid of [
    {
      email: "someone@fidyapp.com",
      aud: audience,
      iat: Math.floor(current / 1000),
      exp: Math.floor(current / 1000) + 300,
    },
    {
      email: "obarboza@fidyapp.com",
      aud: "recovery-only",
      iat: Math.floor(current / 1000),
      exp: Math.floor(current / 1000) + 300,
    },
    {
      email: "obarboza@fidyapp.com",
      aud: "billing-only",
      iat: Math.floor(current / 1000),
      exp: Math.floor(current / 1000) + 300,
    },
    {
      email: "obarboza@fidyapp.com",
      common_name: "machine",
      aud: audience,
      iat: Math.floor(current / 1000),
      exp: Math.floor(current / 1000) + 300,
    },
    {
      email: "obarboza@fidyapp.com",
      aud: audience,
      iat: Math.floor(current / 1000) - 100,
      exp: Math.floor(current / 1000) - 1,
    },
    {
      email: "obarboza@fidyapp.com",
      aud: audience,
      iat: Math.floor(current / 1000),
      exp: Math.floor(current / 1000) + 901,
    },
  ]) {
    const assertion = yield* Effect.tryPromise(() =>
      new SignJWT(invalid)
        .setProtectedHeader({ alg: "RS256", kid: "erasure-key" })
        .setIssuer(issuer)
        .setSubject("operator")
        .sign(privateKey)
    );
    expect((yield* send({ action: "Restore" }, assertion)).status).toBe(401);
  }
  const forged = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
  const forgedAssertion = yield* Effect.tryPromise(() =>
    new SignJWT({ email: "obarboza@fidyapp.com" })
      .setProtectedHeader({ alg: "RS256", kid: "erasure-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("operator")
      .setIssuedAt(Math.floor(current / 1000))
      .setExpirationTime(Math.floor(current / 1000) + 300)
      .sign(forged.privateKey)
  );
  expect((yield* send({ action: "Restore" }, forgedAssertion)).status).toBe(401);
  expect((yield* send({ action: "Restore", userId })).status).toBe(400);
  expect(
    (yield* send({
      action: "Review",
      decision: deletionDecision({ userId: foreignUser, reference, current }),
    })).status
  ).toBe(409);
  yield* Effect.tryPromise(() => native.registry.delete("recovery/generation"));
  expect((yield* send({ action: "Initialize" })).status).toBe(204);
  const decisionCurrent = yield* Clock.currentTimeMillis;
  const heldUntil = decisionCurrent + 30000;
  const baseDecision = deletionDecision({ userId, reference, current: decisionCurrent });
  const decision = {
    ...baseDecision,
    dispositions: {
      ...baseDecision.dispositions,
      memory: {
        action: "Retain",
        retention: {
          ...baseDecision.receiptRetention,
          purpose: "legal-hold",
          untilMs: heldUntil,
          reviewAtMs: heldUntil,
        },
      },
    },
  };

  expect((yield* send({ action: "Review", decision })).status).toBe(202);
  expect((yield* send({ action: "Initialize" })).status).toBe(503);
  yield* Effect.tryPromise(() =>
    native.db.prepare("DELETE FROM memories WHERE user_id=?").bind(userId).run()
  );
  expect(
    yield* Effect.tryPromise(() =>
      native.db
        .prepare("SELECT count(*) FROM erasure_archives WHERE request_id=? AND store_id='memories'")
        .bind(reference)
        .first("count(*)")
    )
  ).toBe(1);

  native = yield* Effect.tryPromise(() => platform.restoreSnapshot());
  expect((yield* send({ action: "Restore" })).status).toBe(202);
  expect((yield* send({ action: "Continue", userId, reference })).status).toBe(202);
  expect(
    yield* Effect.tryPromise(() =>
      native.db
        .prepare("SELECT state FROM erasure_requests WHERE id=?")
        .bind(reference)
        .first("state")
    )
  ).toBe("Draining");
  expect((yield* send({ action: "ReleaseRestore" })).status).toBe(202);
  expect(
    yield* Effect.tryPromise(() =>
      native.db.prepare("SELECT count(*) FROM users WHERE id=?").bind(userId).first("count(*)")
    )
  ).toBe(1);
  native = yield* Effect.tryPromise(() => platform.restoreLive());
  yield* advanceToExternal({ db: () => native.db, send });
  expect((yield* send({ action: "Receipt", userId, reference })).status).toBe(200);
  expect(
    (yield* Effect.tryPromise(() => native.registry.list({ prefix: `held-records/${reference}/` })))
      .objects.length
  ).toBe(1);
  yield* verifyProcessorEvidence(send, baseDecision);
  native = yield* Effect.tryPromise(() => platform.restoreSnapshot());
  const guarded = withErasureRecovery({
    DB: native.db,
    ERASURE_BUCKET: native.registry,
    ERASURE_REQUIRED: "true",
  }).DB;
  expect(
    (yield* Effect.result(Effect.tryPromise(() => guarded.prepare("SELECT * FROM users").all())))
      ._tag
  ).toBe("Failure");
  expect((yield* send({ action: "ReleaseRestore" })).status).toBe(202);
  expect((yield* send({ action: "Restore" })).status).toBe(202);
  expect((yield* send({ action: "Restore" })).status).toBe(202);
  expect((yield* send({ action: "ReleaseRestore" })).status).toBe(202);
  expect(
    (yield* Effect.result(Effect.tryPromise(() => guarded.prepare("SELECT * FROM users").all())))
      ._tag
  ).toBe("Failure");
  yield* advanceToExternal({ db: () => native.db, send });
  expect((yield* send({ action: "ReleaseRestore" })).status).toBe(200);
  expect(
    yield* Effect.tryPromise(() =>
      guarded.prepare("SELECT count(*) FROM users WHERE id=?").bind(userId).first("count(*)")
    )
  ).toBe(0);
  expect(
    yield* Effect.tryPromise(() =>
      guarded
        .prepare("SELECT count(*) FROM web_sessions WHERE user_id=?")
        .bind(userId)
        .first("count(*)")
    )
  ).toBe(0);
  expect(
    yield* Effect.tryPromise(() =>
      guarded.prepare("SELECT count(*) FROM users WHERE id=?").bind(foreignUser).first("count(*)")
    )
  ).toBe(1);
  expect(
    yield* Effect.tryPromise(() =>
      guarded
        .prepare("SELECT count(*) FROM web_sessions WHERE user_id=?")
        .bind(foreignUser)
        .first("count(*)")
    )
  ).toBe(1);
  const receipt = yield* send({ action: "Receipt", userId, reference });
  expect(receipt.status).toBe(200);
  expect(yield* Effect.tryPromise(() => receipt.json())).toMatchObject({
    state: "ExternalPending",
    retained: [{ dataClass: "memory" }],
    next: "retention-review",
  });
  expect(
    (yield* Effect.tryPromise(() => native.registry.list({ prefix: `held-records/${reference}/` })))
      .objects.length
  ).toBe(2);
  const remaining = heldUntil - (yield* Clock.currentTimeMillis);
  if (remaining > 0) yield* Effect.sleep(remaining + 20);
  for (let count = 0; count < 5; count++) {
    expect((yield* send({ action: "Continue", userId, reference })).status).toBe(202);
  }
  expect(
    (yield* Effect.tryPromise(() => native.registry.list({ prefix: `held-records/${reference}/` })))
      .objects
  ).toHaveLength(0);
  expect(
    yield* Effect.tryPromise(() =>
      native.db
        .prepare("SELECT count(*) FROM erasure_archives WHERE request_id=?")
        .bind(reference)
        .first("count(*)")
    )
  ).toBe(0);
  expect(
    yield* Effect.tryPromise(() =>
      native.db
        .prepare(
          "SELECT state FROM erasure_custody_evidence WHERE request_id=? AND custodian='Cloudflare'"
        )
        .bind(reference)
        .first("state")
    )
  ).toBe("Pending");
});
effectIt.layer(NodeFileSystem.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "reapplies erased scope to an older native database before releasing ordinary access",
    () => verifyRestore,
    { timeout: 60000 }
  );
});
