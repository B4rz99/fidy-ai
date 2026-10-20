import { afterAll, expect, it } from "vitest";
import { Data, DateTime, Effect } from "effect";
import { recordAuthorizedCall, recordOwnerCall } from "../../../src/shell/audit/operations";
import { makeAudit, makeAuditRetention } from "../../../src/shell/audit/runtime";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import {
  applyTestMigration,
  installTestSchema,
  isolatedTestDatabases,
} from "../../d1-test-fixture";
import { fixtureWorker as coreWorker } from "../../core-worker.test-fixture";
import { approvedWorkersAiModel } from "../../../src/shell/hosted-inference/contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const sessionId = "20000000-0000-4000-8000-000000000001";
const otherSessionId = "20000000-0000-4000-8000-000000000002";
const current = Date.UTC(2026, 8, 30);
const digest = new Uint8Array(32).fill(1);
class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ readonly cause: unknown }> {}
const attempt = <A>(work: () => Promise<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({ try: work, catch: (cause) => new FixtureFailure({ cause }) });

const setup = (beforeConsolidation = false): Effect.Effect<D1Database, FixtureFailure> =>
  Effect.gen(function* () {
    const db = yield* attempt(() => databases.acquire());
    const names = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("../../migrations/", import.meta.url).pathname)
    ).sort();
    if (beforeConsolidation) {
      for (const name of names.filter((name) => name < "0135_accountability.sql")) {
        yield* attempt(() =>
          applyTestMigration({ db, source: new URL(`../../migrations/${name}`, import.meta.url) })
        );
      }
    } else {
      yield* attempt(() =>
        installTestSchema({
          db,
          sources: names.map((name) => new URL(`../../migrations/${name}`, import.meta.url)),
        })
      );
    }
    yield* attempt(() =>
      db.batch([
        ...[userId, otherUserId].map((id) =>
          db
            .prepare(
              "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
            )
            .bind(id, current)
        ),
        ...[
          { id: sessionId, user: userId, code: "ABC-DEF12", digest },
          {
            id: otherSessionId,
            user: otherUserId,
            code: "ABC-DEF13",
            digest: new Uint8Array(32).fill(2),
          },
        ].flatMap((session) => [
          db
            .prepare(
              "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
            )
            .bind(
              session.id,
              session.code,
              session.digest,
              session.user,
              current,
              current + 600000
            ),
          db
            .prepare(
              "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
              session.id,
              session.id,
              session.user,
              session.digest,
              current,
              current + 600000,
              current + 86400000,
              current + 7776000000
            ),
        ]),
      ])
    );
    return db;
  });

it("records only approved canonical-call metadata and never returns another User's evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordAuthorizedCall({
        authority: liveWebSessionAuthority({ subject: { id: sessionId, userId, digest }, current }),
        id: "30000000-0000-4000-8000-000000000001",
        operation: "transactions.listTransactions",
        outcome: "success",
        current,
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      const audit = makeAudit({ database: db });
      const entries = yield* audit.query({ userId, limit: 10 });
      expect(entries).toEqual([
        {
          id: "30000000-0000-4000-8000-000000000001",
          subjectUserId: userId,
          caller: { _tag: "WebSession", webSessionId: sessionId },
          operation: "transactions.listTransactions",
          outcome: "succeeded",
          occurredAt: DateTime.makeUnsafe(current),
        },
      ]);
      expect(yield* audit.query({ userId: otherUserId, limit: 10 })).toEqual([]);
    })
  ));

it("refuses another User's credential without appending evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordAuthorizedCall({
        authority: liveWebSessionAuthority({
          subject: { id: sessionId, userId: otherUserId, digest },
          current,
        }),
        id: "30000000-0000-4000-8000-000000000002",
        operation: "transactions.listTransactions",
        outcome: "success",
        current,
        afterOwnerWrite: false,
      });
      const result = yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      expect(result.meta.changes).toBe(0);
      const audit = makeAudit({ database: db });
      expect(yield* audit.query({ userId, limit: 10 })).toEqual([]);
      expect(yield* audit.query({ userId: otherUserId, limit: 10 })).toEqual([]);
    })
  ));

