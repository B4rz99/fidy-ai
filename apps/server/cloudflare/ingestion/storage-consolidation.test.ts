import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import {
  applyTestMigration,
  installRetentionTestSchema,
  isolatedTestDatabases,
} from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const run = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);
const user = "10000000-0000-4000-8000-000000000001";
const migration = (name: string): URL => new URL(`../migrations/${name}.sql`, import.meta.url);
const seedPredecessor = (db: D1Database): Effect.Effect<void> =>
  Effect.gen(function* () {
    const names = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
    )
      .filter((name) => name < "0115_ingestion_audit.sql")
      .sort();
    yield* Effect.forEach(names, (name) =>
      run(() =>
        applyTestMigration({ db, source: new URL(`../migrations/${name}`, import.meta.url) })
      )
    );
    yield* run(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
          )
          .bind(user),
        ...[
          "statement_submission_audit",
          "statement_review_audit",
          "statement_clarification_audit",
        ].map((table, index) =>
          db
            .prepare(`INSERT INTO ${table} VALUES (?,?,?,'success',?)`)
            .bind(
              `10000000-0000-4000-8000-00000000001${index}`,
              user,
              [
                "ingestion.submitForExtraction",
                "ingestion.listNeedsReviewItems",
                "ingestion.skipNeedsReviewItem",
              ][index],
              index
            )
        ),
        db
          .prepare(
            "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms) VALUES ('stage',?,'private',1,?,'available',0,10000)"
          )
          .bind(user, "a".repeat(64)),
        db
          .prepare(
            "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,retention_expires_at_ms) VALUES ('submission',?,?,'stage',0,'csv','v1','CO','es-CO','America/Bogota',10000)"
          )
          .bind(user, "10000000-0000-4000-8000-000000000020"),
        ...[1, 2].map((row) =>
          db
            .prepare(
              "INSERT INTO statement_needs_review(id,user_id,submission_id,record_number,reason,original_evidence,issues,status,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision) VALUES (?,?,'submission',?,'missing-required-fact','original','[]','pending',10000,0,'CO','es-CO','America/Bogota','csv','v1','v1')"
            )
            .bind(`review-${row}`, user, row)
        ),
        db
          .prepare(
            "INSERT INTO statement_clarifications VALUES ('submission',?,'awaiting',10000,NULL)"
          )
          .bind(user),
        db
          .prepare(
            "INSERT INTO statement_review_decisions VALUES ('review-1','submission',?,'skipped',NULL,1)"
          )
          .bind(user),
        db
          .prepare(
            "INSERT INTO ingestion_review_state VALUES ('review-2',?,'pending',3,?,NULL,10000,2,0)"
          )
          .bind(user, '{"amount":"15000","userProvidedFields":["money"]}'),
        ...[1, 2].map((row) =>
          db
            .prepare(
              "INSERT INTO media_submissions VALUES (?,?, 'portfolio','actor',?,'digest','media',NULL,0,2592000000,'CO','es-CO','America/Bogota')"
            )
            .bind(`media-${row}`, user, `message-${row}`)
        ),
        db.prepare("INSERT INTO media_submission_outbox VALUES ('media-1',?,0)").bind(user),
        db
          .prepare("INSERT INTO media_needs_review VALUES ('media-1',?,'unparseable-material',123)")
          .bind(user),
        db
          .prepare(
            "INSERT INTO onboarding_consent_records (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES ('consent',?,'{}','disclosure','decision',0,0)"
          )
          .bind(user),
        db
          .prepare(
            "INSERT INTO forwarded_email_receipts(id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms) VALUES ('30000000-0000-4000-8000-000000000001',?,?,'private-email',1,'queued',0,10000)"
          )
          .bind(user, "a".repeat(64)),
        db
          .prepare(
            "INSERT INTO forwarded_email_deferrals VALUES ('30000000-0000-4000-8000-000000000001',?,999,456)"
          )
          .bind(user),
      ])
    );
  });

