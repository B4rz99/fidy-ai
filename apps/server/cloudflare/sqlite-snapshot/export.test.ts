import { it } from "@effect/vitest";
import { type Cause, Effect, Exit, Option, Schema } from "effect";
import { afterAll, expect } from "vitest";
import { installTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { readClosedRecoverySource } from "../recovery-activation/operations";
import { nativeRecoveryAdmission } from "../recovery-activation/native.test-fixture";
import {
  RecoveryAdmissionState,
  type RecoveryClosedSourceAccess,
} from "../recovery-activation/contract";
import { ErasureUnavailable } from "../erasure-store/contract";
import {
  advanceClosedSnapshot,
  exportClosedSnapshotTable,
  readSnapshotArtifact,
  retireSnapshotArtifacts,
} from "./operations";
import { SnapshotTablePage } from "./contract";

const platform = isolatedTestStorage();
afterAll(() => platform.dispose());
const source = {
  kind: "D1" as const,
  databaseId: "18460000-0000-4000-8000-000000000001",
  epoch: "source-epoch",
};
const activationId = "18460000-0000-4000-8000-000000000002";
const target = {
  namespaceId: "candidate-native",
  objectId: "candidate-object",
  manifest: "candidate-artifact",
  epoch: "candidate-epoch",
};
const io = <A>(run: () => Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(run);

it.live(
  "refuses snapshot export before closed-source authority without reading a live database",
  () =>
    Effect.gen(function* () {
      const native = yield* io(() => platform.acquire());
      const result = yield* Effect.exit(
        exportClosedSnapshotTable({
          ...native,
          artifacts: native.bucket,
          source,
          target,
          activationId,
          table: "users",
          afterRowid: Option.none(),
          closedSource: readClosedRecoverySource,
        })
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* io(() => native.bucket.list())).toMatchObject({ objects: [] });
    })
);

it.live(
  "exports exact retained Audit sequence and schema from a closed native D1 source into an immutable bounded page",
  () =>
    Effect.gen(function* () {
      const native = yield* io(() => platform.acquire());
      yield* io(() => installTestSchema({ db: native.db }));
      yield* io(() =>
        native.db.batch([
          native.db.prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES ('10000000-0000-4000-8000-000000000001','CO','es-CO','America/Bogota',0)"
          ),
          native.db.prepare(
            "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES (CAST('9007199254740993' AS INTEGER),'session_call','18460000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','retained-session','dashboard.getDashboardView','accepted',1)"
          ),
        ])
      );
      const gate = yield* nativeRecoveryAdmission;
      const state = yield* Schema.decodeUnknownEffect(RecoveryAdmissionState)(
        yield* io(() => gate.close({ epoch: source.epoch, activationId }))
      );
      const configuration = {
        ...native,
        artifacts: native.bucket,
        source,
        target,
        activationId,
        table: "audit_entries",
        afterRowid: Option.none<string>(),
        closedSource: (): ReturnType<RecoveryClosedSourceAccess> =>
          Effect.succeed({
            activationId,
            source,
            admissionObjectId: state.objectId,
            sourceGeneration: "initial" as const,
            finalGeneration: "18460000-0000-4000-8000-000000000004",
            finalCheckpointEtag: "native-checkpoint",
            providerEvidenceDigest: "0".repeat(64),
            ledgerDigest: "1".repeat(64),
          }),
      };
      const result = yield* exportClosedSnapshotTable(configuration);
      expect(result.rowid).toEqual(Option.some("9007199254740993"));
      const stored = yield* io(() => native.bucket.get(result.key));
      if (stored === null) return yield* Effect.die(new Error("Missing native artifact"));
      const page = yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotTablePage))(
        yield* io(() => stored.text())
      );
      expect(page.table.sql).toContain("GENERATED ALWAYS");
      expect(page.table.columns).not.toContain("credential_session_id");
      expect(page.row).toMatchObject({ kind: "row", rowid: "9007199254740993" });
      if (page.row.kind === "row") {
        expect(page.row.cells[0]).toEqual({ kind: "integer", value: "9007199254740993" });
      }
      expect(yield* exportClosedSnapshotTable(configuration)).toEqual(result);
    }).pipe(Effect.scoped)
);

