import { ErasureOperatorReceipt } from "../../src/core/erasure/contract";
import { it as effectIt } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { HttpClient } from "effect/http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, expect, vi } from "vitest";
import { fixtureNativeHttpClient } from "../core-worker.test-fixture";
import { installRetentionTestSchema } from "../d1-test-fixture";
import { nativeErasurePlatform, seedPersonalClasses } from "./native.test-fixture";
import type { ErasureUnavailable } from "../erasure-store/contract";
import { resumeErasureCases } from "./operations";
import { handleErasureOperator, withErasureRecovery } from "./runtime";
import { makePublicWorker } from "../public-worker";
import { makeWorkerTelemetry } from "../runtime/telemetry/operations";

const userId = "12740000-0000-4000-8000-000000000001";
const foreignUser = "12740000-0000-4000-8000-000000000099";
let reference = "12740000-0000-4000-8000-000000000002";
const issuer = "https://erasure-test.cloudflareaccess.com";
const audience = "erasure-only";
const ingress = makePublicWorker(
  makeWorkerTelemetry({ exportWork: () => undefined, exportEvent: () => undefined })
);
const override = 'private-core="12740000-0000-4000-8000-000000000001"';
const json = Schema.fromJsonString(Schema.Unknown);
afterEach(() => vi.restoreAllMocks());
const advanceToExternal = (
  input: Readonly<{
    db: () => D1Database;
    send: (command: unknown) => Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError>;
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
  send: (command: unknown) => Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError>
): Effect.Effect<void, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
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

const expiredRequest = "12740000-0000-4000-8000-000000000084";
const expiredUser = "12740000-0000-4000-8000-000000000083";
const seedExpiredCase = (
  db: D1Database,
  current: number,
  bucket: R2Bucket
): Effect.Effect<number, Schema.SchemaError | Cause.UnknownError | ErasureUnavailable> =>
  Effect.gen(function* () {
    // A supported snapshot can still contain completed metadata whose independent
    // marker legitimately expired after all backups containing User content aged out.
    const erasedAt = current - 31 * 86400000;
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,last_erased_at_ms,marker_written,coordinator_cleared) VALUES(?,?,?,'Complete',?,1,1)"
          )
          .bind(expiredRequest, expiredUser, erasedAt, erasedAt),
        db.prepare("INSERT INTO erasure_steps VALUES(?,'users',1)").bind(expiredRequest),
      ])
    );
    for (const [index, custodian] of ["Cloudflare", "Kapso", "Meta", "Resend", "Wompi"].entries()) {
      const evidenceRef = `12740000-0000-4000-8000-00000000010${index}`;
      const evidence = yield* Schema.encodeEffect(json)({
        reference: expiredRequest,
        custodian,
        evidenceRef,
        outcome: { status: "Verified" },
      });
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_custody_records(record_type,request_id,custodian,id,evidence_json,recorded_at_ms,operator_ref) VALUES('event',?,?,?,?,?,'operator')"
            )
            .bind(expiredRequest, custodian, evidenceRef, evidence, erasedAt),
          db
            .prepare(
              "INSERT INTO erasure_custody_records(record_type,request_id,custodian,state,current_event_id) VALUES('current',?,?,'Verified',?)"
            )
            .bind(expiredRequest, custodian, evidenceRef),
        ])
      );
    }
    for (let index = 0; index < 65; index++) {
      const evidenceRef = `12740000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`;
      const evidence = yield* Schema.encodeEffect(json)({
        reference: expiredRequest,
        custodian: "Kapso",
        evidenceRef,
        outcome: { status: "Accepted" },
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO erasure_custody_records(record_type,request_id,custodian,id,evidence_json,recorded_at_ms,operator_ref) VALUES('event',?,'Kapso',?,?,?,'operator')"
          )
          .bind(expiredRequest, evidenceRef, evidence, erasedAt)
          .run()
      );
    }
    const marker = yield* Schema.encodeEffect(json)({
      reference: expiredRequest,
      userId: expiredUser,
      requestedAtMs: erasedAt,
      sealed: true,
    });
    yield* Effect.tryPromise(() => bucket.put(`recovery/cases/${expiredRequest}`, marker));
    yield* resumeErasureCases({
      db,
      bucket: Option.some(bucket),
      coordinator: {
        getByName: (): Pick<Fetcher, "fetch"> => ({
          fetch: (): Promise<Response> =>
            Promise.reject(new Error("Completed cleanup requires no User operation")),
        }),
      },
    });
    expect(
      yield* Effect.tryPromise(() => bucket.head(`recovery/cases/${expiredRequest}`))
    ).toBeNull();
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT count(*) AS count FROM erasure_requests WHERE id=?")
          .bind(expiredRequest)
          .first("count")
      )
    ).toBe(1);
    expect(
      yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT count(*) AS count FROM erasure_custody_records WHERE request_id=?")
          .bind(expiredRequest)
          .first("count")
      )
    ).toBe(11);
    return erasedAt;
  });
