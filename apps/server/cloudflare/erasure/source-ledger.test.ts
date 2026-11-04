import { it as effectIt } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { type Cause, Effect, Option, Schema } from "effect";
import { expect } from "vitest";
import { installRetentionTestSchema } from "../d1-test-fixture";
import { ErasureFrozenLedgerProgress } from "./contract";
import { nativeErasurePlatform } from "./native.test-fixture";
import {
  observeFrozenErasureLedger,
  readErasureSourceGeneration,
  retireErasureSource,
} from "./operations";

const retired = "18500000-0000-4000-8000-000000000081";
const reference = (index: number): string =>
  `18500000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const caseBody = (index: number, sealed: boolean): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    reference: reference(index),
    userId: reference(index + 10),
    requestedAtMs: 0,
    sealed,
  });
const seed = (db: D1Database, index: number): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,coordinator_cleared,marker_written) VALUES(?,?,0,'ExternalPending',1,1)"
        )
        .bind(reference(index), reference(index + 10)),
      db
        .prepare(
          "INSERT INTO erasure_steps(request_id,store_id,delete_done) VALUES(?,'identity',1)"
        )
        .bind(reference(index)),
    ])
  ).pipe(Effect.asVoid);
effectIt.layer(NodeFileSystem.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "resumes read-only source ledger coverage from R2 and refuses missing and late pending cases",
    () =>
      Effect.gen(function* () {
        const platform = yield* nativeErasurePlatform;
        const native = yield* Effect.tryPromise(() => platform.acquire());
        yield* Effect.tryPromise(() => installRetentionTestSchema(native.db));
        for (const index of [1, 2, 3, 4, 5, 6]) {
          yield* seed(native.db, index);
          if (index === 6) continue;
          const body = yield* caseBody(index, true);
          yield* Effect.tryPromise(() =>
            native.registry.put(`recovery/cases/${reference(index)}`, body)
          );
        }
        yield* retireErasureSource({ db: native.db, fence: { from: "initial", retired } });
        const input = { db: native.db, bucket: native.registry, generation: retired };
        const first = yield* observeFrozenErasureLedger({ ...input, previous: Option.none() });
        expect(first).toMatchObject({
          state: "Observing",
          checkedCases: 4,
          providerIsolation: "Unqualified",
        });
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(ErasureFrozenLedgerProgress)
        )(first);
        yield* Effect.tryPromise(() => native.registry.put("recovery/source-ledger-test", encoded));
        const stored = yield* Effect.tryPromise(() =>
          native.registry.get("recovery/source-ledger-test")
        );
        if (stored === null) return yield* Effect.die(Error("Missing external ledger progress"));
        const previous = yield* Schema.decodeEffect(
          Schema.fromJsonString(ErasureFrozenLedgerProgress)
        )(yield* Effect.tryPromise(() => stored.text()));
        const covering = yield* observeFrozenErasureLedger({
          ...input,
          previous: Option.some(previous),
        });
        expect(covering).toMatchObject({
          phase: "Requests",
          checkedCases: 5,
          checkedRequests: 4,
          state: "Observing",
          digest: "8e704e7fb0f8d6d4e34354bd243c6d672b12d53df066ed377a3c41b1766773ed",
        });
        expect(
          yield* observeFrozenErasureLedger({ ...input, previous: Option.some(covering) }).pipe(
            Effect.match({ onFailure: () => false, onSuccess: () => true })
          )
        ).toBe(false);
        const pending = yield* caseBody(6, false);
        yield* Effect.tryPromise(() =>
          native.registry.put(`recovery/cases/${reference(6)}`, pending)
        );
        const repeat = yield* observeFrozenErasureLedger({ ...input, previous: Option.none() });
        expect(
          yield* observeFrozenErasureLedger({ ...input, previous: Option.some(repeat) }).pipe(
            Effect.match({ onFailure: () => false, onSuccess: () => true })
          )
        ).toBe(false);
        const sealed = yield* caseBody(6, true);
        yield* Effect.tryPromise(() =>
          native.registry.put(`recovery/cases/${reference(6)}`, sealed)
        );
        const repaired = yield* observeFrozenErasureLedger({ ...input, previous: Option.none() });
        const repairedCoverage = yield* observeFrozenErasureLedger({
          ...input,
          previous: Option.some(repaired),
        });
        const observed = yield* observeFrozenErasureLedger({
          ...input,
          previous: Option.some(repairedCoverage),
        });
        expect(observed).toMatchObject({
          state: "Observed",
          checkedCases: 6,
          checkedRequests: 6,
          digest: "f4d3acb359cbbf92a69fb42790a98d4777e385513984146cc01117e560234ae2",
          providerIsolation: "Unqualified",
        });
        const latePending = yield* caseBody(7, false);
        yield* Effect.tryPromise(() =>
          native.registry.put(`recovery/cases/${reference(7)}`, latePending)
        );
        const rescanned = yield* observeFrozenErasureLedger({
          ...input,
          previous: Option.some(observed),
        });
        expect(
          yield* observeFrozenErasureLedger({ ...input, previous: Option.some(rescanned) }).pipe(
            Effect.match({ onFailure: () => false, onSuccess: () => true })
          )
        ).toBe(false);
        expect(yield* readErasureSourceGeneration({ db: native.db })).toBe(retired);
      }).pipe(Effect.scoped)
  );
});
