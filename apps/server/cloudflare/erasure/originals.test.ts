import { executeErasureContinuation } from "./operations";
import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { installRetentionTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { makeErasureOriginals } from "../erasure-store/runtime";
import { deletionDecision } from "./erasure.test-fixture";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const userId = "12740000-0000-4000-8000-000000000001";
const foreignUser = "12740000-0000-4000-8000-000000000099";
const reference = "12740000-0000-4000-8000-000000000002";
const targetKey = `users/${userId}/staging/statement/v1/${"a".repeat(64)}`;
const foreignKey = `users/${foreignUser}/staging/statement/v1/${"b".repeat(64)}`;

it("resumes bounded original-byte erasure and refuses a mismatched User without touching their bytes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      const { bucket: retainedBucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const current = yield* Clock.currentTimeMillis;
      const decision = deletionDecision({ userId, reference, current });
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(decision);
      yield* Effect.tryPromise(() =>
        db.batch([
          ...[userId, foreignUser].map((id) =>
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
              )
              .bind(id, current)
          ),
          ...[
            [userId, targetKey],
            [foreignUser, foreignKey],
          ].map(([id, key]) =>
            db
              .prepare(
                "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms) VALUES(?,?,?,10,?,'available',?,?)"
              )
              .bind(id, id, key, "a".repeat(64), current, current + 86400000)
          ),
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,?,'Sealing',?)"
            )
            .bind(reference, userId, current, encoded),
        ])
      );
      yield* Effect.tryPromise(() => bucket.put(targetKey, "Target bytes"));
      const orphanKeys = ["c", "d", "e", "f", "0"].map(
        (digit) => `users/${userId}/staging/statement/v1/${digit.repeat(64)}`
      );
      for (const key of orphanKeys) {
        yield* Effect.tryPromise(() => bucket.put(key, "Unindexed temporary bytes"));
      }
      yield* Effect.tryPromise(() => bucket.put(foreignKey, "Foreign bytes"));
      const retainedKey = `users/${userId}/held/${reference}/original`;
      const foreignRetainedKey = `users/${foreignUser}/held/${reference}/original`;
      const markerKey = `recovery/cases/${reference}`;
      yield* Effect.tryPromise(() => retainedBucket.put(retainedKey, "Old retained bytes"));
      yield* Effect.tryPromise(() =>
        retainedBucket.put(foreignRetainedKey, "Other User retained bytes")
      );
      yield* Effect.tryPromise(() => retainedBucket.put(markerKey, "Independent deletion marker"));
      let cleanupOnly = false;
      const cleanupBucket = new Proxy(bucket, {
        get(target, property): unknown {
          if (property === "put" && cleanupOnly) {
            return (): Promise<never> => Promise.reject(new Error("Object writes unavailable"));
          }
          return Reflect.get(target, property, target);
        },
      });
      const make = (): ReturnType<typeof makeErasureOriginals> =>
        makeErasureOriginals({
          db,
          email: Option.some(cleanupBucket),
          statement: Option.some(cleanupBucket),
          retained: Option.some(retainedBucket),
        });

      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE erasure_requests SET state='Erasing',marker_written=1,coordinator_cleared=1 WHERE id=?"
          )
          .bind(reference)
          .run()
      );
      cleanupOnly = true;
      const refused = yield* Effect.result(make().discard({ userId: foreignUser, reference }));
      expect(refused._tag).toBe("Failure");
      const admittedAt = yield* Clock.currentTimeMillis;
      expect(
        (yield* executeErasureContinuation({
          db,
          userId,
          stores: [],
          originals: make(),
          recovery: { db, bucket: Option.some(retainedBucket) },
          clearCoordinator: () => Effect.succeed(true),
          candidate: {
            userId,
            reference,
            deadlineMs: admittedAt + 5000,
            authority: {
              permission: "titular.erase",
              operatorRef: "fixture",
              expiresAtMs: admittedAt + 60000,
            },
          },
        })).status
      ).toBe(202);
      expect(
        (yield* Effect.tryPromise(() => bucket.list({ prefix: `users/${userId}/` }))).objects
      ).toHaveLength(2);
      let outcome: "Done" | "Continue" = "Continue";
      for (let remaining = 4; remaining > 0 && outcome === "Continue"; remaining -= 1) {
        outcome = yield* make().discard({ userId, reference });
      }
      expect(outcome).toBe("Done");
      expect(yield* Effect.tryPromise(() => bucket.head(targetKey))).toBeNull();
      expect(yield* Effect.tryPromise(() => retainedBucket.head(retainedKey))).toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          retainedBucket.get(foreignRetainedKey).then((body) => body?.text())
        )
      ).toBe("Other User retained bytes");
      expect(
        yield* Effect.tryPromise(() => retainedBucket.get(markerKey).then((body) => body?.text()))
      ).toBe("Independent deletion marker");
      for (const key of orphanKeys) {
        expect(yield* Effect.tryPromise(() => bucket.head(key))).toBeNull();
      }
      expect(
        yield* Effect.tryPromise(() => bucket.get(foreignKey).then((body) => body?.text()))
      ).toBe("Foreign bytes");
    })
  ));