const verifyExpiredMetadata = (
  input: Readonly<{
    db: D1Database;
    guarded: D1Database;
    current: number;
    erasedAt: number;
    send: (command: unknown) => Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError>;
  }>
): Effect.Effect<void, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      input.db
        .prepare("UPDATE erasure_requests SET last_erased_at_ms=? WHERE id=?")
        .bind(input.current - 29 * 86400000, expiredRequest)
        .run()
    );
    expect((yield* input.send({ action: "ReleaseRestore" })).status).toBe(202);
    yield* Effect.tryPromise(() =>
      input.db
        .prepare("UPDATE erasure_requests SET last_erased_at_ms=NULL WHERE id=?")
        .bind(expiredRequest)
        .run()
    );
    expect((yield* input.send({ action: "ReleaseRestore" })).status).toBe(202);
    expect(
      (yield* Effect.result(
        Effect.tryPromise(() => input.guarded.prepare("SELECT * FROM users").all())
      ))._tag
    ).toBe("Failure");
    yield* Effect.tryPromise(() =>
      input.db
        .prepare("UPDATE erasure_requests SET last_erased_at_ms=? WHERE id=?")
        .bind(input.erasedAt, expiredRequest)
        .run()
    );
    expect((yield* input.send({ action: "ReleaseRestore" })).status).toBe(200);
  });

const admitNativeDeletion = (
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>
): Effect.Effect<string, Schema.SchemaError | Cause.UnknownError> =>
  Effect.gen(function* () {
    const admissionBody = yield* Schema.encodeEffect(json)({
      userId,
      sessionId: userId,
      digest: Array.from(new Uint8Array(32).fill(1)),
      deadlineMs: (yield* Clock.currentTimeMillis) + 5000,
    });
    const admissionResponse = yield* Effect.tryPromise(() =>
      coordinator.getByName(userId).fetch(
        new Request("https://coordinator.internal/erasure-admit", {
          method: "POST",
          body: admissionBody,
        })
      )
    );
    expect(admissionResponse.status).toBe(202);
    return (yield* Schema.decodeUnknownEffect(Schema.Struct({ reference: Schema.String }))(
      yield* Effect.tryPromise(() => admissionResponse.json())
    )).reference;
  });

