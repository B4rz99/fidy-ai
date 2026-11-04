import { observeErasureRecoveryDrain } from "./operations";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { afterAll, expect } from "vitest";
import { installRetentionTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { type RecoveryClosedSourceEvidence, RecoveryTarget } from "../recovery-activation/contract";
import { nativeImportedErasure } from "./imported.test-fixture";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sources = isolatedTestDatabases();
afterAll(() => sources.dispose());
const finalGeneration = "18500000-0000-4000-8000-000000000020";
it.effect(
  "advances only an inactive imported native target and retains the source generation",
  () =>
    Effect.gen(function* () {
      const source = yield* Effect.tryPromise(() => sources.acquire());
      const native = yield* nativeImportedErasure;
      yield* Effect.tryPromise(() => installRetentionTestSchema(source));
      yield* Effect.tryPromise(() => installRetentionTestSchema(native.db));
      const marker = yield* Effect.tryPromise(() =>
        native.bucket.put("recovery/generation", finalGeneration)
      );
      if (marker === null) return yield* Effect.die(Error("Fixture generation absent"));
      // Component evidence only; the production closed-source accessor remains unavailable.
      const evidence: RecoveryClosedSourceEvidence = {
        activationId: "18500000-0000-4000-8000-000000000021",
        admissionObjectId: "1".repeat(64),
        source: {
          kind: "D1",
          databaseId: "18500000-0000-4000-8000-000000000022",
          epoch: "source-epoch",
        },
        sourceGeneration: "initial",
        sourceFreeze: { kind: "NoSourceFreeze" as const },
        finalGeneration,
        finalCheckpointEtag: marker.etag,
        providerEvidenceDigest: "f".repeat(64),
        ledgerDigest: "76754952062edeaa4c3dfe85e9183518bf01f927ee1564d0868c52b35523eca5",
      };
      expect((yield* Effect.tryPromise(() => native.verify(evidence))).status).toBe(503);
      expect(yield* Effect.tryPromise(() => native.marker())).toEqual([{ generation: "initial" }]);
      expect((yield* Effect.tryPromise(() => native.prepare(evidence))).status).toBe(204);
      const actualTarget = yield* Schema.decodeUnknownEffect(RecoveryTarget)(
        yield* Effect.tryPromise(() => native.identity())
      );
      const sameTargetEvidence: RecoveryClosedSourceEvidence = {
        ...evidence,
        source: {
          ...actualTarget,
          kind: "SQLite",
          namespaceId: "asserted-other-namespace",
          epoch: "source-epoch",
        },
      };
      expect((yield* Effect.tryPromise(() => native.verify(sameTargetEvidence))).status).toBe(503);
      expect(yield* Effect.tryPromise(() => native.marker())).toEqual([{ generation: "initial" }]);
      const verified = yield* Effect.tryPromise(() => native.verify(evidence));
      expect(verified.status).toBe(200);
      expect(yield* Effect.tryPromise(() => verified.json())).toMatchObject({
        state: "Verified",
        providerIsolation: "Unqualified",
      });
      expect(yield* Effect.tryPromise(() => native.marker())).toEqual([
        { generation: finalGeneration },
      ]);
      expect(
        yield* Effect.tryPromise(() =>
          source
            .prepare("SELECT generation FROM erasure_control WHERE kind='published'")
            .first("generation")
        )
      ).toBe("initial");
      expect((yield* Effect.tryPromise(() => native.verify(evidence))).status).toBe(200);
    }).pipe(Effect.scoped)
);

it.effect("verifies retained sealed erasures without resetting independent custody claims", () =>
  Effect.gen(function* () {
    const native = yield* nativeImportedErasure;
    yield* Effect.tryPromise(() => installRetentionTestSchema(native.db));
    const reference = "18500000-0000-4000-8000-000000000031";
    const userId = "18500000-0000-4000-8000-000000000032";
    const eventId = "18500000-0000-4000-8000-000000000033";
    yield* Effect.tryPromise(() =>
      native.db.batch([
        native.db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,coordinator_cleared,marker_written) VALUES(?,?,0,'ExternalPending',1,1)"
          )
          .bind(reference, userId),
        native.db
          .prepare(
            "INSERT INTO erasure_steps(request_id,store_id,delete_done) VALUES(?,'identity',1)"
          )
          .bind(reference),
        native.db
          .prepare(
            "INSERT INTO erasure_custody_records(record_type,request_id,custodian,id,evidence_json,recorded_at_ms,operator_ref) VALUES('event',?,'Cloudflare',?,'{}',0,'retained-operator')"
          )
          .bind(reference, eventId),
        native.db
          .prepare(
            "INSERT INTO erasure_custody_records(record_type,request_id,custodian,state,current_event_id) VALUES('current',?,'Cloudflare','Verified',?)"
          )
          .bind(reference, eventId),
      ])
    );
    expect(yield* observeErasureRecoveryDrain({ db: native.db })).toEqual({
      pending: 0,
      externalPending: 1,
    });
    const generation = yield* Effect.tryPromise(() =>
      native.bucket.put("recovery/generation", finalGeneration)
    );
    if (generation === null) return yield* Effect.die(Error("Fixture generation absent"));
    const evidence: RecoveryClosedSourceEvidence = {
      activationId: "18500000-0000-4000-8000-000000000034",
      admissionObjectId: "1".repeat(64),
      source: {
        kind: "D1",
        databaseId: "18500000-0000-4000-8000-000000000035",
        epoch: "source-epoch",
      },
      sourceGeneration: "initial",
      sourceFreeze: { kind: "NoSourceFreeze" as const },
      finalGeneration,
      finalCheckpointEtag: generation.etag,
      providerEvidenceDigest: "f".repeat(64),
      ledgerDigest: "31b5b562c9c813c1271baac3825ae1966115f723c7ea2db4c1fb40b24b31d647",
    };
    const key = `recovery/cases/${reference}`;
    yield* Effect.tryPromise(() =>
      native.bucket.put(key, encode({ reference, userId, requestedAtMs: 0, sealed: false }))
    );
    expect((yield* Effect.tryPromise(() => native.prepare(evidence))).status).toBe(204);
    expect((yield* Effect.tryPromise(() => native.verify(evidence))).status).toBe(503);
    expect(yield* Effect.tryPromise(() => native.marker())).toEqual([{ generation: "initial" }]);
    yield* Effect.tryPromise(() =>
      native.bucket.put(key, encode({ reference, userId, requestedAtMs: 0, sealed: true }))
    );
    const verified = yield* Effect.tryPromise(() => native.verify(evidence));
    expect(verified.status).toBe(200);
    expect(yield* Effect.tryPromise(() => verified.json())).toMatchObject({
      state: "Verified",
      checkedCases: 1,
      providerIsolation: "Unqualified",
    });
    expect(yield* Effect.tryPromise(() => native.custody())).toEqual([
      { custodian: "Cloudflare", state: "Verified", current_event_id: eventId },
    ]);
    expect((yield* Effect.tryPromise(() => native.verify(evidence))).status).toBe(200);
    expect(yield* Effect.tryPromise(() => native.custody())).toEqual([
      { custodian: "Cloudflare", state: "Verified", current_event_id: eventId },
    ]);
  }).pipe(Effect.scoped)
);

