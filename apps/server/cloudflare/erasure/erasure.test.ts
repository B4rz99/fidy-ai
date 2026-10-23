import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { installRetentionTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { handleErasureRequest } from "./runtime";
import { executeErasureReview } from "./operations";
import { deletionDecision } from "./erasure.test-fixture";

const databases = isolatedTestStorage();
afterAll(() => databases.dispose());
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());
const userId = "12740000-0000-4000-8000-000000000001";
const sessionId = "12740000-0000-4000-8000-000000000002";
const reference = "12740000-0000-4000-8000-000000000003";
const bearer = "x".repeat(43);
const submit = (db: D1Database): Effect.Effect<Response, Schema.SchemaError> =>
  Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      confirm: true,
    });
    return yield* handleErasureRequest({
      db,
      browserOrigin: "https://app.fidyapp.com",
      request: new Request("https://api.fidyapp.com/web/privacy/erasure", {
        method: "POST",
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: `__Host-fidy_session=${bearer}`,
          "content-type": "application/json",
        },
        body,
      }),
    });
  });
const setup = Effect.gen(function* () {
  const { db, bucket } = yield* Effect.tryPromise(() => databases.acquire());
  yield* Effect.tryPromise(() => installRetentionTestSchema(db));
  yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
  const current = yield* Clock.currentTimeMillis;
  const digest = new Uint8Array(
    yield* Effect.tryPromise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))
    )
  );
  yield* Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
        )
        .bind(userId, current),
      db
        .prepare(
          "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,'ABCD-EFGH',?,?,'consumed',?,?)"
        )
        .bind(reference, digest, userId, current, current + 600000),
      db
        .prepare(
          "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,?,?,?,?,?)"
        )
        .bind(
          sessionId,
          reference,
          userId,
          digest,
          current,
          current + 600000,
          current + 3600000,
          current + 7776000000
        ),
    ])
  );
  return { db, bucket };
});

it("refuses caller-selected subjects without creating an erasure request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* setup;
      const response = yield* handleErasureRequest({
        db,
        browserOrigin: "https://app.fidyapp.com",
        request: new Request("https://api.fidyapp.com/web/privacy/erasure", {
          method: "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: `__Host-fidy_session=${bearer}`,
            "content-type": "application/json",
          },
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            confirm: true,
            caseRef: reference,
            scopeRef: reference,
            authorityRef: reference,
            userId: "12740000-0000-4000-8000-000000000099",
          }),
        }),
      });
      expect(response.status).toBe(400);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM erasure_requests").first("count")
        )
      ).toBe(0);
    })
  ));

it("retains one explicit erasure request on replay and refuses a stale browser before any change", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* setup;
      const first = yield* submit(db);
      expect(first.status).toBe(202);
      const original = yield* Effect.tryPromise(() => first.text());
      const duplicate = yield* submit(db);
      expect(yield* Effect.tryPromise(() => duplicate.text())).toBe(original);
      vi.setSystemTime((yield* Clock.currentTimeMillis) + 600001);
      expect((yield* submit(db)).status).toBe(401);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) FROM erasure_requests").first("count(*)")
        )
      ).toBe(1);
    })
  ));

it("binds review to the verified User and immutable request, refusing foreign, expired and substituted decisions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* setup;
      const received = yield* submit(db);
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ reference: Schema.String })
      )(yield* Effect.tryPromise(() => received.json()));
      const current = yield* Clock.currentTimeMillis;
      const decision = deletionDecision({ userId, reference: receipt.reference, current });

      const admission = {
        userId,
        decision,
        authority: {
          permission: "titular.erase",
          operatorRef: "operator",
          expiresAtMs: current + 300000,
        },
        deadlineMs: current + 5000,
      };
      const act = (candidate: unknown): Effect.Effect<Response> =>
        executeErasureReview({
          db,
          userId,
          candidate,
          signal: new AbortController().signal,
          stores: [],
          recovery: { db, bucket: Option.some(bucket) },
        });
      expect(
        (yield* act({
          ...admission,
          decision: { ...decision, userId: "12740000-0000-4000-8000-000000000099" },
        })).status
      ).toBe(409);
      expect((yield* act({ ...admission, deadlineMs: current })).status).toBe(409);
      expect(
        (yield* act({
          ...admission,
          decision: {
            ...decision,
            receiptRetention: { ...decision.receiptRetention, reviewAtMs: current - 1 },
          },
        })).status
      ).toBe(409);
      expect(
        (yield* act({
          ...admission,
          decision: {
            ...decision,
            dispositions: {
              ...decision.dispositions,
              memory: {
                action: "Retain",
                retention: {
                  ...decision.receiptRetention,
                  purpose: "legal-hold",
                  reviewAtMs: current + 60000,
                  untilMs: current + 3600000,
                },
              },
            },
          },
        })).status
      ).toBe(409);
      expect((yield* act(admission)).status).toBe(202);
      expect((yield* act(admission)).status).toBe(202);
      expect(
        (yield* act({
          ...admission,
          decision: { ...decision, reviewRef: "12740000-0000-4000-8000-000000000077" },
        })).status
      ).toBe(409);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state FROM erasure_requests WHERE user_id=?")
            .bind(userId)
            .first("state")
        )
      ).toBe("Draining");
    })
  ));