it.live(
  "preserves publication evidence, review drafts and released media capacity through storage consolidation",
  () =>
    Effect.gen(function* () {
      const db = yield* run(() => databases.acquire());
      yield* seedPredecessor(db);
      yield* Effect.forEach(
        [
          "0115_ingestion_audit",
          "0116_review_decisions",
          "0117_media_capacity",
          "0118_statement_failure",
          "0119_media_review",
          "0120_email_deferral",
        ],
        (name) => run(() => applyTestMigration({ db, source: migration(name) }))
      );
      expect(
        (yield* run(() =>
          db
            .prepare("SELECT operation FROM ingestion_publication_audit ORDER BY occurred_at_ms")
            .all()
        )).results
      ).toEqual([
        { operation: "ingestion.submitForExtraction" },
        { operation: "ingestion.listNeedsReviewItems" },
        { operation: "ingestion.skipNeedsReviewItem" },
      ]);
      expect(
        (yield* run(() =>
          db
            .prepare(
              "SELECT id,status,revision,draft_json IS NOT NULL AS draft FROM ingestion_review_state ORDER BY id"
            )
            .all()
        )).results
      ).toEqual([
        { id: "review-1", status: "skipped", revision: 1, draft: 0 },
        { id: "review-2", status: "pending", revision: 3, draft: 1 },
      ]);
      expect(
        (yield* run(() =>
          db.prepare("SELECT id,capacity_held FROM media_submissions ORDER BY id").all()
        )).results
      ).toEqual([
        { id: "media-1", capacity_held: 1 },
        { id: "media-2", capacity_held: 0 },
      ]);
      expect(
        (yield* run(() =>
          db
            .prepare(
              "SELECT id,review_reason,review_created_at_ms FROM media_submissions ORDER BY id"
            )
            .all()
        )).results
      ).toEqual([
        { id: "media-1", review_reason: "unparseable-material", review_created_at_ms: 123 },
        { id: "media-2", review_reason: null, review_created_at_ms: null },
      ]);
      expect(
        (yield* run(() =>
          db
            .prepare(
              "SELECT id,reason,created_at_ms FROM ingestion_review_sources WHERE source='media'"
            )
            .all()
        )).results
      ).toEqual([{ id: "media-1", reason: "unparseable-material", created_at_ms: 123 }]);
      expect(
        yield* run(() =>
          db
            .prepare("SELECT deferred_checked_at_ms FROM forwarded_email_receipts")
            .first("deferred_checked_at_ms")
        )
      ).toBe(456);
      yield* run(() => db.prepare("UPDATE forwarded_email_receipts SET state='expired'").run());
      expect(
        yield* run(() =>
          db
            .prepare("SELECT deferred_checked_at_ms FROM forwarded_email_receipts")
            .first("deferred_checked_at_ms")
        )
      ).toBeNull();
      yield* run(() =>
        expect(
          db.prepare("UPDATE ingestion_publication_audit SET outcome='not_found'").run()
        ).rejects.toThrow("audit_append_only")
      );
      expect((yield* run(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
      expect(
        (yield* run(() =>
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name IN ('media_needs_review','forwarded_email_deferrals','statement_review_decisions','media_submission_outbox','statement_submission_audit','statement_review_audit','statement_clarification_audit')"
            )
            .all()
        )).results
      ).toEqual([]);
      expect(
        (yield* run(() =>
          db.prepare("PRAGMA table_info(statement_submissions)").all()
        )).results.some((row) => row.name === "legacy_failure_reason")
      ).toBe(false);
    })
);

it.live(
  "bounds receipt deferrals at fifty, releases expiry capacity and rolls admission back atomically",
  () =>
    Effect.gen(function* () {
      const db = yield* run(() => databases.acquire());
      yield* run(() => installRetentionTestSchema(db));
      yield* run(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(user),
          db
            .prepare(
              "INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES ('processing_grant','consent',?,'{}','disclosure','decision',0,0)"
            )
            .bind(user),
          ...Array.from({ length: 51 }, (_, index) =>
            db
              .prepare(
                "INSERT INTO forwarded_email_receipts(id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms) VALUES (?,?,?, ?,1,'storing',0,10000)"
              )
              .bind(
                `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                user,
                String(index).padStart(64, "0"),
                `email-${index}`
              )
          ),
        ])
      );
      yield* run(() =>
        db
          .prepare(
            "UPDATE forwarded_email_receipts SET state='queued',deferred_checked_at_ms=1 WHERE object_key!='email-50'"
          )
          .run()
      );
      // Updating an existing deferral remains possible even while all fifty slots are held.
      yield* run(() =>
        db
          .prepare(
            "UPDATE forwarded_email_receipts SET deferred_checked_at_ms=2 WHERE deferred_checked_at_ms IS NOT NULL"
          )
          .run()
      );
      yield* run(() =>
        expect(
          db
            .prepare(
              "UPDATE forwarded_email_receipts SET state='queued',deferred_checked_at_ms=3 WHERE object_key='email-50'"
            )
            .run()
        ).rejects.toThrow("forwarded_email_deferred_capacity")
      );
      expect(
        yield* run(() =>
          db
            .prepare(
              "SELECT state,deferred_checked_at_ms FROM forwarded_email_receipts WHERE object_key='email-50'"
            )
            .first()
        )
      ).toEqual({ state: "storing", deferred_checked_at_ms: null });
      yield* run(() =>
        expect(
          db
            .prepare(
              "INSERT INTO forwarded_email_receipts(id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,deferred_checked_at_ms) VALUES ('40000000-0000-4000-8000-000000000000',?,?,'overflow',1,'queued',0,10000,1)"
            )
            .bind(user, "f".repeat(64))
            .run()
        ).rejects.toThrow("forwarded_email_deferred_capacity")
      );
      yield* run(() =>
        db
          .prepare("UPDATE forwarded_email_receipts SET state='expired' WHERE object_key='email-0'")
          .run()
      );
      yield* run(() =>
        db
          .prepare(
            "UPDATE forwarded_email_receipts SET state='queued',deferred_checked_at_ms=3 WHERE object_key='email-50'"
          )
          .run()
      );
      expect(
        yield* run(() =>
          db
            .prepare(
              "SELECT count(*) AS total FROM forwarded_email_receipts WHERE deferred_checked_at_ms IS NOT NULL"
            )
            .first("total")
        )
      ).toBe(50);
      expect((yield* run(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
    })
);

it.live(
  "migrates fenced metadata and retains its consolidated fields under an ingestion hold",
  () =>
    Effect.gen(function* () {
      const db = yield* run(() => databases.acquire());
      yield* seedPredecessor(db);
      yield* Effect.forEach(
        [
          "0115_ingestion_audit",
          "0116_review_decisions",
          "0117_media_capacity",
          "0118_statement_failure",
        ],
        (name) => run(() => applyTestMigration({ db, source: migration(name) }))
      );
      yield* run(() =>
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES ('hold',?,0,'Sealing')"
          )
          .bind(user)
          .run()
      );
      yield* Effect.forEach(["0119_media_review", "0120_email_deferral"], (name) =>
        run(() => applyTestMigration({ db, source: migration(name) }))
      );
      for (const sql of [
        "UPDATE media_submissions SET review_reason='extraction-unavailable'",
        "UPDATE forwarded_email_receipts SET deferred_checked_at_ms=NULL",
      ]) {
        yield* run(() => expect(db.prepare(sql).run()).rejects.toThrow("erasure_fenced"));
      }
      const current = yield* Clock.currentTimeMillis;
      const decision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        dispositions: {
          ingestion: { action: "Retain", retention: { untilMs: current + 86400000 } },
        },
      });
      yield* run(() =>
        db.batch([
          db
            .prepare("UPDATE erasure_requests SET state='Draining',decision_json=? WHERE id='hold'")
            .bind(decision),
          db.prepare("DELETE FROM media_submissions WHERE id='media-1'"),
          db.prepare("DELETE FROM forwarded_email_receipts"),
        ])
      );
      const rows = (yield* run(() =>
        db
          .prepare(
            "SELECT store_id,json_extract(body,'$.review_reason') AS reason,json_extract(body,'$.review_created_at_ms') AS created,json_extract(body,'$.deferred_checked_at_ms') AS checked FROM erasure_archives WHERE request_id='hold' ORDER BY store_id"
          )
          .all()
      )).results;
      expect(rows).toEqual([
        { store_id: "forwarded_email_receipts", reason: null, created: null, checked: 456 },
        {
          store_id: "media_submissions",
          reason: "unparseable-material",
          created: 123,
          checked: null,
        },
      ]);
      expect((yield* run(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
    })
);
