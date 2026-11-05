import { it as effectIt } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Option, Schema } from "effect";
import { expect } from "vitest";
import { installRetentionTestSchema } from "../d1-test-fixture";
import { prepareOriginalWrite, trackOriginalWrite } from "../erasure-store/operations";
import { observeRecoveryDrain } from "../recovery-lifecycle/operations";
import { ErasureSourceSchemaObject } from "./contract";
import { nativeErasurePlatform } from "./native.test-fixture";
import {
  classifyErasureSourceSchemaObject,
  readErasureSourceGeneration,
  retireErasureSource,
} from "./operations";

const userId = "18500000-0000-4000-8000-000000000071";
const retired = "18500000-0000-4000-8000-000000000072";
effectIt.layer(NodeFileSystem.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "rejects source retirement when an original writer appears after the owner drain observation",
    () =>
      Effect.gen(function* () {
        const platform = yield* nativeErasurePlatform;
        const native = yield* Effect.tryPromise(() => platform.acquire());
        yield* Effect.tryPromise(() => installRetentionTestSchema(native.db));
        yield* Effect.tryPromise(() =>
          native.db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(userId)
            .run()
        );
        expect((yield* observeRecoveryDrain({ db: native.db })).owners.privateObjects.pending).toBe(
          0
        );
        const original = {
          db: native.db,
          userId,
          reference: "late-native-writer",
          bucket: "email" as const,
          objectKey: `users/${userId}/originals/synthetic`,
        };
        yield* Effect.tryPromise(() =>
          native.db.batch([...prepareOriginalWrite({ ...original, current: 0 })])
        );
        expect(
          yield* retireErasureSource({ db: native.db, fence: { from: "initial", retired } }).pipe(
            Effect.match({ onFailure: () => false, onSuccess: () => true })
          )
        ).toBe(false);
        expect(yield* readErasureSourceGeneration({ db: native.db })).toBe("initial");
        expect((yield* observeRecoveryDrain({ db: native.db })).owners.privateObjects.pending).toBe(
          1
        );
        const capturedRawWrites = [
          native.db
            .prepare("UPDATE users SET created_at_ms=created_at_ms+1 WHERE id=?")
            .bind(userId),
          native.db.prepare(
            "UPDATE erasure_control SET generation='initial' WHERE kind='published'"
          ),
          native.db.prepare("DELETE FROM users WHERE id=?").bind(userId),
          native.db.prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES('18500000-0000-4000-8000-000000000073','CO','es-CO','America/Bogota',0)"
          ),
        ];
        yield* trackOriginalWrite({
          ...original,
          work: Effect.tryPromise(() =>
            native.originals.put(original.objectKey, "synthetic original")
          ),
        });
        const freeze = yield* retireErasureSource({
          db: native.db,
          fence: { from: "initial", retired },
        });
        const rawObjects = yield* Effect.tryPromise(() =>
          native.db
            .prepare(
              "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name"
            )
            .all()
        );
        const objects = yield* Schema.decodeUnknownEffect(Schema.Array(ErasureSourceSchemaObject))(
          rawObjects.results
        );
        const classifications = yield* Effect.forEach(objects, (object) =>
          classifyErasureSourceSchemaObject({
            db: native.db,
            generation: retired,
            freeze: Option.some(freeze),
            object,
          })
        );
        const own = objects.find((_, index) => classifications[index] === "SourceControl");
        if (own === undefined) {
          return yield* Effect.die(Error("Source freeze missing from native catalog"));
        }
        expect(classifications).toContain("Application");
        expect(
          yield* classifyErasureSourceSchemaObject({
            db: native.db,
            generation: retired,
            freeze: Option.some(freeze),
            object: { ...own, sql: own.sql + " " },
          }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
        ).toBe(false);
        expect(
          yield* classifyErasureSourceSchemaObject({
            db: native.db,
            generation: retired,
            freeze: Option.none(),
            object: own,
          }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
        ).toBe(false);
        expect(yield* readErasureSourceGeneration({ db: native.db })).toBe(retired);
        for (const statement of capturedRawWrites) {
          expect(
            yield* Effect.tryPromise(() => statement.run()).pipe(
              Effect.match({ onFailure: () => false, onSuccess: () => true })
            )
          ).toBe(false);
        }
        expect(yield* readErasureSourceGeneration({ db: native.db })).toBe(retired);
        expect(
          yield* Effect.tryPromise(() =>
            native.db
              .prepare("SELECT created_at_ms FROM users WHERE id=?")
              .bind(userId)
              .first("created_at_ms")
          )
        ).toBe(0);
      }).pipe(Effect.scoped)
  );
});