it("keeps owner work and required Audit evidence atomic when append-only evidence refuses a duplicate", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordOwnerCall({
        id: "30000000-0000-4000-8000-000000000003",
        userId,
        caller: { _tag: "WebSession", id: sessionId },
        operation: "transactions.createTransaction",
        outcome: "success",
        current,
        when: { sql: "SELECT 1", params: [] },
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      const result = yield* Effect.result(
        attempt(() =>
          db.batch([
            db.prepare("UPDATE users SET time_zone = 'UTC' WHERE id = ?").bind(userId),
            db.prepare(statement.sql).bind(...statement.params),
          ])
        )
      );
      expect(result._tag).toBe("Failure");
      expect(
        yield* attempt(() =>
          db.prepare("SELECT time_zone FROM users WHERE id = ?").bind(userId).first("time_zone")
        )
      ).toBe("America/Bogota");
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 10 })).toHaveLength(1);
    })
  ));

it("retains evidence for 365 days, removes only the selected User's older evidence, and keeps ordinary deletion forbidden", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const retentionNow = current + 365 * 86400000;
      const statements = [
        { id: "30000000-0000-4000-8000-000000000004", userId, occurredAt: current - 1 },
        { id: "30000000-0000-4000-8000-000000000005", userId, occurredAt: current },
        {
          id: "30000000-0000-4000-8000-000000000006",
          userId: otherUserId,
          occurredAt: current - 1,
        },
      ].map((entry) =>
        recordOwnerCall({
          id: entry.id,
          userId: entry.userId,
          caller: { _tag: "WebSession", id: entry.userId === userId ? sessionId : otherSessionId },
          operation: "transactions.listTransactions",
          outcome: "success",
          current: entry.occurredAt,
          when: { sql: "SELECT 1", params: [] },
          afterOwnerWrite: false,
        })
      );
      yield* attempt(() =>
        db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)))
      );
      const deletion = yield* Effect.result(
        attempt(() =>
          db
            .prepare(
              "DELETE FROM audit_entries WHERE record_type='session_call' AND (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ?"
            )
            .bind(userId)
            .run()
        )
      );
      expect(deletion._tag).toBe("Failure");
      const rewrite = yield* Effect.result(
        attempt(() =>
          db
            .prepare(
              "UPDATE audit_entries SET outcome = 'not_found' WHERE record_type='session_call' AND user_id = ?"
            )
            .bind(userId)
            .run()
        )
      );
      expect(rewrite._tag).toBe("Failure");
      expect(
        yield* makeAuditRetention({ database: db }).retain({ userId, now: retentionNow })
      ).toBe(1);
      const audit = makeAudit({ database: db });
      expect((yield* audit.query({ userId, limit: 10 })).map((entry) => entry.id)).toEqual([
        "30000000-0000-4000-8000-000000000005",
      ]);
      expect(
        (yield* audit.query({ userId: otherUserId, limit: 10 })).map((entry) => entry.id)
      ).toEqual(["30000000-0000-4000-8000-000000000006"]);
      const afterRetention = yield* Effect.result(
        attempt(() =>
          db
            .prepare(
              "DELETE FROM audit_entries WHERE record_type='session_call' AND (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ?"
            )
            .bind(userId)
            .run()
        )
      );
      expect(afterRetention._tag).toBe("Failure");
    })
  ));

