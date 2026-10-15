import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureOperatorReceipt } from "../../src/core/erasure/contract";
import { installRetentionTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { deletionDecision } from "./erasure.test-fixture";
import {
  executeErasureControl,
  executeErasureRestore,
  executeErasureRetentionReview,
  resumeErasureCases,
} from "./operations";
import { withErasureRecovery } from "./runtime";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const userId = "12740000-0000-4000-8000-000000000001";
const reference = "12740000-0000-4000-8000-000000000002";
const reviewRef = "12740000-0000-4000-8000-000000000004";
const foreignUser = "12740000-0000-4000-8000-000000000099";

it("requires a fresh exact-User control review, preserves unresolved custody and replays renewed deadlines after rollback", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const current = yield* Clock.currentTimeMillis;
      const decision = deletionDecision({ userId, reference, current: current - 41 * 86400000 });
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(decision);
      const custody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        reference,
        custodian: "Kapso",
        evidenceRef: reviewRef,
        outcome: { status: "Unresolved", reason: "retention-conflict" },
      });
      const marker = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        decision,
        sealed: true,
        requestedAtMs: current,
        reviewedAtMs: current,
        operatorRef: "obarboza@fidyapp.com",
      });
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json,last_erased_at_ms) VALUES(?,?,?,'ExternalPending',?,?)"
            )
            .bind(reference, userId, current, encoded, current),
          db
            .prepare(
              "INSERT INTO erasure_custody_evidence(request_id,custodian,state,evidence_json) VALUES(?,'Kapso','Unresolved',?)"
            )
            .bind(reference, custody),
        ])
      );
      yield* Effect.tryPromise(() => bucket.put(`recovery/cases/${reference}`, marker));
      yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
      const recovery = { db, bucket: Option.some(bucket) };
      const admission = {
        userId,
        reference,
        deadlineMs: current + 5000,
        authority: {
          permission: "titular.erase",
          operatorRef: "obarboza@fidyapp.com",
          expiresAtMs: current + 60000,
        },
      };
      const receipt = yield* executeErasureControl({
        db,
        userId,
        candidate: admission,
        operation: "Receipt",
        stores: [],
        bucket: Option.some(bucket),
      });
      const before = yield* Schema.decodeUnknownEffect(ErasureOperatorReceipt)(
        yield* Effect.tryPromise(() => receipt.json())
      );
      expect(before.next).toBe("retention-review");
      const candidate = {
        ...admission,
        previousReviewRef: decision.receiptRetention.reviewRef,
        receiptRetention: {
          ...decision.receiptRetention,
          reviewRef,
          reviewAtMs: current + 86400000,
          untilMs: current + 40 * 86400000,
        },
        recoveryRetention: {
          ...decision.recovery.retention,
          reviewRef,
          reviewAtMs: current + 86400000,
          untilMs: current + 40 * 86400000,
        },
      };
      const submit = (value: unknown, target = userId): Effect.Effect<Response> =>
        executeErasureRetentionReview({ userId: target, candidate: value, stores: [], recovery });
      expect((yield* submit({ ...candidate, userId: foreignUser })).status).toBe(409);
      expect((yield* submit({ ...candidate, deadlineMs: current - 1 })).status).toBe(409);
      expect(
        (yield* submit({
          ...candidate,
          recoveryRetention: { ...candidate.recoveryRetention, untilMs: current + 1 },
        })).status
      ).toBe(409);
      expect(
        (yield* submit({
          ...candidate,
          receiptRetention: {
            ...candidate.receiptRetention,
            reviewRef: decision.receiptRetention.reviewRef,
          },
        })).status
      ).toBe(409);
      expect((yield* submit({ ...candidate, dispositions: {} })).status).toBe(409);
      expect((yield* submit(candidate)).status).toBe(202);
      expect((yield* submit(candidate)).status).toBe(409);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT state FROM erasure_custody_evidence WHERE request_id=? AND custodian='Kapso'"
            )
            .bind(reference)
            .first("state")
        )
      ).toBe("Unresolved");
      const generation = yield* Effect.tryPromise(() =>
        bucket.get("recovery/generation").then((object) => object?.text())
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE erasure_requests SET decision_json=? WHERE id=?")
          .bind(encoded, reference)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE erasure_generation SET generation='initial' WHERE id=1").run()
      );
      const guarded = withErasureRecovery({ DB: db, ERASURE_BUCKET: bucket }).DB;
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() => guarded.prepare("SELECT id FROM erasure_requests").all())
        ))._tag
      ).toBe("Failure");
      expect(
        (yield* executeErasureRestore({
          db,
          userId,
          candidate: { ...admission, generation },
          stores: [],
          recovery,
        })).status
      ).toBe(202);
      const restored = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT json_extract(decision_json,'$.receiptRetention.reviewRef') AS reviewRef FROM erasure_requests WHERE id=?"
          )
          .bind(reference)
          .first("reviewRef")
      );
      expect(restored).toBe(reviewRef);
    })
  ));

it("refuses completed-case renewal before changing controls that are eligible for terminal cleanup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const current = yield* Clock.currentTimeMillis;
      const historical = current - 41 * 86400000;
      const decision = deletionDecision({ userId, reference, current: historical });
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(decision);
      const marker = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        decision,
        sealed: true,
        requestedAtMs: historical,
        reviewedAtMs: historical,
        operatorRef: "obarboza@fidyapp.com",
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json,last_erased_at_ms) VALUES(?,?,?,'Complete',?,?)"
          )
          .bind(reference, userId, historical, encoded, historical)
          .run()
      );
      yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
      const installed = yield* Effect.tryPromise(() =>
        bucket.put(`recovery/cases/${reference}`, marker)
      );
      if (installed === null) return yield* Effect.die(new Error("Native marker write failed"));
      const next = deletionDecision({ userId, reference, current });
      const candidate = {
        userId,
        reference,
        deadlineMs: current + 5000,
        authority: {
          permission: "titular.erase",
          operatorRef: "obarboza@fidyapp.com",
          expiresAtMs: current + 60000,
        },
        previousReviewRef: decision.receiptRetention.reviewRef,
        receiptRetention: { ...next.receiptRetention, reviewRef },
        recoveryRetention: { ...next.recovery.retention, reviewRef },
      };
      const response = yield* executeErasureRetentionReview({
        userId,
        candidate,
        stores: [],
        recovery: { db, bucket: Option.some(bucket) },
      });
      expect(response.status).toBe(409);
      expect(
        (yield* Effect.tryPromise(() => bucket.head(`recovery/cases/${reference}`)))?.etag
      ).toBe(installed.etag);
      expect(
        yield* Effect.tryPromise(() =>
          bucket.get("recovery/generation").then((object) => object?.text())
        )
      ).toBe("initial");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT decision_json FROM erasure_requests WHERE id=?")
            .bind(reference)
            .first("decision_json")
        )
      ).toBe(encoded);
      yield* resumeErasureCases({
        db,
        bucket: Option.some(bucket),
        coordinator: {
          getByName: (): Pick<Fetcher, "fetch"> => ({
            fetch: () => Promise.reject(new Error("Completed case must not resume")),
          }),
        },
      });
      expect(yield* Effect.tryPromise(() => bucket.head(`recovery/cases/${reference}`))).toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) FROM erasure_requests WHERE id=?")
            .bind(reference)
            .first("count(*)")
        )
      ).toBe(0);
    })
  ));