const closedSnapshot = Effect.fnUntraced(function* (seed: (db: D1Database) => Promise<unknown>) {
  const native = yield* io(() => platform.acquire());
  yield* io(() => installTestSchema({ db: native.db }));
  yield* io(() => seed(native.db));
  const gate = yield* nativeRecoveryAdmission;
  const closed = yield* Schema.decodeUnknownEffect(RecoveryAdmissionState)(
    yield* io(() => gate.close({ epoch: source.epoch, activationId }))
  );
  // Local data-copy evidence exercises the native barrier; it never authorizes serving or qualifies provider isolation.
  const closedSource: RecoveryClosedSourceAccess = () =>
    Effect.gen(function* () {
      const state = yield* Schema.decodeUnknownEffect(RecoveryAdmissionState)(
        yield* io(() => gate.inspect())
      );
      if (
        !state.closed ||
        state.leases !== 0 ||
        state.activationId !== activationId ||
        state.objectId !== closed.objectId
      ) {
        return yield* new ErasureUnavailable();
      }
      return {
        activationId,
        source,
        admissionObjectId: state.objectId,
        sourceGeneration: "initial" as const,
        finalGeneration: "18460000-0000-4000-8000-000000000004",
        finalCheckpointEtag: "native-checkpoint",
        providerEvidenceDigest: "0".repeat(64),
        ledgerDigest: "1".repeat(64),
      };
    }).pipe(Effect.mapError(() => new ErasureUnavailable()));
  return { ...native, artifacts: native.bucket, source, target, activationId, closedSource };
});
const loadPage = Effect.fnUntraced(function* (bucket: R2Bucket, key: string) {
  const object = yield* io(() => bucket.get(key));
  if (object === null) return yield* Effect.die(new Error("Missing native snapshot page"));
  return yield* Schema.decodeEffect(Schema.fromJsonString(SnapshotTablePage))(
    yield* io(() => object.text())
  );
});
it.live(
  "copies full Money text and native credential blobs with rowid continuation through the production schema",
  () =>
    Effect.gen(function* () {
      const digest = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
      const fixture = yield* closedSnapshot((db) =>
        db.batch([
          db.prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES ('10000000-0000-4000-8000-000000000001','CO','es-CO','America/Bogota',0)"
          ),
          db.prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES ('60000000-0000-4000-8000-000000000001','BCDF-GHJK',X'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f','10000000-0000-4000-8000-000000000001','consumed',0,600000)"
          ),
          db.prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES ('60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',X'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',0,600000,3600000,7776000000)"
          ),
          db.prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','123456789012345678901234567890.01','COP','outflow',(SELECT id FROM categories LIMIT 1),0,0)"
          ),
        ])
      );
      const first = yield* exportClosedSnapshotTable({
        ...fixture,
        table: "web_sessions",
        afterRowid: Option.none(),
      });
      const page = yield* loadPage(fixture.bucket, first.key);
      expect(page.row.kind).toBe("row");
      if (page.row.kind === "row") {
        expect(page.row.cells[page.table.columns.indexOf("token_digest")]).toEqual({
          kind: "blob",
          value: digest,
        });
      }
      const next = yield* exportClosedSnapshotTable({
        ...fixture,
        table: "web_sessions",
        afterRowid: first.rowid,
      });
      expect((yield* loadPage(fixture.bucket, next.key)).row).toEqual({ kind: "end" });
      const money = yield* exportClosedSnapshotTable({
        ...fixture,
        table: "transactions",
        afterRowid: Option.none(),
      });
      const financial = yield* loadPage(fixture.bucket, money.key);
      if (financial.row.kind === "row") {
        expect(financial.row.cells[financial.table.columns.indexOf("amount")]).toEqual({
          kind: "text",
          value: "123456789012345678901234567890.01",
        });
      }
    }).pipe(Effect.scoped)
);

it.live(
  "rejects an invalid rowid checkpoint without truncating or silently skipping native rows",
  () =>
    Effect.gen(function* () {
      const fixture = yield* closedSnapshot((db) =>
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES ('10000000-0000-4000-8000-000000000001','CO','es-CO','America/Bogota',0)"
          )
          .run()
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            exportClosedSnapshotTable({
              ...fixture,
              table: "users",
              afterRowid: Option.some("9007199254740993truncated"),
            })
          )
        )
      ).toBe(true);
      expect(yield* io(() => fixture.bucket.list())).toMatchObject({ objects: [] });
    }).pipe(Effect.scoped)
);

it.live(
  "refuses page publication if the independent final checkpoint changes during source reads",
  () =>
    Effect.gen(function* () {
      const fixture = yield* closedSnapshot((db) =>
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES ('10000000-0000-4000-8000-000000000001','CO','es-CO','America/Bogota',0)"
          )
          .run()
      );
      let observations = 0;
      const closedSource: RecoveryClosedSourceAccess = (expected) =>
        fixture
          .closedSource(expected)
          .pipe(
            Effect.map((evidence) =>
              ++observations === 1
                ? evidence
                : { ...evidence, finalCheckpointEtag: "changed-final-checkpoint" }
            )
          );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            exportClosedSnapshotTable({
              ...fixture,
              closedSource,
              table: "users",
              afterRowid: Option.none(),
            })
          )
        )
      ).toBe(true);
      expect(yield* io(() => fixture.bucket.list())).toMatchObject({ objects: [] });
    }).pipe(Effect.scoped)
);