it("rolls retention back and leaves ordinary deletion forbidden when a later projection fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordOwnerCall({
        id: "30000000-0000-4000-8000-000000000007",
        userId,
        caller: { _tag: "WebSession", id: sessionId },
        operation: "transactions.listTransactions",
        outcome: "success",
        current: current - 1,
        when: { sql: "SELECT 1", params: [] },
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      yield* attempt(() =>
        db
          .prepare(
            "CREATE TRIGGER audit_retention_failure BEFORE DELETE ON audit_retention_permits BEGIN SELECT RAISE(ABORT, 'private database detail'); END"
          )
          .run()
      );
      const result = yield* Effect.result(
        makeAuditRetention({ database: db }).retain({ userId, now: current + 365 * 86400000 })
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toEqual(expect.objectContaining({ _tag: "AuditUnavailable" }));
      }
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 10 })).toHaveLength(1);
      const deletion = yield* Effect.result(
        attempt(() =>
          db
            .prepare(
              "DELETE FROM audit_entries WHERE record_type='session_call' AND (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ?"
            )
            .bind(userId)
            .run()
        )
      );
      expect(deletion._tag).toBe("Failure");
    })
  ));

it("returns a safe failure instead of exposing malformed stored evidence or database details", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* attempt(() =>
        db
          .prepare(
            "INSERT INTO audit_entries(record_type,id, user_id, session_id, operation, outcome, occurred_at_ms) VALUES ('session_call','malformed-private-value', ?, ?, 'transactions.listTransactions', 'success', ?)"
          )
          .bind(userId, sessionId, current)
          .run()
      );
      const result = yield* Effect.result(makeAudit({ database: db }).query({ userId, limit: 10 }));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("AuditUnavailable");
        expect(result.failure).not.toHaveProperty("cause");
        expect(String(result.failure)).not.toContain("malformed-private-value");
      }
    })
  ));

it("observes subject-scoped publication evidence without inventing a missing credential", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordAuthorizedCall({
        authority: liveWebSessionAuthority({ subject: { id: sessionId, userId, digest }, current }),
        id: "30000000-0000-4000-8000-000000000008",
        operation: "ingestion.listNeedsReviewItems",
        outcome: "success",
        current,
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      const audit = makeAudit({ database: db });
      const entries = yield* audit.publications({ userId, limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        id: "30000000-0000-4000-8000-000000000008",
        subjectUserId: userId,
        operation: "ingestion.listNeedsReviewItems",
        outcome: "succeeded",
        occurredAt: DateTime.makeUnsafe(current),
      });
      expect(yield* audit.publications({ userId: otherUserId, limit: 10 })).toEqual([]);
    })
  ));

it("runs scheduled Audit retention independently of a failed earlier maintenance activity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statement = recordOwnerCall({
        id: "30000000-0000-4000-8000-000000000009",
        userId,
        caller: { _tag: "WebSession", id: sessionId },
        operation: "transactions.listTransactions",
        outcome: "success",
        current: current - 366 * 86400000,
        when: { sql: "SELECT 1", params: [] },
        afterOwnerWrite: false,
      });
      yield* attempt(() =>
        db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run()
      );
      const result = yield* Effect.result(
        attempt(() =>
          coreWorker.scheduled(
            { cron: "* * * * *", scheduledTime: current, noRetry: () => {} },
            {
              DB: db,
              ASYNC_HEALTH_ENABLED: "enabled",
              AI: { run: () => Promise.reject(new Error("unused model")) },
              USER_TRANSACTION_COORDINATOR: {
                getByName: (): Pick<Fetcher, "fetch"> => ({
                  fetch: () => Promise.reject(new Error("unused coordinator")),
                }),
              },
              CONTRACT_DIGEST: "a".repeat(64),
              RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
              HOSTED_AI_MODEL: approvedWorkersAiModel,
              BROWSER_ORIGIN: "https://app.fidyapp.com",
              WOMPI_ENVIRONMENT: "",
              WOMPI_PUBLIC_KEY: "",
              WOMPI_PRIVATE_KEY: "",
              WOMPI_INTEGRITY_SECRET: "",
              KAPSO_API_KEY: "",
              WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
              KAPSO_WEBHOOK_SECRET: "unused",
              WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
              CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
              CLOUDFLARE_ACCESS_AUDIENCE: "test",
            }
          )
        )
      );
      expect(result._tag).toBe("Failure");
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 10 })).toEqual([]);
    })
  ));

