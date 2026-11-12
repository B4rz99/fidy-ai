import { afterEach, expect, vi } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { installRetentionTestSchema } from "../d1-test-fixture";
import { handleErasureRequest, withErasureRecovery } from "./runtime";
import { executeErasureRestore, makeErasureOwner } from "./operations";
import { UserId } from "../../src/core/identity/contract";
import type { ErasureContinuation } from "./contract";
import { nativeErasurePlatform } from "./native.test-fixture";
import { ErasureOperatorReceipt, ErasureProvider } from "../../src/core/erasure/contract";
import { ErasureUnavailable } from "../erasure-store/contract";
import { makeErasureOriginals } from "../erasure-store/runtime";
import { makeMemoryErasureStores } from "../memory/runtime";

afterEach(() => vi.useRealTimers());
const userId = "12740000-0000-4000-8000-000000000001";
const foreignUser = "12740000-0000-4000-8000-000000000099";
const sessionId = "12740000-0000-4000-8000-000000000002";
const foreignSession = "12740000-0000-4000-8000-000000000098";
const reference = "12740000-0000-4000-8000-000000000003";
const bearer = "x".repeat(43);
const setup = Effect.gen(function* () {
  const platform = yield* nativeErasurePlatform;
  const native = yield* Effect.tryPromise(() => platform.acquire());
  const { db, registry: bucket } = native;
  yield* Effect.tryPromise(() => installRetentionTestSchema(db));
  const current = yield* Clock.currentTimeMillis;
  const digest = new Uint8Array(
    yield* Effect.tryPromise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))
    )
  );
  for (const [id, sid, pairing, proof, code] of [
    [userId, sessionId, reference, digest, "ABCD-EFGH"],
    [foreignUser, foreignSession, foreignUser, new Uint8Array(32).fill(9), "JKLM-NPQR"],
  ] as const) {
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(id, current),
        db
          .prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,?,?,?,'consumed',?,?)"
          )
          .bind(pairing, code, proof, id, current, current + 600000),
        db
          .prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,?,?,?,?,?)"
          )
          .bind(
            sid,
            pairing,
            id,
            proof,
            current,
            current + 600000,
            current + 3600000,
            current + 7776000000
          ),
      ])
    );
  }
  return { db, bucket, originals: native.originals, coordinator: native.coordinator, digest };
});
const submit = (
  input: Effect.Success<typeof setup>,
  body: unknown = { confirm: true }
): Effect.Effect<Response, Schema.SchemaError> =>
  Effect.gen(function* () {
    return yield* handleErasureRequest({
      db: input.db,
      coordinator: input.coordinator,
      browserOrigin: "https://app.fidyapp.com",
      request: new Request("https://api.fidyapp.com/web/privacy/erasure", {
        method: "POST",
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: `__Host-fidy_session=${bearer}`,
          "content-type": "application/json",
        },
        body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body),
      }),
    });
  });