it.live(
  "resumes bounded full-schema export into a sealed manifest without dropping financial rows or native schema objects",
  () =>
    Effect.gen(function* () {
      const fixture = yield* closedSnapshot((db) =>
        db.batch([
          db.prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES ('10000000-0000-4000-8000-000000000001','CO','es-CO','America/Bogota',0)"
          ),
          db.prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','123456789012345678901234567890.01','COP','outflow',(SELECT id FROM categories LIMIT 1),0,0)"
          ),
        ])
      );
      let artifactDigest = Option.none<string>();
      for (let step = 0; step < 2000; step++) {
        const result = yield* advanceClosedSnapshot(fixture);
        if (result.kind === "Ready") {
          artifactDigest = Option.some(result.artifactDigest);
          break;
        }
      }
      const digest = Option.getOrThrow(artifactDigest);
      const manifest = yield* readSnapshotArtifact({
        artifacts: fixture.artifacts,
        target,
        activationId,
        digest,
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            readSnapshotArtifact({
              artifacts: fixture.artifacts,
              activationId,
              target: { ...target, epoch: "another-candidate" },
              digest,
            })
          )
        )
      ).toBe(true);
      expect(manifest.kind).toBe("manifest");
      if (manifest.kind !== "manifest") return yield* Effect.die(new Error("Missing manifest"));
      expect(manifest.schemaObjects).toBeGreaterThan(100);
      expect(manifest.rows).toBeGreaterThan(2);
      let head = manifest.dataHead;
      let found = false;
      while (Option.isSome(head)) {
        const page = yield* readSnapshotArtifact({
          artifacts: fixture.artifacts,
          target,
          activationId,
          digest: head.value,
        });
        if (page.kind !== "data") return yield* Effect.die(new Error("Invalid data chain"));
        if (page.table === "transactions") {
          expect(page.cells).toContainEqual({
            kind: "text",
            value: "123456789012345678901234567890.01",
          });
          found = true;
        }
        head = page.previous;
      }
      expect(found).toBe(true);
      expect(yield* advanceClosedSnapshot(fixture)).toMatchObject({
        kind: "Ready",
        artifactDigest: digest,
      });
    }).pipe(Effect.scoped),
  { timeout: 60000 }
);

it.live("resumes an applied snapshot checkpoint after its storage reply is lost", () =>
  Effect.gen(function* () {
    const fixture = yield* closedSnapshot((db) => db.prepare("SELECT 1").run());
    let interrupted = false;
    const artifacts = new Proxy(fixture.artifacts, {
      get: (bucket, property): unknown =>
        property === "put"
          ? (key: string, value: string, options: R2PutOptions): ReturnType<R2Bucket["put"]> =>
              bucket.put(key, value, options).then((stored) => {
                if (!interrupted && key.includes("/jobs/")) {
                  interrupted = true;
                  throw new Error("Applied checkpoint reply lost");
                }
                return stored;
              })
          : Reflect.get(bucket, property, bucket),
    });
    expect(
      Exit.isFailure(yield* Effect.exit(advanceClosedSnapshot({ ...fixture, artifacts })))
    ).toBe(true);
    expect(interrupted).toBe(true);
    expect(yield* advanceClosedSnapshot(fixture)).toMatchObject({
      kind: "Continue",
      schemaObjects: 1,
    });
    expect(yield* advanceClosedSnapshot(fixture)).toMatchObject({
      kind: "Continue",
      schemaObjects: 2,
    });
  }).pipe(Effect.scoped)
);

it.live(
  "refuses artifact retirement without independently earned disposition and preserves the private snapshot objects",
  () =>
    Effect.gen(function* () {
      const native = yield* io(() => platform.acquire());
      const keys = [
        `recovery/sqlite-snapshots/pages/${activationId}/retained`,
        `recovery/sqlite-snapshots/objects/${activationId}/retained`,
        `recovery/sqlite-snapshots/jobs/${activationId}/retained`,
        "outside-retirement-scope",
      ];
      for (const key of keys) yield* io(() => native.bucket.put(key, "retained"));
      const result = yield* Effect.exit(
        retireSnapshotArtifacts({
          artifacts: native.bucket,
          activationId,
          target,
          artifactDigest: "f".repeat(64),
        })
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(
        (yield* io(() => native.bucket.list())).objects.map((object) => object.key).sort()
      ).toEqual(keys.toSorted());
    })
);
