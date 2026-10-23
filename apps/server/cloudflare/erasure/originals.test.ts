import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Option, Schema } from "effect";
import { installRetentionTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { makeIngestionErasureOriginals } from "../ingestion/runtime";
import { deletionDecision } from "./erasure.test-fixture";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const userId = "12740000-0000-4000-8000-000000000001";
const foreignUser = "12740000-0000-4000-8000-000000000099";
const reference = "12740000-0000-4000-8000-000000000002";
const targetKey = `users/${userId}/staging/statement/v1/${"a".repeat(64)}`;
const foreignKey = `users/${foreignUser}/staging/statement/v1/${"b".repeat(64)}`;

it("resumes original-byte erasure after capture and refuses a mismatched User without touching their bytes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
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
      let cleanupOnly = false;
      const cleanupBucket = new Proxy(bucket, {
        get(target, property): unknown {
          if (property === "put" && cleanupOnly) {
            return (): Promise<never> => Promise.reject(new Error("Object writes unavailable"));
          }
          return Reflect.get(target, property, target);
        },
      });
      const make = (): ReturnType<typeof makeIngestionErasureOriginals> =>
        makeIngestionErasureOriginals({
          db,
          email: Option.some(cleanupBucket),
          statement: Option.some(cleanupBucket),
          retained: Option.some(cleanupBucket),
        });
      expect(yield* make().capture({ userId, reference })).toBe(true);
      expect(yield* make().checkpoint({ userId, reference })).toBe(false);
      expect(yield* make().checkpoint({ userId, reference })).toBe(true);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE erasure_requests SET state='Erasing',marker_written=1 WHERE id=?")
          .bind(reference)
          .run()
      );
      cleanupOnly = true;
      const refused = yield* Effect.result(make().discard({ userId: foreignUser, reference }));
      expect(refused._tag).toBe("Failure");
      expect(yield* make().discard({ userId, reference })).toBe("Continue");
      expect(
        (yield* Effect.tryPromise(() => bucket.list({ prefix: `users/${userId}/` }))).objects
      ).toHaveLength(2);
      let outcome: "Done" | "Continue" | "Retained" = "Continue";
      for (let remaining = 4; remaining > 0 && outcome === "Continue"; remaining -= 1) {
        outcome = yield* make().discard({ userId, reference });
      }
      expect(outcome).toBe("Done");
      expect(yield* Effect.tryPromise(() => bucket.head(targetKey))).toBeNull();
      for (const key of orphanKeys) {
        expect(yield* Effect.tryPromise(() => bucket.head(key))).toBeNull();
      }
      expect(
        yield* Effect.tryPromise(() => bucket.get(foreignKey).then((body) => body?.text()))
      ).toBe("Foreign bytes");
    })
  ));

it("keeps a reviewed original outside ordinary storage, retries a failed native D1 checkpoint, and purges it at its approved expiry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const current = yield* Clock.currentTimeMillis;
      const base = deletionDecision({ userId, reference, current });
      const until = current + 1000;
      const decision = {
        ...base,
        dispositions: {
          ...base.dispositions,
          ingestion: {
            action: "Retain" as const,
            retention: { ...base.receiptRetention, untilMs: until, reviewAtMs: current + 500 },
          },
        },
      };
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(decision);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',?)"
            )
            .bind(userId, current),
          db
            .prepare(
              "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms) VALUES(?,?,?,4,?,'available',?,?)"
            )
            .bind(userId, userId, targetKey, "a".repeat(64), current, current + 86400000),
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json,marker_written) VALUES(?,?,?,'Sealing',?,1)"
            )
            .bind(reference, userId, current, encoded),
        ])
      );
      yield* Effect.tryPromise(() =>
        bucket.put(targetKey, "Held", { customMetadata: { purpose: "statement-original" } })
      );
      const make = (): ReturnType<typeof makeIngestionErasureOriginals> =>
        makeIngestionErasureOriginals({
          db,
          email: Option.some(bucket),
          statement: Option.some(bucket),
          retained: Option.some(bucket),
        });
      expect(yield* make().capture({ userId, reference })).toBe(true);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE erasure_requests SET state='Archiving' WHERE id=?").bind(reference).run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER reject_held_checkpoint BEFORE UPDATE OF retained_key ON erasure_objects BEGIN SELECT RAISE(ABORT,'synthetic_checkpoint_failure'); END"
          )
          .run()
      );
      expect((yield* Effect.result(make().archive({ userId, reference })))._tag).toBe("Failure");
      const heldKey = `users/${userId}/held/${reference}/statement/${"a".repeat(64)}`;
      expect(
        yield* Effect.tryPromise(() => bucket.get(heldKey).then((object) => object?.text()))
      ).toBe("Held");
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER reject_held_checkpoint").run());
      expect(yield* make().archive({ userId, reference })).toBe(false);
      expect(yield* make().archive({ userId, reference })).toBe(true);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(reference).run()
      );
      expect(yield* make().discard({ userId, reference })).toBe("Continue");
      expect(yield* Effect.tryPromise(() => bucket.head(targetKey))).toBeNull();
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE erasure_requests SET state='ExternalPending' WHERE id=?")
          .bind(reference)
          .run()
      );
      expect(yield* make().purge({ userId, reference })).toBe(false);
      yield* Effect.sleep("1100 millis");
      expect(yield* make().purge({ userId, reference })).toBe(false);
      expect(yield* make().purge({ userId, reference })).toBe(true);
      expect(yield* Effect.tryPromise(() => bucket.head(heldKey))).toBeNull();
    })
  ));