it.effect(
  "resumes bounded native verification after the checkpoint write applies but its reply is lost",
  () =>
    Effect.gen(function* () {
      const native = yield* nativeImportedErasure;
      yield* Effect.tryPromise(() => installRetentionTestSchema(native.db));
      for (const index of [0, 1, 2, 3, 4]) {
        const reference = `18500000-0000-4000-8000-00000000004${index}`;
        const userId = `18500000-0000-4000-8000-00000000005${index}`;
        yield* Effect.tryPromise(() =>
          native.db.batch([
            native.db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,coordinator_cleared,marker_written,last_erased_at_ms) VALUES(?,?,0,'Complete',1,1,0)"
              )
              .bind(reference, userId),
            native.db
              .prepare(
                "INSERT INTO erasure_steps(request_id,store_id,delete_done) VALUES(?,'identity',1)"
              )
              .bind(reference),
          ])
        );
        yield* Effect.tryPromise(() =>
          native.bucket.put(
            `recovery/cases/${reference}`,
            encode({ reference, userId, requestedAtMs: 0, sealed: true })
          )
        );
      }
      const generation = yield* Effect.tryPromise(() =>
        native.bucket.put("recovery/generation", finalGeneration)
      );
      if (generation === null) return yield* Effect.die(Error("Fixture generation absent"));
      const evidence: RecoveryClosedSourceEvidence = {
        activationId: "18500000-0000-4000-8000-000000000060",
        admissionObjectId: "1".repeat(64),
        source: {
          kind: "D1",
          databaseId: "18500000-0000-4000-8000-000000000061",
          epoch: "source-epoch",
        },
        sourceGeneration: "initial",
        sourceFreeze: { kind: "NoSourceFreeze" as const },
        finalGeneration,
        finalCheckpointEtag: generation.etag,
        providerEvidenceDigest: "f".repeat(64),
        ledgerDigest: "c1d7d90cc7838076cececb857c5cf1326b7dacad3ad227dd4ca49abfc1cac651",
      };
      expect((yield* Effect.tryPromise(() => native.prepare(evidence))).status).toBe(204);
      expect((yield* Effect.tryPromise(() => native.interrupt(evidence))).status).toBe(503);
      expect(yield* Effect.tryPromise(() => native.marker())).toEqual([{ generation: "initial" }]);
      const stored = yield* Effect.tryPromise(() =>
        native.bucket.list({ prefix: "recovery/imported-erasure/" })
      );
      expect(stored.objects).toHaveLength(1);
      const resumed = yield* Effect.tryPromise(() => native.verify(evidence));
      expect(resumed.status).toBe(200);
      expect(yield* Effect.tryPromise(() => resumed.json())).toMatchObject({
        state: "Verified",
        checkedCases: 5,
        providerIsolation: "Unqualified",
      });
      expect(yield* Effect.tryPromise(() => native.marker())).toEqual([
        { generation: finalGeneration },
      ]);
      const fresh = yield* Effect.tryPromise(() => native.verify(evidence));
      expect(fresh.status).toBe(200);
      expect(yield* Effect.tryPromise(() => fresh.json())).toMatchObject({
        state: "Verifying",
        checkedCases: 4,
        providerIsolation: "Unqualified",
      });
    }).pipe(Effect.scoped)
);