const verifyRestore = Effect.gen(function* () {
  const platform = yield* nativeErasurePlatform;
  let native = yield* Effect.tryPromise(() => platform.acquire());
  const current = yield* Clock.currentTimeMillis;
  for (const db of [native.db, native.snapshot]) {
    yield* Effect.tryPromise(() => installRetentionTestSchema(db));
    yield* Effect.tryPromise(() =>
      db.batch(
        [userId, foreignUser].map((id) =>
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
            )
            .bind(id, current)
        )
      )
    );
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO memories VALUES('target-memory',?,'Retener',1792022400000,1792022400000)"
          )
          .bind(userId),
        db
          .prepare(
            "INSERT INTO memories VALUES('foreign-memory',?,'Conservar',1792022400000,1792022400000)"
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
        .prepare(
          "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,last_activity_at_ms,status) VALUES(?,?,'{}',?,?,'active')"
        )
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
  const erasedAt = yield* seedExpiredCase(native.snapshot, current, native.registry);
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
    assertion: string = token,
    route: "owner" | "candidate" = "owner"
  ): Effect.Effect<Response, Schema.SchemaError | Cause.UnknownError> =>
    Effect.gen(function* () {
      const body = yield* Schema.encodeEffect(json)(command);
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const dispatch = (request: Request): Promise<Response> =>
        run(
          handleErasureOperator({
            request,
            environment: {
              DB: native.db,
              ERASURE_BUCKET: native.registry,
              ERASURE_REQUIRED: "true",
              CLOUDFLARE_ACCESS_ISSUER: issuer,
              CLOUDFLARE_ACCESS_AUDIENCE: "recovery-only",
              ERASURE_SUPPORT_AUDIENCE: audience,
              USER_TRANSACTION_COORDINATOR: native.coordinator,
            },
          }).pipe(Effect.provideService(HttpClient.HttpClient, http))
        );
      const request = new Request("https://api.fidyapp.com/internal/titular-erasure", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": assertion,
          "cloudflare-workers-version-overrides": override,
        },
        body,
      });
      if (route === "owner") return yield* Effect.tryPromise(() => dispatch(request));
      return yield* Effect.tryPromise(() =>
        ingress.fetch(request, {
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          LOCAL_CANONICAL_READ_BEARER: "",
          PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
          RELEASE_GIT_SHA: "c".repeat(40),
          CORE: {
            fetch: (input) => {
              const forwarded = new Request(input);
              return forwarded.headers.get("cloudflare-workers-version-overrides") === override
                ? dispatch(forwarded)
                : Promise.resolve(new Response(null, { status: 404 }));
            },
          },
        })
      );
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
    expect((yield* send({ action: "Initialize" }, assertion, "candidate")).status).toBe(401);
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
  expect((yield* send({ action: "Initialize" }, forgedAssertion, "candidate")).status).toBe(401);
  expect((yield* send({ action: "Restore", userId })).status).toBe(400);
  yield* Effect.tryPromise(() => native.registry.delete("recovery/generation"));
  expect((yield* send({ action: "Initialize" }, token, "candidate")).status).toBe(204);
  reference = yield* admitNativeDeletion(native.coordinator);
  expect((yield* send({ action: "Initialize" }, token, "candidate")).status).toBe(503);
  yield* Effect.tryPromise(() =>
    native.db.prepare("DELETE FROM memories WHERE user_id=?").bind(userId).run()
  );

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
  // A restored empty writer ledger cannot prove that uploads admitted after that
  // snapshot have settled, even after every visible owner reports quiescence.
  yield* Effect.tryPromise(() =>
    native.db.batch([
      native.db
        .prepare(
          "INSERT INTO transcript_entries(id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms) SELECT ?,user_id,hosted_session_id,id,'interrupted',? FROM hosted_turns WHERE user_id=? AND status='pending'"
        )
        .bind("12740000-0000-4000-8000-000000000052", current, userId),
      native.db
        .prepare(
          "UPDATE hosted_turns SET status='interrupted',terminal_at_ms=? WHERE user_id=? AND status='pending'"
        )
        .bind(current, userId),
    ])
  );
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
  native = yield* Effect.tryPromise(() => platform.restoreLive());
  // These source-snapshot attempts had settled before the live deletion sealed.
  // Its independent sealed marker is the positive evidence for reconciling them.
  const staleKey = `users/${userId}/staging/statement/v1/${"c".repeat(64)}`;
  yield* Effect.tryPromise(() =>
    native.snapshot.batch([
      native.snapshot
        .prepare("INSERT INTO erasure_writers VALUES('old-target-attempt',?,'statement',?,?)")
        .bind(userId, staleKey, current),
      native.snapshot
        .prepare("INSERT INTO erasure_writers VALUES('other-User-attempt',?,'statement',?,?)")
        .bind(foreignUser, `users/${foreignUser}/staging/statement/v1/${"d".repeat(64)}`, current),
    ])
  );
  yield* Effect.tryPromise(() => native.originals.put(staleKey, "Completed upload"));
  yield* advanceToExternal({ db: () => native.db, send });
  expect((yield* send({ action: "Receipt", userId, reference })).status).toBe(200);
  expect(
    (yield* Effect.tryPromise(() =>
      native.registry.list({ prefix: `users/${userId}/held-records/${reference}/` })
    )).objects.length
  ).toBe(0);
  yield* verifyProcessorEvidence(send);
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
  yield* verifyExpiredMetadata({ db: native.db, guarded, send, current, erasedAt });
  expect(
    yield* Effect.tryPromise(() =>
      native.db
        .prepare("SELECT id FROM erasure_writers ORDER BY id")
        .all()
        .then((rows) => rows.results)
    )
  ).toEqual([{ id: "other-User-attempt" }]);
  expect(yield* Effect.tryPromise(() => native.originals.head(staleKey))).toBeNull();

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
    next: "provider-evidence",
  });
  expect(
    (yield* Effect.tryPromise(() =>
      native.registry.list({ prefix: `users/${userId}/held-records/${reference}/` })
    )).objects.length
  ).toBe(0);

  expect(
    yield* Effect.tryPromise(() =>
      native.db
        .prepare(
          "SELECT state FROM (SELECT c.rowid,c.request_id,c.custodian,c.state,e.evidence_json FROM erasure_custody_records c LEFT JOIN erasure_custody_records e ON e.event_identity=c.current_event_id WHERE c.record_type='current') WHERE request_id=? AND custodian='Cloudflare'"
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