it("bounds retention work and resumes the remaining expired evidence on the next run", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const statements = Array.from({ length: 65 }, (_, index) =>
        recordOwnerCall({
          id: `30000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
          userId,
          caller: { _tag: "WebSession", id: sessionId },
          operation: "transactions.listTransactions",
          outcome: "success",
          current: current - 1,
          when: { sql: "SELECT 1", params: [] },
          afterOwnerWrite: false,
        })
      );
      yield* attempt(() =>
        db.batch(statements.map((statement) => db.prepare(statement.sql).bind(...statement.params)))
      );
      const retention = makeAuditRetention({ database: db });
      expect(yield* retention.retain({ userId, now: current + 365 * 86400000 })).toBe(64);
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 256 })).toHaveLength(1);
      expect(yield* retention.retain({ userId, now: current + 365 * 86400000 })).toBe(1);
      expect(yield* makeAudit({ database: db }).query({ userId, limit: 256 })).toEqual([]);
    })
  ));

it("preserves populated accountability history, independent lifetimes and parent relationships through consolidation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup(true);
      const id = "30000000-0000-4000-8000-000000000090";
      const pat = "40000000-0000-4000-8000-000000000090";
      const enrollment = "50000000-0000-4000-8000-000000000090";
      const source = "60000000-0000-4000-8000-000000000090";
      const request = "70000000-0000-4000-8000-000000000090";
      const billing = "80000000-0000-4000-8000-000000000090";
      yield* attempt(() =>
        db.batch([
          db
            .prepare(`INSERT INTO pats(id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id)
          VALUES (?,?,'12345678',?,'fixture','["read"]',7,0,0,604800000,?)`)
            .bind(pat, userId, digest, request),
          db
            .prepare(`INSERT INTO card_enrollments(id,user_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,payment_request_id,wompi_candidate_source_id,method,wompi_environment)
          VALUES (?,?,'22700000-0000-4000-8000-000000000001','payer@example.com','creating','create','{}','{}',0,900000,?,3891,'card','sandbox')`)
            .bind(enrollment, userId, request),
          db
            .prepare(
              `INSERT INTO card_payment_sources(id,user_id,enrollment_id,wompi_source_id,billing_email,created_at_ms) VALUES (?,?,?,3891,'payer@example.com',0)`
            )
            .bind(source, userId, enrollment),
          db.prepare("UPDATE card_enrollments SET status='available' WHERE id=?").bind(enrollment),
          db
            .prepare(`INSERT INTO billing_attempts(id,user_id,enrollment_id,payment_request_id,payment_source_id,price_id,amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,wompi_reference,created_at_ms)
          VALUES (?,?,?,?,?,'22700000-0000-4000-8000-000000000001','9900','COP','weekly','CO','not-taxable','America/Bogota','sandbox','audit-migration',0)`)
            .bind(billing, userId, enrollment, request, source),
          db
            .prepare(`INSERT INTO media_submissions(id,user_id,portfolio_id,bsuid,message_id,input_digest,accepted_at_ms,expires_at_ms,service_market,locale,time_zone)
          VALUES (?,?,'portfolio','bsuid','message','digest',0,2592000000,'CO','es-CO','America/Bogota')`)
            .bind(id, userId),
          db
            .prepare(
              "INSERT INTO session_audit(id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES (?,?,?,'transactions.getTransaction','not_found',1)"
            )
            .bind(id, userId, sessionId),
          db
            .prepare(
              "INSERT INTO pat_audit(id,user_id,pat_id,operation,outcome,occurred_at_ms) VALUES (?,?,?,'memory.recall','accepted',2)"
            )
            .bind(id, userId, pat),
          db
            .prepare(
              "INSERT INTO insight_audit(id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES (?,?,?,'insights.listPendingInsights','rejected',3)"
            )
            .bind(id, userId, sessionId),
          db
            .prepare(
              "INSERT INTO ingestion_publication_audit(id,user_id,operation,outcome,occurred_at_ms) VALUES (?,?,'ingestion.submitForExtraction','resource_limit',4)"
            )
            .bind(id, userId),
          db
            .prepare(
              "INSERT INTO media_submission_audit(id,user_id,outcome,occurred_at_ms) VALUES (?,?,'accepted',5)"
            )
            .bind(id, userId),
          db
            .prepare(
              "INSERT INTO billing_audit(attempt_id,transition,occurred_at_ms) VALUES (?,'failed',6)"
            )
            .bind(billing),
          db
            .prepare(
              "INSERT INTO canonical_request_acceptances(id,user_id,pat_id,operation,accepted_at_ms) VALUES (?,?,?,'memory.recall',7)"
            )
            .bind(id, userId, pat),
          db
            .prepare(
              "INSERT INTO canonical_user_reads(id,user_id,session_id,occurred_at_ms) VALUES (?,?,?,8)"
            )
            .bind(id, userId, sessionId),
          db
            .prepare(
              "INSERT INTO canonical_security_mutations(id,user_id,session_id,operation,occurred_at_ms) VALUES (?,?,?,'recovery.rotateBackupRecoveryCode',9)"
            )
            .bind(id, userId, sessionId),
        ])
      );
      const sources = [
        ["session_audit", "session_call"],
        ["pat_audit", "credential_call"],
        ["insight_audit", "insight_call"],
        ["ingestion_publication_audit", "publication"],
        ["media_submission_audit", "media_admission"],
        ["billing_audit", "billing_transition"],
        ["canonical_request_acceptances", "request_admission"],
        ["canonical_user_reads", "identity_read"],
        ["canonical_security_mutations", "security_mutation"],
      ] as const;
      const before = yield* attempt(() =>
        Promise.all(sources.map(([table]) => db.prepare(`SELECT * FROM ${table}`).all()))
      );
      yield* attempt(() =>
        applyTestMigration({
          db,
          source: new URL("../../migrations/0135_accountability.sql", import.meta.url),
        })
      );
      for (const [index, [, kind]] of sources.entries()) {
        const oldRows = before[index]?.results ?? [];
        const columns = Object.keys(oldRows[0] ?? {});
        const after = yield* attempt(() =>
          db
            .prepare(`SELECT ${columns.join(",")} FROM audit_entries WHERE record_type=?`)
            .bind(kind)
            .all()
        );
        expect(after.results, kind).toEqual(oldRows);
      }
      const audit = makeAudit({ database: db });
      expect(
        (yield* audit.query({ userId, limit: 20 })).map(({ operation, outcome }) => ({
          operation,
          outcome,
        }))
      ).toEqual([
        { operation: "transactions.getTransaction", outcome: "rejected" },
        { operation: "memory.recall", outcome: "succeeded" },
        { operation: "insights.listPendingInsights", outcome: "rejected" },
      ]);
      expect(yield* makeAuditRetention({ database: db }).retain({ userId, now: current })).toBe(4);
      const retained = yield* attempt(() =>
        db.prepare("SELECT record_type FROM audit_entries ORDER BY record_type").all()
      );
      expect(retained.results.map(({ record_type }) => record_type)).toEqual([
        "billing_transition",
        "identity_read",
        "media_admission",
        "request_admission",
        "security_mutation",
      ]);
      yield* attempt(() => db.prepare("DELETE FROM media_submissions WHERE id=?").bind(id).run());
      expect(
        yield* attempt(() =>
          db
            .prepare("SELECT count(*) FROM audit_entries WHERE record_type='media_admission'")
            .first("count(*)")
        )
      ).toBe(0);
      expect((yield* attempt(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
        []
      );
    })
  ));