it.effect(
  "refuses missing ledger coverage, pending disposition, surviving User data and unresolved writers",
  () =>
    Effect.gen(function* () {
      for (const fault of [
        "MissingLedger",
        "PendingCase",
        "LiveUser",
        "Writer",
        "WrongUser",
      ] as const) {
        yield* Effect.gen(function* () {
          const native = yield* nativeImportedErasure;
          yield* Effect.tryPromise(() => installRetentionTestSchema(native.db));
          const reference = "18500000-0000-4000-8000-000000000031";
          const userId = "18500000-0000-4000-8000-000000000032";
          if (fault === "LiveUser") {
            yield* Effect.tryPromise(() =>
              native.db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0)"
                )
                .bind(userId)
                .run()
            );
          }
          if (fault === "Writer") {
            yield* Effect.tryPromise(() =>
              native.db
                .prepare(
                  "INSERT INTO erasure_writers(id,user_id,bucket,object_key,started_at_ms) VALUES('unknown-writer',?,'email','retained-original',0)"
                )
                .bind(userId)
                .run()
            );
          }
          yield* Effect.tryPromise(() =>
            native.db.batch([
              native.db
                .prepare(
                  "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,coordinator_cleared,marker_written) VALUES(?,?,0,?,1,1)"
                )
                .bind(
                  reference,
                  fault === "WrongUser" ? "18500000-0000-4000-8000-000000000099" : userId,
                  fault === "PendingCase" ? "Sealing" : "ExternalPending"
                ),
              native.db
                .prepare(
                  "INSERT INTO erasure_steps(request_id,store_id,delete_done) VALUES(?,'identity',1)"
                )
                .bind(reference),
            ])
          );
          if (fault !== "MissingLedger") {
            yield* Effect.tryPromise(() =>
              native.bucket.put(
                `recovery/cases/${reference}`,
                encode({ reference, userId, requestedAtMs: 0, sealed: true })
              )
            );
          }
          const generation = yield* Effect.tryPromise(() =>
            native.bucket.put("recovery/generation", finalGeneration)
          );
          if (generation === null) return yield* Effect.die(Error("Fixture generation absent"));
          const evidence: RecoveryClosedSourceEvidence = {
            activationId: "18500000-0000-4000-8000-000000000070",
            admissionObjectId: "1".repeat(64),
            source: {
              kind: "D1",
              databaseId: "18500000-0000-4000-8000-000000000071",
              epoch: "source-epoch",
            },
            sourceGeneration: "initial",
            sourceFreeze: { kind: "NoSourceFreeze" as const },
            finalGeneration,
            finalCheckpointEtag: generation.etag,
            providerEvidenceDigest: "f".repeat(64),
            ledgerDigest:
              fault === "MissingLedger"
                ? "76754952062edeaa4c3dfe85e9183518bf01f927ee1564d0868c52b35523eca5"
                : "31b5b562c9c813c1271baac3825ae1966115f723c7ea2db4c1fb40b24b31d647",
          };
          expect((yield* Effect.tryPromise(() => native.prepare(evidence))).status).toBe(204);
          expect((yield* Effect.tryPromise(() => native.verify(evidence))).status).toBe(503);
          expect(yield* Effect.tryPromise(() => native.marker())).toEqual([
            { generation: "initial" },
          ]);
        }).pipe(Effect.scoped);
      }
    })
);
