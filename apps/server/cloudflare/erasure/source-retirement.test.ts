import { it as effectIt } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { expect } from "vitest";
import { installRetentionTestSchema } from "../d1-test-fixture";
import { prepareOriginalWrite, trackOriginalWrite } from "../erasure-store/operations";
import { observeRecoveryDrain } from "../recovery-lifecycle/operations";
import { nativeErasurePlatform } from "./native.test-fixture";
import { readErasureSourceGeneration, retireErasureSource } from "./operations";

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
        yield* trackOriginalWrite({
          ...original,
          work: Effect.tryPromise(() =>
            native.originals.put(original.objectKey, "synthetic original")
          ),
        });
        yield* retireErasureSource({ db: native.db, fence: { from: "initial", retired } });
        expect(yield* readErasureSourceGeneration({ db: native.db })).toBe(retired);
      }).pipe(Effect.scoped)
  );
});
