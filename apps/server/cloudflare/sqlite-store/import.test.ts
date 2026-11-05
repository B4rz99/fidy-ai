import { it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { expect } from "vitest";
import { readErasureSourceGeneration, retireErasureSource } from "../erasure/operations";
import { installTestSchema } from "../d1-test-fixture";
import { type RecoveryClosedSourceEvidence, RecoveryTarget } from "../recovery-activation/contract";
import { advanceClosedSnapshot } from "../sqlite-snapshot/operations";
import { nativeSqliteImport } from "./import.test-fixture";

const io = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);
it.live(
  "imports the production schema and exact frozen values into a closed native target before separate FK finalization",
  () =>
    Effect.gen(function* () {
      const native = yield* nativeSqliteImport;
      yield* io(() => installTestSchema({ db: native.db }));
      yield* io(() =>
        native.db.batch([
          native.db.prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES ('10000000-0000-4000-8000-000000000001','CO','es-CO','America/Bogota',0)"
          ),
          native.db.prepare(
            "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES (CAST('9007199254740993' AS INTEGER),'session_call','18460000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','retained-session','dashboard.getDashboardView','accepted',1)"
          ),
          native.db.prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES ('60000000-0000-4000-8000-000000000001','BCDF-GHJK',X'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f','10000000-0000-4000-8000-000000000001','consumed',0,600000)"
          ),
          native.db.prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES ('60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',X'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',0,600000,3600000,7776000000)"
          ),
          native.db.prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','123456789012345678901234567890.01','COP','outflow',(SELECT id FROM categories LIMIT 1),0,0)"
          ),
        ])
      );
      const domainGuards = yield* io(() =>
        native.db
          .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='trigger'")
          .first<{ count: number }>()
      );
      const retired = "18460000-0000-4000-8000-000000000005";
      const sourceFreeze = yield* retireErasureSource({
        db: native.db,
        fence: { from: "initial", retired },
      });
      const target = yield* Schema.decodeUnknownEffect(RecoveryTarget)(yield* io(native.identity));
      // Component copy evidence only; never production provider or serving qualification.
      const evidence: RecoveryClosedSourceEvidence = {
        activationId: "18460000-0000-4000-8000-000000000002",
        admissionObjectId: "1".repeat(64),
        source: { kind: "D1", databaseId: "18460000-0000-4000-8000-000000000001", epoch: "source" },
        sourceGeneration: retired,
        sourceFreeze: { kind: "NativeDmlFreeze", plan: sourceFreeze },
        finalGeneration: "18460000-0000-4000-8000-000000000004",
        finalCheckpointEtag: "native-final",
        providerEvidenceDigest: "0".repeat(64),
        ledgerDigest: "1".repeat(64),
      };
      let digest = Option.none<string>();
      let importSteps = 0;
      for (let step = 0; step < 2000; step++) {
        const result = yield* advanceClosedSnapshot({
          ...native,
          source: evidence.source,
          target,
          activationId: evidence.activationId,
          closedSource: () => Effect.succeed(evidence),
        });
        if (result.kind === "Ready") {
          digest = Option.some(result.artifactDigest);
          importSteps = result.schemaObjects * 4 + result.rows * 2 + 10;
          break;
        }
      }
      const artifactDigest = Option.getOrThrow(digest);
      let imported = false;
      let rowReplyLost = false;
      let last = "No import progress";
      for (let step = 0; step < importSteps; step++) {
        const response = yield* io(() => native.step({ artifactDigest, evidence }));
        expect(response.status).toBe(200);
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            phase: Schema.String,
            stage: Schema.String,
            copiedRows: Schema.Int,
            schemaObjects: Schema.Int,
          })
        )(yield* io(() => response.json()));
        if (result.stage === "Data" && result.copiedRows === 0 && !rowReplyLost) {
          expect((yield* io(() => native.interrupt({ artifactDigest, evidence }))).status).toBe(
            503
          );
          rowReplyLost = true;
        }
        last = `${result.phase}/${result.stage}/${result.copiedRows}/${result.schemaObjects}`;
        if (result.phase === "ErasureVerification") {
          imported = true;
          break;
        }
      }
      expect(imported, last).toBe(true);
      expect(rowReplyLost).toBe(true);
      expect(yield* readErasureSourceGeneration({ db: native.db })).toBe(retired);
      expect(yield* io(native.facts)).toMatchObject({
        sourceControls: [{ count: 0 }],
        domainGuards: [domainGuards],
        rows: [{ sequence: "9007199254740993" }],
        money: [{ amount: "123456789012345678901234567890.01" }],
        foreignKeys: [{ foreign_keys: 1 }],
        generation: [{ generation: retired }],
        sequence: [{ value: "9007199254740993" }],
        credential: [
          { digest: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" },
        ],
        admission: { phase: "Closed", activationId: evidence.activationId, epoch: target.epoch },
        seal: null,
      });
      expect(
        yield* io(() =>
          native.tryOpen({ activationId: evidence.activationId, epoch: target.epoch })
        )
      ).toMatchObject({ kind: "refused", reason: "inactive" });
      expect((yield* io(native.activateFixture)).status).toBe(204);
      expect((yield* io(() => native.step({ artifactDigest, evidence }))).status).toBe(503);
    }).pipe(Effect.scoped),
  { timeout: 120000 }
);

it.live(
  "the configured constructor/alarm refuses import without independent bootstrap authorization",
  () =>
    Effect.gen(function* () {
      const native = yield* nativeSqliteImport;
      expect(yield* io(native.bootstrapRefusal)).toEqual({ status: 503, sealed: false, tables: 0 });
      expect((yield* io(() => native.artifacts.list())).objects).toEqual([]);
    }).pipe(Effect.scoped)
);
