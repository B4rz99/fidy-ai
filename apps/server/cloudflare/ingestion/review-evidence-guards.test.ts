import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "14580000-0000-4000-8000-000000000001";
const submission = "14580000-0000-4000-8000-000000000003";

it("keeps retained statement evidence until settlement and prevents expired evidence from being revived", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
            )
            .bind(userId),
          db
            .prepare(
              "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,source_format,status,created_at_ms,expires_at_ms,published_submission_id) VALUES('staging',?,'private',100,?,'csv','published',1,86400001,?)"
            )
            .bind(userId, "a".repeat(64), submission),
          db
            .prepare(
              "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms) VALUES(?,?,?,'staging',1,'csv','statement-parser-v1','CO','es-CO','America/Bogota','queued',86400001)"
            )
            .bind(submission, userId, "14580000-0000-4000-8000-000000000004"),
          db
            .prepare(
              "INSERT INTO ingestion_review_items(id,user_id,source_kind,statement_submission_id,record_number,reason,original_evidence,issues_json,evidence_state,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision) VALUES('review',?,'statement',?,1,'mapping-unavailable','{}','[]','retained',86400001,1,'CO','es-CO','America/Bogota','csv','statement-parser-v1','statement-mechanical-v1')"
            )
            .bind(userId, submission),
        ])
      );
      const read = (): Promise<unknown> =>
        db
          .prepare(
            "SELECT evidence_state,original_evidence,evidence_expires_at_ms FROM ingestion_review_items WHERE id='review'"
          )
          .first();
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "UPDATE ingestion_review_items SET evidence_state='resolved',original_evidence=NULL,known_money_json=NULL,suggestions_json=NULL WHERE id='review'"
            )
            .run()
        ).rejects.toThrow("review_immutable")
      );
      expect(yield* Effect.tryPromise(read)).toEqual({
        evidence_state: "retained",
        original_evidence: "{}",
        evidence_expires_at_ms: 86400001,
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE ingestion_review_items SET evidence_state='expired',original_evidence=NULL,known_money_json=NULL,suggestions_json=NULL WHERE id='review'"
          )
          .run()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "UPDATE ingestion_review_items SET evidence_state='retained',original_evidence='{}' WHERE id='review'"
            )
            .run()
        ).rejects.toThrow("review_immutable")
      );
      expect(yield* Effect.tryPromise(read)).toEqual({
        evidence_state: "expired",
        original_evidence: null,
        evidence_expires_at_ms: 86400001,
      });
    })
  ));