const verifyExternalCustody = Effect.gen(function* () {
  const { db, bucket, originals, digest } = yield* setup;
  const current = yield* Clock.currentTimeMillis;
  const key = `users/${userId}/unindexed-original`;
  yield* Effect.tryPromise(() => originals.put(key, "Private original"));
  yield* Effect.tryPromise(() =>
    db.prepare("INSERT INTO memories VALUES('retained',?,'Privado',1,1)").bind(userId).run()
  );
  const owner = makeErasureOwner({
    db,
    userId,
    stores: makeMemoryErasureStores(db),
    recovery: { db, bucket: Option.some(bucket) },
    originals: makeErasureOriginals({
      db,
      email: Option.some(originals),
      statement: Option.some(originals),
      registry: Option.some(bucket),
    }),
    clearCoordinator: () => Effect.succeed(true),
  });
  const accepted = yield* owner.admit(
    { userId, sessionId, digest: Array.from(digest), deadlineMs: current + 5000 },
    yield* Effect.abortSignal
  );
  expect(accepted.status).toBe(202);
  const admitted = yield* Schema.decodeUnknownEffect(Schema.Struct({ reference: Schema.String }))(
    yield* Effect.tryPromise(() => accepted.json())
  );
  const candidate = (now: number): ErasureContinuation => ({
    userId: UserId.make(userId),
    reference: admitted.reference,
    deadlineMs: now + 5000,
    authority: {
      permission: "titular.erase",
      operatorRef: "operator",
      expiresAtMs: now + 60000,
    },
  });
  const observe = Effect.gen(function* () {
    const response = yield* owner.receipt(candidate(yield* Clock.currentTimeMillis));
    expect(response.status).toBe(200);
    return yield* Schema.decodeUnknownEffect(ErasureOperatorReceipt)(
      yield* Effect.tryPromise(() => response.json())
    );
  });
  for (let opportunity = 0; opportunity < 8; opportunity += 1) {
    expect((yield* owner.continue(candidate(yield* Clock.currentTimeMillis))).status).toBe(202);
    if ((yield* observe).state === "ExternalPending") break;
  }
  const local = yield* observe;
  expect(local).toMatchObject({
    state: "ExternalPending",
    completed: ["memory"],
    next: "provider-evidence",
  });
  expect(local.recoveryUntilMs).not.toBeNull();
  expect(yield* Effect.tryPromise(() => originals.head(key))).toBeNull();
  expect(
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT count(*) FROM memories WHERE user_id=?").bind(userId).first("count(*)")
    )
  ).toBe(0);
  const retain = (
    custodian: ErasureProvider,
    status: "Accepted" | "Verified",
    suffix: number
  ): Effect.Effect<Response> =>
    Effect.gen(function* () {
      return yield* owner.custody({
        ...candidate(yield* Clock.currentTimeMillis),
        evidence: {
          reference: admitted.reference,
          custodian,
          evidenceRef: `12740000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
          outcome: { status },
        },
      });
    });
  expect((yield* retain("Cloudflare", "Verified", 30)).status).toBe(409);
  for (const [index, custodian] of ErasureProvider.literals.entries()) {
    expect((yield* retain(custodian, "Accepted", 40 + index)).status).toBe(202);
  }
  vi.useFakeTimers({ toFake: ["Date"], now: current + 31 * 86400000 });
  expect((yield* owner.continue(candidate(yield* Clock.currentTimeMillis))).status).toBe(202);
  expect((yield* observe).state).toBe("ExternalPending");
  yield* Effect.tryPromise(() =>
    db
      .prepare(
        "DELETE FROM erasure_custody_records WHERE record_type='current' AND request_id=? AND custodian='Wompi'"
      )
      .bind(admitted.reference)
      .run()
  );
  for (const [index, custodian] of ErasureProvider.literals.entries()) {
    if (custodian !== "Wompi") {
      expect((yield* retain(custodian, "Verified", 50 + index)).status).toBe(202);
    }
  }
  expect((yield* owner.continue(candidate(yield* Clock.currentTimeMillis))).status).toBe(202);
  expect((yield* observe).state).toBe("ExternalPending");
  yield* Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO erasure_custody_records(record_type,request_id,custodian,state) VALUES('current',?,'Wompi','Pending')"
      )
      .bind(admitted.reference)
      .run()
  );
  expect((yield* retain("Wompi", "Verified", 60)).status).toBe(202);
  expect((yield* owner.continue(candidate(yield* Clock.currentTimeMillis))).status).toBe(202);
  expect(yield* observe).toMatchObject({ state: "Complete", next: "none" });
});
effectIt.layer(NodeFileSystem.layer, { excludeTestServices: true })((it) => {
  it.effect("refuses caller-selected subjects without creating an erasure request", () =>
    Effect.gen(function* () {
      const native = yield* setup;
      expect(
        (yield* submit(native, {
          confirm: true,
          caseRef: reference,
          scopeRef: reference,
          authorityRef: reference,
          userId: foreignUser,
        })).status
      ).toBe(400);
      expect(
        yield* Effect.tryPromise(() =>
          native.db.prepare("SELECT count(*) FROM erasure_requests").first("count(*)")
        )
      ).toBe(0);
    })
  );

  it.effect(
    "starts authenticated deletion directly, keeps one request on replay and refuses a stale browser",
    () =>
      Effect.gen(function* () {
        const native = yield* setup;
        const first = yield* submit(native);
        expect(first.status).toBe(202);
        const original = yield* Effect.tryPromise(() => first.text());
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(original)
        ).toMatchObject({ state: "Draining", next: "admitted-work" });
        const duplicate = yield* submit(native);
        expect(duplicate.status).toBe(202);
        expect(yield* Effect.tryPromise(() => duplicate.text())).toBe(original);
        vi.useFakeTimers({ toFake: ["Date"], now: (yield* Clock.currentTimeMillis) + 600001 });
        expect((yield* submit(native)).status).toBe(401);
        expect(
          (yield* Effect.tryPromise(() =>
            native.db.prepare("SELECT user_id FROM erasure_requests").all()
          )).results
        ).toEqual([{ user_id: userId }]);
      })
  );

  it.effect(
    "rechecks fresh same-User browser proof at coordinated admission before fencing either User",
    () =>
      Effect.gen(function* () {
        const native = yield* setup;
        const { db, bucket, digest } = native;
        const current = yield* Clock.currentTimeMillis;
        const candidate = {
          userId,
          sessionId,
          digest: Array.from(digest),
          deadlineMs: current + 5000,
        };
        const signal = yield* Effect.abortSignal;
        const owner = makeErasureOwner({
          db,
          userId,
          stores: makeMemoryErasureStores(db),
          recovery: { db, bucket: Option.some(bucket) },
          originals: makeErasureOriginals({
            db,
            email: Option.none(),
            statement: Option.none(),
            registry: Option.none(),
          }),
          clearCoordinator: () => Effect.succeed(false),
        });
        const act = (value: unknown): Effect.Effect<Response> => owner.admit(value, signal);
        for (const refused of [
          { ...candidate, userId: foreignUser },
          {
            ...candidate,
            sessionId: foreignSession,
            digest: Array.from(new Uint8Array(32).fill(9)),
          },
          { ...candidate, deadlineMs: current },
          { ...candidate, deadlineMs: current + 60000 },
          { ...candidate, phase: "Complete" },
          { ...candidate, digest: Array.from(new Uint8Array(32).fill(7)) },
        ]) {
          expect((yield* act(refused)).status).toBe(409);
        }
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) FROM erasure_requests").first("count(*)")
          )
        ).toBe(0);
        expect(
          yield* Effect.tryPromise(() => db.prepare("SELECT count(*) FROM users").first("count(*)"))
        ).toBe(2);
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE web_sessions SET revoked_at_ms=? WHERE id=?")
            .bind(current, sessionId)
            .run()
        );
        expect((yield* act(candidate)).status).toBe(409);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) FROM erasure_requests").first("count(*)")
          )
        ).toBe(0);
      })
  );

  it.effect(
    "rechecks every bound operation and waits for coordinator clearance before deleting",
    () =>
      Effect.gen(function* () {
        const { db, bucket, digest } = yield* setup;
        const current = yield* Clock.currentTimeMillis;
        yield* Effect.tryPromise(() =>
          db.prepare("INSERT INTO memories VALUES('retained',?,'Privado',1,1)").bind(userId).run()
        );
        let clearanceAttempts = 0;
        let clearance: "Blocked" | "Unknown" | "Cleared" = "Blocked";
        const configuration = {
          db,
          userId,
          stores: makeMemoryErasureStores(db),
          originals: makeErasureOriginals({
            db,
            email: Option.none(),
            statement: Option.none(),
            registry: Option.none(),
          }),
          recovery: { db, bucket: Option.some(bucket) },
          clearCoordinator: (): Effect.Effect<boolean, ErasureUnavailable> =>
            Effect.gen(function* () {
              clearanceAttempts += 1;
              if (clearance === "Unknown") return yield* new ErasureUnavailable();
              return clearance === "Cleared";
            }),
        };
        const owner = makeErasureOwner(configuration);
        const admission = yield* owner.admit(
          { userId, sessionId, digest: Array.from(digest), deadlineMs: current + 5000 },
          yield* Effect.abortSignal
        );
        expect(admission.status).toBe(202);
        const admitted = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ reference: Schema.String })
        )(yield* Effect.tryPromise(() => admission.json()));
        const candidate = {
          userId,
          reference: admitted.reference,
          deadlineMs: (yield* Clock.currentTimeMillis) + 5000,
          authority: {
            permission: "titular.erase",
            operatorRef: "operator",
            expiresAtMs: current + 300000,
          },
        };
        const evidence = {
          reference: admitted.reference,
          custodian: "Cloudflare",
          evidenceRef: reference,
          outcome: { status: "Accepted" },
        };
        for (const refused of [
          { ...candidate, userId: foreignUser },
          { ...candidate, deadlineMs: current },
          { ...candidate, authority: { ...candidate.authority, expiresAtMs: current } },
          { ...candidate, phase: "Erasing" },
        ]) {
          expect((yield* owner.continue(refused)).status).toBe(409);
          expect((yield* owner.receipt(refused)).status).toBe(409);
          expect((yield* owner.custody({ ...refused, evidence })).status).toBe(409);
        }
        expect(clearanceAttempts).toBe(0);
        expect((yield* owner.continue(candidate)).status).toBe(202);
        expect(clearanceAttempts).toBe(0);
        expect((yield* owner.continue(candidate)).status).toBe(202);
        expect(clearanceAttempts).toBe(1);
        clearance = "Unknown";
        expect((yield* owner.continue(candidate)).status).toBe(503);
        const observed = yield* owner.receipt(candidate);
        expect(yield* Effect.tryPromise(() => observed.json())).toMatchObject({
          state: "Sealing",
          completed: [],
          next: "continue",
        });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT count(*) FROM memories WHERE user_id=?")
              .bind(userId)
              .first("count(*)")
          )
        ).toBe(1);
        expect(
          (yield* makeErasureOwner({ ...configuration, stores: [] }).continue(candidate)).status
        ).toBe(503);
        expect(clearanceAttempts).toBe(2);
        clearance = "Cleared";
        expect((yield* owner.continue(candidate)).status).toBe(202);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT count(*) FROM memories WHERE user_id=?")
              .bind(userId)
              .first("count(*)")
          )
        ).toBe(1);
        const sealed = yield* owner.receipt(candidate);
        expect(yield* Effect.tryPromise(() => sealed.json())).toMatchObject({
          state: "Erasing",
          completed: [],
        });
        vi.useFakeTimers({ toFake: ["Date"], now: current + 300001 });
        expect((yield* owner.continue(candidate)).status).toBe(409);
        expect((yield* owner.receipt(candidate)).status).toBe(409);
        expect((yield* owner.custody({ ...candidate, evidence })).status).toBe(409);
        expect(clearanceAttempts).toBe(3);
      })
  );

  it.effect(
    "retains external obligations beyond the horizon until every custodian supplies terminal evidence",
    () => verifyExternalCustody
  );

  it.effect(
    "keeps recovery fenced when a deletion marker may still be published after a failed admission",
    () =>
      Effect.gen(function* () {
        const native = yield* setup;
        const { db, bucket, digest } = native;
        const current = yield* Clock.currentTimeMillis;
        const nativePut = bucket.put.bind(bucket);
        let latePublication = Option.none<() => ReturnType<R2Bucket["put"]>>();
        const put: R2Bucket["put"] = (key, value, options) => {
          if (key.startsWith("recovery/cases/")) {
            latePublication = Option.some(() => nativePut(key, value, options));
            return Promise.reject(new Error("Publication outcome unknown"));
          }
          return nativePut(key, value, options);
        };
        const publicationBucket = new Proxy(bucket, {
          get: (target, property): unknown =>
            property === "put" ? put : Reflect.get(target, property, target),
        });
        const recovery = { db, bucket: Option.some(publicationBucket) };
        expect(
          (yield* makeErasureOwner({
            db,
            userId,
            stores: makeMemoryErasureStores(db),
            recovery,
            originals: makeErasureOriginals({
              db,
              email: Option.none(),
              statement: Option.none(),
              registry: Option.none(),
            }),
            clearCoordinator: () => Effect.succeed(false),
          }).admit(
            { userId, sessionId, digest: Array.from(digest), deadlineMs: current + 5000 },
            yield* Effect.abortSignal
          )).status
        ).toBe(503);
        const guarded = withErasureRecovery({ DB: db, ERASURE_BUCKET: bucket }).DB;
        const observe = Effect.tryPromise(() => guarded.prepare("SELECT id FROM users").all());
        expect((yield* Effect.result(observe))._tag).toBe("Failure");
        expect(
          (yield* executeErasureRestore({
            db,
            userId,
            recovery,
            stores: [],
            candidate: {
              userId,
              reference,
              authority: {
                permission: "titular.erase",
                operatorRef: "operator",
                expiresAtMs: current + 300000,
              },
              deadlineMs: current + 5000,
              generation: "initial",
            },
          })).status
        ).toBe(503);
        yield* Effect.tryPromise(Option.getOrThrow(latePublication));
        expect((yield* Effect.result(observe))._tag).toBe("Failure");
        expect(
          (yield* Effect.tryPromise(() =>
            db.prepare("SELECT user_id,state FROM erasure_requests").all()
          )).results
        ).toEqual([{ user_id: userId, state: "Draining" }]);
      })
  );
});
