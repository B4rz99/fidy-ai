import { type Cause, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { applyTestMigration, isolatedTestDatabases } from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

const retainedQuery = ({
  db,
  table,
}: Readonly<{ db: D1Database; table: string }>): Effect.Effect<string, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>()
      .then(
        (columns) => `SELECT ${columns.results.map(({ name }) => name).join(",")} FROM ${table}`
      )
  );

it("preserves original trial dates, typed consent identities, rejection order and retained evidence across consolidation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const names = Array.from(
        new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
      ).sort();
      for (const name of names.filter((name) => name < "0133")) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(`../migrations/${name}`, import.meta.url) })
        );
      }
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES ('10000000-0000-4000-8000-000000000001','CO','es-CO','America/Bogota',10),('20000000-0000-4000-8000-000000000002','CO','es-CO','America/Bogota',20)"
          ),
          db.prepare(
            "INSERT INTO trial_periods(user_id,started_at_ms,ends_at_ms) VALUES ('10000000-0000-4000-8000-000000000001',100,604800100)"
          ),
          db.prepare(
            "INSERT INTO onboarding_consent_records(id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES ('same-id','10000000-0000-4000-8000-000000000001','{}','disclosed','accepted',100,100)"
          ),
          db.prepare(
            "INSERT INTO weekly_consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES ('offer','10000000-0000-4000-8000-000000000001','portfolio','subject','{}',100,200)"
          ),
          db.prepare(
            "INSERT INTO weekly_consent_records(id,user_id,offer_id,record_json,occurred_at_ms) VALUES ('same-id','10000000-0000-4000-8000-000000000001','offer','{}',100)"
          ),
          db.prepare(
            "INSERT INTO weekly_consent_rejections(sequence,id,user_id,offer_id,decision_message_id,decision) VALUES (42,'rejected','10000000-0000-4000-8000-000000000001','offer','declined','decline')"
          ),
          db.prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES ('30000000-0000-4000-8000-000000000003','BCDF-GHJK',zeroblob(32),'10000000-0000-4000-8000-000000000001','consumed',100,600100)"
          ),
          db.prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES ('40000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',zeroblob(32),100,600100,600100,7776000100)"
          ),
          db.prepare(
            "INSERT INTO proactivity_consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES ('context-offer','10000000-0000-4000-8000-000000000001','manual-entry-reminder','portfolio','subject','{}',100,200)"
          ),
          db.prepare(
            "INSERT INTO proactivity_consent_records(id,user_id,kind,offer_id,decision_message_id,record_json,occurred_at_ms) VALUES ('context-grant','10000000-0000-4000-8000-000000000001','manual-entry-reminder','context-offer','context-decision','{}',100)"
          ),
          db.prepare(
            "INSERT INTO reminder_schedules(id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id) VALUES ('schedule','10000000-0000-4000-8000-000000000001',1,1,'{}','2026-10-01T00:00:00Z','context-grant')"
          ),
          db.prepare(
            "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) VALUES ('event','10000000-0000-4000-8000-000000000001','manual-entry-reminder','schedule',1,'CO','es-CO','America/Bogota','2026-10-01T00:00:00Z','[]')"
          ),
          db.prepare(
            "INSERT INTO reminder_occurrence_reports(user_id,insight_event_id,consent_grant_id,expires_at_ms) VALUES ('10000000-0000-4000-8000-000000000001','event','context-grant',200)"
          ),
          db.prepare(
            "INSERT INTO recurring_digest_instructions(user_id,id,version,enabled,grant_id,context_json,acceptance_from_ms,accepted_at_ms) VALUES ('10000000-0000-4000-8000-000000000001','digest',1,1,'context-grant','{}',100,100)"
          ),
          db.prepare(
            "INSERT INTO proactivity_reports(delivery_id,user_id,role,consent_grant_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES ('event','10000000-0000-4000-8000-000000000001','manual-entry-reminder','context-grant','Frozen delivery',100,200,'America/Bogota',100)"
          ),
          db.prepare(
            "INSERT INTO consent_user_revocations(id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('withdrawal','10000000-0000-4000-8000-000000000001','same-id','40000000-0000-4000-8000-000000000004',100)"
          ),
          db.prepare("UPDATE sqlite_sequence SET seq=100 WHERE name='weekly_consent_rejections'"),
        ])
      );
      const retainedQueries = yield* Effect.forEach(
        [
          "consent_user_revocations",
          "reminder_schedules",
          "reminder_occurrence_reports",
          "recurring_digest_instructions",
          "proactivity_reports",
        ],
        (table) => retainedQuery({ db, table })
      );
      const retained = yield* Effect.tryPromise(() =>
        db.batch(retainedQueries.map((sql) => db.prepare(sql)))
      );
      for (const name of names.filter((name) => name >= "0133" && name < "0136")) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(`../migrations/${name}`, import.meta.url) })
        );
      }
      expect(
        (yield* Effect.tryPromise(() =>
          db.batch(retainedQueries.map((sql) => db.prepare(sql)))
        )).map(({ results }) => results)
      ).toEqual(retained.map(({ results }) => results));
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id,trial_started_at_ms,trial_ends_at_ms FROM users ORDER BY id").all()
        )).results
      ).toEqual([
        {
          id: "10000000-0000-4000-8000-000000000001",
          trial_started_at_ms: 100,
          trial_ends_at_ms: 604800100,
        },
        {
          id: "20000000-0000-4000-8000-000000000002",
          trial_started_at_ms: null,
          trial_ends_at_ms: null,
        },
      ]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT record_type,id FROM consent_history ORDER BY record_type").all()
        )).results
      ).toEqual([
        { record_type: "proactivity_grant", id: "context-grant" },
        { record_type: "processing_grant", id: "same-id" },
        { record_type: "processing_withdrawal", id: "withdrawal" },
        { record_type: "weekly_grant", id: "same-id" },
        { record_type: "weekly_rejection", id: "rejected" },
      ]);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT sequence FROM consent_history WHERE record_type='weekly_rejection'")
            .first()
        )
      ).toEqual({ sequence: 42 });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO consent_history(record_type,id,user_id,offer_id,decision_message_id,decision) VALUES ('weekly_rejection','next','10000000-0000-4000-8000-000000000001','offer','next-decision','decline')"
          )
          .run()
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT sequence>100 AS preserved FROM consent_history WHERE id='next'")
            .first()
        )
      ).toEqual({ preserved: 1 });
      for (const sql of [
        "UPDATE users SET trial_started_at_ms=200,trial_ends_at_ms=604800200 WHERE id='10000000-0000-4000-8000-000000000001'",
        "UPDATE consent_history SET disclosure_json='{}' WHERE record_type='processing_grant'",
        "DELETE FROM consent_history WHERE record_type='weekly_grant'",
        "INSERT INTO consent_history(record_type,id,user_id,grant_id,offer_id,record_json,occurred_at_ms) VALUES ('weekly_grant','foreign','20000000-0000-4000-8000-000000000002','same-id','offer','{}',200)",
      ]) {
        expect((yield* Effect.exit(Effect.tryPromise(() => db.prepare(sql).run())))._tag).toBe(
          "Failure"
        );
      }
      for (const name of names.filter((name) => name >= "0136" && name < "0138")) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(`../migrations/${name}`, import.meta.url) })
        );
      }
      const user = "10000000-0000-4000-8000-000000000001";
      const statements = [
        "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES ('50000000-0000-4000-8000-000000000005','BCDF-GHJL',zeroblob(32),?,'ready',100,600100)",
        "INSERT INTO provider_credentials(issuer,subject,user_id,established_at_ms) VALUES ('issuer','subject',?,100)",
        "INSERT INTO provider_authentication_attempts(id,pairing_id,cookie_digest,nonce,intent,created_at_ms,expires_at_ms,state,issuer,subject,user_id) VALUES ('auth-attempt','50000000-0000-4000-8000-000000000005',zeroblob(32),'nonce','login',100,600100,'verified','issuer','subject',?)",
        "INSERT INTO completed_provider_authentications(attempt_id,user_id,completed_at_ms,created_user) VALUES ('auth-attempt',?,200,0)",
        "INSERT INTO weekly_governors(user_id,unanswered,question_needed,question_event_id) VALUES (?,3,1,'event')",
        'INSERT INTO reminder_governors(user_id,standing_json) VALUES (?,\'{"_tag":"QuestionPending","unanswered":3}\')',
        "INSERT INTO weekly_governor_deliveries(user_id,insight_event_id) VALUES (?,'event')",
        "INSERT INTO reminder_delivery_receipts(user_id,delivery_id) VALUES (?,'event')",
        "INSERT INTO proactivity_whatsapp_claims(user_id,delivery_id,role,consent_grant_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id) VALUES (?,'event','manual-entry-reminder','context-grant','category-correlation','portfolio','subject','phone','Frozen delivery',100,200,'UTC','ambiguous',101,'provider-category')",
        "INSERT INTO weekly_governor_questions(id,user_id,offer_id,created_at_ms,expires_at_ms,state,correlation_token,portfolio_id,bsuid,business_phone_number_id,text,time_zone,send_started_at_ms,provider_message_id) VALUES ('question',?,'offer',100,200,'ambiguous','question-correlation','portfolio','subject','phone','Frozen question','UTC',101,'provider-question')",
        "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms,source_format) VALUES ('staging',?,'private-statement',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','available',100,10000,'csv')",
        "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms) VALUES ('submission',?,'70000000-0000-4000-8000-000000000007','staging',100,'csv','parser','CO','es-CO','UTC','queued',10000)",
        "INSERT INTO statement_materializations(submission_id,user_id,source_sha256,parts_sha256,parser_revision,source_format,representation_revision,service_market,locale,time_zone,expires_at_ms,headers_json,row_count,part_count,byte_length,state) VALUES ('submission',?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','parser','csv','statement-material-v2','CO','es-CO','UTC',10000,'[\"fecha\"]',1,1,2,'building')",
        "INSERT INTO statement_hosted_origins(submission_id,user_id,session_id,turn_id,expires_at_ms) VALUES ('submission',?,'hosted-session','hosted-turn',10000)",
      ];
      yield* Effect.tryPromise(() => db.batch(statements.map((sql) => db.prepare(sql).bind(user))));
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO statement_materialization_parts VALUES ('submission',0,0,'[]',?)")
          .bind("b".repeat(64))
          .run()
      );
      // A processing grant for the other User exercises retained email review independently of the withdrawn User.
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES ('processing_grant','other-grant','20000000-0000-4000-8000-000000000002','{}','other-disclosure','other-decision',100,100)"
          ),
          db
            .prepare(
              "INSERT INTO forwarded_email_receipts(id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms) VALUES ('60000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000002',?,'private-email',1,'queued',100,10000)"
            )
            .bind("c".repeat(64)),
          db.prepare(
            "INSERT INTO forwarded_email_needs_review VALUES ('email-review','60000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000002','processing-interrupted',200,10000)"
          ),
          db.prepare(
            "INSERT INTO forwarded_email_outcomes VALUES ('60000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000002','needs-review',NULL,'email-review',200)"
          ),
        ])
      );
      for (const name of names.filter((name) => name >= "0138")) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(`../migrations/${name}`, import.meta.url) })
        );
      }
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT completed_at_ms,created_user,state,nonce FROM provider_authentication_attempts WHERE id='auth-attempt'"
            )
            .first()
        )
      ).toEqual({ completed_at_ms: 200, created_user: 0, state: "completed", nonce: "" });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT material_parts_sha256,material_state,hosted_session_id,hosted_turn_id FROM statement_submissions WHERE id='submission'"
            )
            .first()
        )
      ).toEqual({
        material_parts_sha256: "b".repeat(64),
        material_state: "building",
        hosted_session_id: "hosted-session",
        hosted_turn_id: "hosted-turn",
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT body FROM statement_materialization_parts WHERE submission_id='submission'"
            )
            .first()
        )
      ).toEqual({ body: "[]" });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT outcome,outcome_review_id,review_reason,review_evidence_expires_at_ms FROM forwarded_email_receipts WHERE review_id='email-review'"
            )
            .first()
        )
      ).toEqual({
        outcome: "needs-review",
        outcome_review_id: "email-review",
        review_reason: "processing-interrupted",
        review_evidence_expires_at_ms: 10000,
      });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT kind,id FROM consent_offers ORDER BY kind").all()
        )).results
      ).toEqual([
        { kind: "manual-entry-reminder", id: "context-offer" },
        { kind: "weekly-summary", id: "offer" },
      ]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT kind FROM governor_delivery_receipts ORDER BY kind").all()
        )).results
      ).toEqual([{ kind: "reminder" }, { kind: "weekly" }]);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT kind,state,send_started_at_ms,provider_message_id,text FROM whatsapp_deliveries ORDER BY kind"
            )
            .all()
        )).results
      ).toEqual([
        {
          kind: "proactivity",
          state: "ambiguous",
          send_started_at_ms: 101,
          provider_message_id: "provider-category",
          text: "Frozen delivery",
        },
        {
          kind: "weekly-question",
          state: "ambiguous",
          send_started_at_ms: 101,
          provider_message_id: "provider-question",
          text: "Frozen question",
        },
      ]);
      for (const sql of [
        "UPDATE forwarded_email_receipts SET review_reason='invalid-format' WHERE review_id='email-review'",
        "DELETE FROM forwarded_email_receipts WHERE review_id='email-review'",
        "UPDATE whatsapp_deliveries SET send_started_at_ms=NULL,state='staged' WHERE kind='proactivity'",
        "INSERT INTO consent_history(record_type,id,user_id,offer_id,record_json,occurred_at_ms) VALUES ('weekly_grant','wrong-kind','10000000-0000-4000-8000-000000000001','context-offer','{}',300)",
      ]) {
        expect((yield* Effect.exit(Effect.tryPromise(() => db.prepare(sql).run())))._tag).toBe(
          "Failure"
        );
      }
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
  ));
