import { statementParserLimits } from "../../src/shell/ingestion/contract";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import {
  CapturedFieldIssue,
  type NeedsReviewStatementRow,
  StatementRowEvidence,
} from "../../src/core/ingestion/contract";
import { statementReviewAdmission } from "./internal/statement-review-budget";
import { deepStrictEqual } from "node:assert/strict";
import { StatementProcessingUnavailable } from "./contract";
import { applyTestMigration, installTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { afterAll, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { currentMillis } from "../runtime/operations";
import {
  failStatementSubmission,
  prepareStatementSessionActivity,
  processStatementSubmission,
} from "./operations";
import { expireStatementReviewEvidence } from "./runtime";
import { StatementStaging, submissionProjection } from "./internal/statement-staging";

const fromTestPromise = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise(() => Promise.resolve(run())).pipe(Effect.orDie);

const userA = "10000000-0000-4000-8000-000000000101";
const userB = "10000000-0000-4000-8000-000000000102";
const submissionId = "10000000-0000-4000-8000-000000000601";
const stagingId = "10000000-0000-4000-8000-000000000602";
const retentionMs = 86_400_000;
// Keep this processing fixture minimal: the HTTP integration fixture exercises the full
// migration chain, while these tests need only the dependencies of row finalization.
const migrations = [
  "0001_categories",
  "0003_pending_consent",
  "0004_onboarding_email",
  "0005_verified_onboarding",
  "0006_browser_login",
  "0009_card_enrollment",
  "0009_transactions",
  "0010_pat_lifecycle",
  "0011_transaction_corrections",
  "0012_statement_staging",
  "0012_billing_collection",
  "0013_transaction_reconciliation",
  "0013_category_keyword_rules",
  "0014_memory",
  "0015_statement_submission",
  "0016_statement_processing",
  "0017_statement_dispatch",
  "0035_billing_corrections",
  "0052_weekly_card_renewal",
  "0032_statement_capture_entitlement",
  "0033_statement_clarification",
  "0035_statement_hosted_origin",
  "0077_statement_materialization",
];
const storage = isolatedTestStorage();

const setup = (
  content: string | Uint8Array,
  sourceFormat: "csv" | "xlsx" = "csv",
  schemaMigrations: ReadonlyArray<string> = migrations
): Promise<{ db: D1Database; bucket: R2Bucket }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() => storage.acquire());
      yield* fromTestPromise(() =>
        installTestSchema({
          db,
          sources: schemaMigrations.map(
            (name) => new URL(`../migrations/${name}.sql`, import.meta.url)
          ),
        })
      );
      const current = currentMillis();
      yield* fromTestPromise(() =>
        Promise.all(
          [userA, userB].map((userId) =>
            db
              .prepare(
                "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
              )
              .bind(userId, current)
              .run()
          )
        )
      );
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const hash = yield* fromTestPromise(() =>
        crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))
      );
      const sha256 = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      yield* fromTestPromise(() =>
        bucket.put("staging/statement/v1/test", bytes, { sha256: hash })
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO statement_staging_objects
    (id,user_id,object_key,byte_length,sha256,source_format,status,created_at_ms,expires_at_ms,published_submission_id)
    VALUES (?,?,'staging/statement/v1/test',?, ?,?,'published',?,?,?)`)
          .bind(
            stagingId,
            userA,
            bytes.length,
            sha256,
            sourceFormat,
            current - 1000,
            current + retentionMs,
            submissionId
          )
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO statement_submissions
    (id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,
      service_market,locale,time_zone,status,retention_expires_at_ms)
    VALUES (?,?,?,?,?,?,'statement-parser-v1','CO','es-CO','America/Bogota','queued',?)`)
          .bind(
            submissionId,
            userA,
            "10000000-0000-4000-8000-000000000603",
            stagingId,
            current,
            sourceFormat,
            current + retentionMs
          )
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO statement_ingestion_outbox
          (submission_id, user_id, revision, published_at_ms) VALUES (?, ?, 1, ?)`)
          .bind(submissionId, userA, current)
          .run()
      );
      return { db, bucket };
    })
  );

afterAll(() => storage.dispose());

effectIt.effect(
  "finalizes parsed XLSX rows once without decoding their optional cell metadata twice",
  () =>
    Effect.gen(function* () {
      const bytes = yield* fromTestPromise(() =>
        Bun.file(
          new URL(
            "../../src/shell/ingestion/internal/fixtures/synthetic-statement.xlsx",
            import.meta.url
          )
        ).bytes()
      );
      const { db, bucket } = yield* fromTestPromise(() => setup(bytes, "xlsx"));
      const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
      yield* processStatementSubmission(input);
      yield* processStatementSubmission(input);
      const state = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT status, input_rows, needs_review_rows FROM statement_submissions WHERE id = ?"
          )
          .bind(submissionId)
          .first()
      );
      expect(state).toMatchObject({ status: "completed", input_rows: 2, needs_review_rows: 2 });
      const reviews = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT original_evidence FROM statement_needs_review WHERE user_id = ? ORDER BY record_number"
          )
          .bind(userA)
          .all()
      );
      expect(reviews.results).toHaveLength(2);
      expect(reviews.results[1]?.original_evidence).toContain("12500*2");
    })
);

effectIt.effect(
  "extends clarification with session activity but never resumes an abandoned origin",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() =>
        setup("date,amount,description\nunclear,unknown,Cafe\n")
      );
      const now = currentMillis();
      const sessionId = "session-a";
      const idleMs = 900_000;
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_hosted_origins (submission_id,user_id,session_id,turn_id,expires_at_ms) VALUES (?,?,?,?,?)"
          )
          .bind(submissionId, userA, sessionId, "upload-turn", now + idleMs)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)"
          )
          .bind(userA, submissionId)
          .run()
      );
      yield* processStatementSubmission({
        DB: db,
        STATEMENT_STAGING_BUCKET: bucket,
        userId: userA,
        submissionId,
      });
      const activity = (at: number, expiry: number): Promise<unknown> =>
        db.batch([
          ...prepareStatementSessionActivity({
            db,
            userId: userA,
            current: at,
            source: {
              sql: "SELECT ? AS session_id, ? AS user_id, ? AS expires_at_ms",
              params: [sessionId, userA, expiry],
            },
          }),
        ]);
      yield* fromTestPromise(() => activity(now + 1000, now + idleMs + 1000));
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT state,expires_at_ms FROM statement_clarifications WHERE submission_id = ?"
            )
            .bind(submissionId)
            .first()
        )
      ).toEqual({ state: "awaiting", expires_at_ms: now + idleMs + 1000 });
      yield* fromTestPromise(() => activity(now + idleMs + 1000, now + 2 * idleMs));
      yield* fromTestPromise(() => activity(now + idleMs + 1001, now + 3 * idleMs));
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare("SELECT state FROM statement_clarifications WHERE submission_id = ?")
            .bind(submissionId)
            .first()
        )
      ).toEqual({ state: "abandoned" });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT original_evidence,known_money FROM statement_needs_review WHERE submission_id = ?"
            )
            .bind(submissionId)
            .first()
        )
      ).toEqual({ original_evidence: null, known_money: null });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT submission_id,consumed_at_ms FROM statement_backfill_entitlements WHERE user_id = ?"
            )
            .bind(userA)
            .first()
        )
      ).toEqual({ submission_id: null, consumed_at_ms: null });
    })
);

effectIt.effect("holds a zero-capture Free reservation while rows await clarification", () =>
  Effect.gen(function* () {
    const { db, bucket } = yield* fromTestPromise(() =>
      setup("date,amount,description\nunclear,unknown,Cafe\n")
    );
    yield* fromTestPromise(() =>
      db
        .prepare(
          "INSERT INTO statement_backfill_entitlements (user_id, submission_id) VALUES (?, ?)"
        )
        .bind(userA, submissionId)
        .run()
    );
    yield* processStatementSubmission({
      DB: db,
      STATEMENT_STAGING_BUCKET: bucket,
      userId: userA,
      submissionId,
    });
    const entitlement = yield* fromTestPromise(() =>
      db
        .prepare(
          "SELECT submission_id, consumed_at_ms FROM statement_backfill_entitlements WHERE user_id = ?"
        )
        .bind(userA)
        .first()
    );
    expect(entitlement).toEqual({ submission_id: submissionId, consumed_at_ms: null });
  })
);

effectIt.effect(
  "clears all expired raw review evidence even when more than a hundred rows expire together",
  () =>
    Effect.gen(function* () {
      const { db } = yield* fromTestPromise(() =>
        setup("fecha,valor,descripcion\n2026-08-01,-1,Cafe\n")
      );
      const expiredAt = (yield* Clock.currentTimeMillis) - 1_000;
      yield* fromTestPromise(() =>
        db
          .prepare(`WITH RECURSIVE numbered(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM numbered WHERE n < 101
  ) INSERT INTO statement_needs_review
    (id,user_id,submission_id,record_number,reason,original_evidence,known_money,
      issues,status,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,
      source_format,parser_revision,extractor_revision)
    SELECT printf('40000000-0000-4000-8000-%012d', n), ?, ?, n, 'mapping-unavailable',
      '{"sourceFormat":"csv"}', NULL, '[]', 'pending', ?, ?, 'CO', 'es-CO',
      'America/Bogota', 'csv', 'statement-parser-v1', 'statement-mechanical-v1'
    FROM numbered`)
          .bind(userA, submissionId, expiredAt, expiredAt)
          .run()
      );
      yield* expireStatementReviewEvidence({ DB: db });
      const pending = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT count(*) AS count FROM statement_needs_review
    WHERE status = 'pending' OR original_evidence IS NOT NULL`)
          .first<{ count: number }>()
      );
      const expired = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT count(*) AS count FROM statement_needs_review
    WHERE status = 'expired'`)
          .first<{ count: number }>()
      );
      expect(pending?.count).toBe(0);
      expect(expired?.count).toBe(101);
    })
);

effectIt.effect(
  "fails an accepted header-only non-statement rather than claiming empty completion",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() => setup("not,a,statement\n"));
      expect(
        yield* processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: userA,
          submissionId,
        })
      ).toBe("completed");
      const state = yield* fromTestPromise(() =>
        db
          .prepare("SELECT status,failure_reason FROM statement_submissions WHERE id = ?")
          .bind(submissionId)
          .first<{ status: string; failure_reason: string }>()
      );
      expect(state).toMatchObject({ status: "failed", failure_reason: "malformed-file" });
      const results = yield* fromTestPromise(() =>
        db
          .prepare("SELECT count(*) AS count FROM statement_record_outcomes")
          .first<{ count: number }>()
      );
      expect(results?.count).toBe(0);
    })
);

effectIt.effect(
  "rejects another User's submission without changing any financial or submission state",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() =>
        setup("fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n")
      );
      yield* processStatementSubmission({
        DB: db,
        STATEMENT_STAGING_BUCKET: bucket,
        userId: userB,
        submissionId,
      });
      yield* failStatementSubmission({
        DB: db,
        userId: userB,
        submissionId,
        reason: "resource-limit",
      });
      const outbox = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT user_id, revision FROM statement_ingestion_outbox WHERE submission_id = ?"
          )
          .bind(submissionId)
          .first()
      );
      expect(outbox).toEqual({ user_id: userA, revision: 1 });
      const status = yield* fromTestPromise(() =>
        db
          .prepare("SELECT status FROM statement_submissions WHERE id = ?")
          .bind(submissionId)
          .first<{ status: string }>()
      );
      const total = yield* fromTestPromise(() =>
        db.prepare("SELECT count(*) AS count FROM transactions").first<{ count: number }>()
      );
      expect(status?.status).toBe("queued");
      expect(total?.count).toBe(0);
    })
);

effectIt.effect(
  "finalizes a known mapping once with one unique statement-line attestation after replay",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() =>
        setup("fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n")
      );
      const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
      yield* processStatementSubmission(input);
      yield* processStatementSubmission(input);
      const result = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT s.status, s.accepted_rows, s.needs_review_rows,
    (SELECT count(*) FROM source_attestations WHERE statement_submission_id = s.id) AS attestations
    FROM statement_submissions s WHERE s.id = ?`)
          .bind(submissionId)
          .first<{
            status: string;
            accepted_rows: number;
            needs_review_rows: number;
            attestations: number;
          }>()
      );
      expect(result).toMatchObject({
        status: "completed",
        accepted_rows: 1,
        needs_review_rows: 0,
        attestations: 1,
      });
    })
);

effectIt.effect(
  "retains the Free reservation when extraction finishes with clarification pending",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() =>
        setup("fecha,valor,descripcion\n2026-08-01,-45000,Cafe\n")
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)"
          )
          .bind(userA, submissionId)
          .run()
      );
      yield* processStatementSubmission({
        DB: db,
        STATEMENT_STAGING_BUCKET: bucket,
        userId: userA,
        submissionId,
      });
      const grant = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT consumed_at_ms,submission_id FROM statement_backfill_entitlements WHERE user_id = ?"
          )
          .bind(userA)
          .first<{ consumed_at_ms: unknown; submission_id: unknown }>()
      );
      expect(grant).toMatchObject({ consumed_at_ms: null, submission_id: submissionId });
    })
);

effectIt.effect(
  "consumes the Free grant on first capture before extraction completes and preserves it after failure",
  () =>
    Effect.gen(function* () {
      const csv =
        "fecha,valor,moneda,contraparte\n" +
        Array.from({ length: 33 }, () => "2026-08-01,-45000,COP,Cafe").join("\n") +
        "\n";
      const { db, bucket } = yield* fromTestPromise(() => setup(csv));
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)"
          )
          .bind(userA, submissionId)
          .run()
      );
      expect(
        yield* processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: userA,
          submissionId,
        })
      ).toBe("continue");
      const readGrant = (): Promise<{
        consumed_at_ms: unknown;
        submission_id: unknown;
      }> =>
        db
          .prepare(
            "SELECT consumed_at_ms,submission_id FROM statement_backfill_entitlements WHERE user_id = ?"
          )
          .bind(userA)
          .first<{ consumed_at_ms: unknown; submission_id: unknown }>()
          .then((row) => Option.getOrThrow(Option.fromNullishOr(row)));
      const captured = yield* fromTestPromise(readGrant);
      expect(captured.consumed_at_ms).toEqual(expect.any(Number));
      expect(captured.submission_id).toBe(submissionId);
      yield* failStatementSubmission({
        DB: db,
        userId: userA,
        submissionId,
        reason: "resource-limit",
      });
      expect(yield* fromTestPromise(readGrant)).toEqual(captured);
    })
);

effectIt.effect(
  "a rolled-back capture leaves the Free grant reserved and creates no financial effects",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() =>
        setup("fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n")
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)"
          )
          .bind(userA, submissionId)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`CREATE TRIGGER reject_capture_commit
        BEFORE INSERT ON statement_submission_assertion
        BEGIN SELECT RAISE(ABORT, 'capture unavailable'); END`)
          .run()
      );
      const result = yield* Effect.exit(
        processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: userA,
          submissionId,
        })
      );
      deepStrictEqual(result, Exit.fail(new StatementProcessingUnavailable()));
      const grant = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT consumed_at_ms,submission_id FROM statement_backfill_entitlements WHERE user_id = ?"
          )
          .bind(userA)
          .first<{ consumed_at_ms: unknown; submission_id: unknown }>()
      );
      expect(grant).toMatchObject({ consumed_at_ms: null, submission_id: submissionId });
      const counts = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT
        (SELECT count(*) FROM transactions) AS transactions,
        (SELECT count(*) FROM source_attestations) AS attestations,
        (SELECT count(*) FROM statement_record_outcomes) AS outcomes`)
          .first<{
            transactions: number;
            attestations: number;
            outcomes: number;
          }>()
      );
      expect(counts).toEqual({ transactions: 0, attestations: 0, outcomes: 0 });
    })
);

effectIt.effect(
  "applies a User keyword Category and the inflow fallback at statement capture",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() =>
        setup(
          "fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n2026-08-02,35000,COP,Salario\n"
        )
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO keyword_rules
    (id,user_id,keyword,normalized_keyword,category_id,created_at,updated_at)
    VALUES (?,?, 'Cafe', 'cafe', ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`)
          .bind(
            "30000000-0000-4000-8000-000000000699",
            userA,
            "10000000-0000-4000-8000-000000000001"
          )
          .run()
      );
      yield* processStatementSubmission({
        DB: db,
        STATEMENT_STAGING_BUCKET: bucket,
        userId: userA,
        submissionId,
      });
      const categories = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT a.statement_record_number AS record_number,
    t.category_id FROM source_attestations a
    JOIN transactions t ON t.id = a.transaction_id
    WHERE a.statement_submission_id = ? ORDER BY a.statement_record_number`)
          .bind(submissionId)
          .all<{ record_number: number; category_id: string }>()
      );
      expect(categories.results.map(({ category_id }) => category_id)).toEqual([
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000015",
      ]);
    })
);

effectIt.effect(
  "a crash after a committed row resumes at the durable cursor without duplicate Transactions",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() =>
        setup(
          "fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n2026-08-02,-50000,COP,Tienda\n"
        )
      );
      let batches = 0;
      const interruptedDB = new Proxy(db, {
        get(target, key): unknown {
          const method: unknown = Reflect.get(target, key);
          if (key === "batch") {
            return (...args: Parameters<D1Database["batch"]>): ReturnType<D1Database["batch"]> => {
              batches++;
              if (batches === 3) {
                throw new Error("simulated interruption before second row commit");
              }
              return target.batch(...args);
            };
          }
          return typeof method === "function" ? method.bind(target) : method;
        },
      });
      const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
      const interrupted = yield* Effect.exit(
        processStatementSubmission({ ...input, DB: interruptedDB })
      );
      deepStrictEqual(interrupted, Exit.fail(new StatementProcessingUnavailable()));
      const first = yield* fromTestPromise(() =>
        db.prepare("SELECT count(*) AS count FROM transactions").first<{ count: number }>()
      );
      expect(first?.count).toBe(1);
      expect(yield* processStatementSubmission(input)).toBe("completed");
      const counts = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT
    (SELECT count(*) FROM transactions WHERE user_id = ?) AS transactions,
    (SELECT count(*) FROM source_attestations WHERE statement_submission_id = ?) AS attestations,
    (SELECT count(*) FROM statement_record_outcomes WHERE submission_id = ?) AS outcomes`)
          .bind(userA, submissionId, submissionId)
          .first<{ transactions: number; attestations: number; outcomes: number }>()
      );
      expect(counts).toMatchObject({ transactions: 2, attestations: 2, outcomes: 2 });
    })
);

effectIt.effect(
  "simultaneous finalization attempts remain idempotent after a retried loser",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() =>
        setup("fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n")
      );
      const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
      yield* Effect.all(
        [
          Effect.exit(processStatementSubmission(input)),
          Effect.exit(processStatementSubmission(input)),
        ],
        { concurrency: 2 }
      );
      expect(yield* processStatementSubmission(input)).toBe("completed");
      const counts = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT
    (SELECT count(*) FROM transactions WHERE user_id = ?) AS transactions,
    (SELECT count(*) FROM source_attestations WHERE statement_submission_id = ?) AS attestations,
    (SELECT count(*) FROM statement_record_outcomes WHERE submission_id = ?) AS outcomes`)
          .bind(userA, submissionId, submissionId)
          .first<{ transactions: number; attestations: number; outcomes: number }>()
      );
      expect(counts).toMatchObject({ transactions: 1, attestations: 1, outcomes: 1 });
    }),
  15_000
);

effectIt.effect(
  "retains unmapped source rows as review evidence rather than inventing a Currency",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() =>
        setup("fecha,valor,descripcion\n2026-08-01,-45000,Cafe\n")
      );
      yield* processStatementSubmission({
        DB: db,
        STATEMENT_STAGING_BUCKET: bucket,
        userId: userA,
        submissionId,
      });
      const item = yield* fromTestPromise(() =>
        db
          .prepare("SELECT reason, original_evidence FROM statement_needs_review WHERE user_id = ?")
          .bind(userA)
          .first<{ reason: string; original_evidence: string }>()
      );
      expect(item?.reason).toBe("mapping-unavailable");
      expect(item?.original_evidence).toContain("-45000");
      const transaction = yield* fromTestPromise(() =>
        db
          .prepare("SELECT count(*) AS count FROM transactions WHERE user_id = ?")
          .bind(userA)
          .first<{ count: number }>()
      );
      expect(transaction?.count).toBe(0);
    })
);

effectIt.effect(
  "records interrupted work as a closed terminal failure and releases the Free reservation atomically",
  () =>
    Effect.gen(function* () {
      const { db } = yield* fromTestPromise(() =>
        setup("fecha,valor,descripcion\n2026-08-01,-45000,Cafe\n")
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)"
          )
          .bind(userA, submissionId)
          .run()
      );
      yield* failStatementSubmission({
        DB: db,
        userId: userA,
        submissionId,
        reason: "resource-limit",
      });
      yield* failStatementSubmission({
        DB: db,
        userId: userA,
        submissionId,
        reason: "resource-limit",
      });
      const state = yield* fromTestPromise(() =>
        db
          .prepare("SELECT status,failure_reason FROM statement_submissions WHERE id = ?")
          .bind(submissionId)
          .first<{ status: string; failure_reason: string }>()
      );
      const reservation = yield* fromTestPromise(() =>
        db
          .prepare("SELECT submission_id FROM statement_backfill_entitlements WHERE user_id = ?")
          .bind(userA)
          .first<{ submission_id: unknown }>()
      );
      expect(state).toMatchObject({ status: "failed", failure_reason: "resource-limit" });
      expect(reservation?.submission_id).toBeNull();
    })
);

effectIt.effect("does not regress a completed submission when a delayed failure arrives", () =>
  Effect.gen(function* () {
    const { db, bucket } = yield* fromTestPromise(() =>
      setup("fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n")
    );
    yield* processStatementSubmission({
      DB: db,
      STATEMENT_STAGING_BUCKET: bucket,
      userId: userA,
      submissionId,
    });
    yield* failStatementSubmission({
      DB: db,
      userId: userA,
      submissionId,
      reason: "resource-limit",
    });
    const state = yield* fromTestPromise(() =>
      db
        .prepare("SELECT status,failure_reason FROM statement_submissions WHERE id = ?")
        .bind(submissionId)
        .first<{ status: string; failure_reason: unknown }>()
    );
    expect(state).toMatchObject({ status: "completed", failure_reason: null });
  })
);

effectIt.effect(
  "commits only 32 rows per call and exposes conserved partial counts on interruption",
  () =>
    Effect.gen(function* () {
      const csv =
        "fecha,valor,descripcion\n" +
        Array.from({ length: 33 }, (_, index) => `2026-08-01,-${index + 1},Cafe`).join("\n") +
        "\n";
      const { db, bucket } = yield* fromTestPromise(() => setup(csv));
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)"
          )
          .bind(userA, submissionId)
          .run()
      );
      const progress = yield* processStatementSubmission({
        DB: db,
        STATEMENT_STAGING_BUCKET: bucket,
        userId: userA,
        submissionId,
      });
      expect(progress).toBe("continue");
      const before = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT count(*) AS count FROM statement_record_outcomes WHERE submission_id = ?"
          )
          .bind(submissionId)
          .first<{ count: number }>()
      );
      expect(before?.count).toBe(32);
      yield* failStatementSubmission({
        DB: db,
        userId: userA,
        submissionId,
        reason: "resource-limit",
      });
      const state = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT status,input_rows,accepted_rows,needs_review_rows FROM statement_submissions WHERE id = ?"
          )
          .bind(submissionId)
          .first<{
            status: string;
            input_rows: number;
            accepted_rows: number;
            needs_review_rows: number;
          }>()
      );
      const entitlement = yield* fromTestPromise(() =>
        db
          .prepare("SELECT consumed_at_ms FROM statement_backfill_entitlements WHERE user_id = ?")
          .bind(userA)
          .first<{ consumed_at_ms: unknown }>()
      );
      expect(state).toMatchObject({
        status: "failed",
        input_rows: 32,
        accepted_rows: 0,
        needs_review_rows: 32,
      });
      const staging = StatementStaging.make({ database: db, bucket, nowEpochMs: currentMillis });
      const stored = yield* staging.readOwnedStatementSubmission({ userId: userA, submissionId });
      expect(Option.isSome(stored)).toBe(true);
      if (Option.isSome(stored)) {
        const projected = submissionProjection(stored.value);
        expect(
          Option.isSome(projected) &&
            projected.value.status === "failed" &&
            projected.value.accounting
        ).toMatchObject({ inputRows: 32, acceptedRows: 0, needsReviewRows: 0, abandonedRows: 32 });
      }
      expect(entitlement?.consumed_at_ms).toBeNull();
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM statement_needs_review WHERE submission_id = ? AND (status='pending' OR original_evidence IS NOT NULL OR known_money IS NOT NULL)"
            )
            .bind(submissionId)
            .first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM statement_review_decisions WHERE submission_id = ? AND decision='abandoned'"
            )
            .bind(submissionId)
            .first()
        )
      ).toEqual({ count: 32 });
    })
);

effectIt.effect(
  "resumes at the durable cursor and completes a second bounded chunk without duplicates",
  () =>
    Effect.gen(function* () {
      const csv =
        "fecha,valor,descripcion\n" +
        Array.from({ length: 33 }, () => "2026-08-01,-1,Cafe").join("\n") +
        "\n";
      const { db, bucket } = yield* fromTestPromise(() => setup(csv));
      const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
      expect(yield* processStatementSubmission(input)).toBe("continue");
      expect(yield* processStatementSubmission(input)).toBe("completed");
      expect(yield* processStatementSubmission(input)).toBe("completed");
      const result = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT status,input_rows,needs_review_rows FROM statement_submissions WHERE id = ?"
          )
          .bind(submissionId)
          .first<{ status: string; input_rows: number; needs_review_rows: number }>()
      );
      expect(result).toMatchObject({ status: "completed", input_rows: 33, needs_review_rows: 33 });
    })
);

effectIt.effect(
  "continues past three bounded chunks without losing or duplicating outcomes",
  () =>
    Effect.gen(function* () {
      const csv =
        "fecha,valor,descripcion\n" +
        Array.from({ length: 97 }, () => "2026-08-01,-1,Cafe").join("\n") +
        "\n";
      const { db, bucket } = yield* fromTestPromise(() => setup(csv));
      const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
      expect(yield* processStatementSubmission(input)).toBe("continue");
      expect(yield* processStatementSubmission(input)).toBe("continue");
      expect(yield* processStatementSubmission(input)).toBe("continue");
      expect(yield* processStatementSubmission(input)).toBe("completed");
      const state = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT status,input_rows,needs_review_rows FROM statement_submissions WHERE id = ?"
          )
          .bind(submissionId)
          .first<{ status: string; input_rows: number; needs_review_rows: number }>()
      );
      expect(state).toMatchObject({ status: "completed", input_rows: 97, needs_review_rows: 97 });
      const outcomes = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT count(*) AS count FROM statement_record_outcomes WHERE submission_id = ?"
          )
          .bind(submissionId)
          .first<{ count: number }>()
      );
      expect(outcomes?.count).toBe(97);
    }),
  15_000
);

effectIt.effect("fails above the parser row ceiling without creating partial effects", () =>
  Effect.gen(function* () {
    const csv =
      "fecha,valor,descripcion\n" +
      Array.from(
        { length: statementParserLimits.maximumRows + 1 },
        () => "2026-08-01,-1,Cafe"
      ).join("\n") +
      "\n";
    const { db, bucket } = yield* fromTestPromise(() => setup(csv));
    expect(
      yield* processStatementSubmission({
        DB: db,
        STATEMENT_STAGING_BUCKET: bucket,
        userId: userA,
        submissionId,
      })
    ).toBe("completed");
    const state = yield* fromTestPromise(() =>
      db
        .prepare("SELECT status,failure_reason FROM statement_submissions WHERE id = ?")
        .bind(submissionId)
        .first<{ status: string; failure_reason: string }>()
    );
    expect(state).toMatchObject({ status: "failed", failure_reason: "resource-limit" });
    const results = yield* fromTestPromise(() =>
      db
        .prepare("SELECT count(*) AS count FROM statement_record_outcomes WHERE submission_id = ?")
        .bind(submissionId)
        .first<{ count: number }>()
    );
    expect(results?.count).toBe(0);
  })
);

effectIt.effect(
  "retention failure preserves partial review accounting without consuming the Free grant",
  () =>
    Effect.gen(function* () {
      const csv =
        "fecha,valor,descripcion\n" +
        Array.from({ length: 33 }, () => "2026-08-01,-1,Cafe").join("\n") +
        "\n";
      const { db, bucket } = yield* fromTestPromise(() => setup(csv));
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)"
          )
          .bind(userA, submissionId)
          .run()
      );
      expect(
        yield* processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: userA,
          submissionId,
        })
      ).toBe("continue");
      const expired = StatementStaging.make({
        database: db,
        bucket,
        nowEpochMs: () => currentMillis() + retentionMs + 1000,
      });
      yield* expired.expireStatementSubmissions;
      const state = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT status,input_rows,needs_review_rows FROM statement_submissions WHERE id = ?"
          )
          .bind(submissionId)
          .first<{ status: string; input_rows: number; needs_review_rows: number }>()
      );
      const entitlement = yield* fromTestPromise(() =>
        db
          .prepare("SELECT consumed_at_ms FROM statement_backfill_entitlements WHERE user_id = ?")
          .bind(userA)
          .first<{ consumed_at_ms: unknown }>()
      );
      expect(state).toMatchObject({ status: "failed", input_rows: 32, needs_review_rows: 32 });
      expect(entitlement?.consumed_at_ms).toBeNull();
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM statement_materializations").first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM statement_materialization_parts").first()
        )
      ).toEqual({ count: 0 });
    })
);

effectIt.effect("uses the owner Clock to expire statement work before any row commits", () =>
  Effect.gen(function* () {
    const { db, bucket } = yield* fromTestPromise(() =>
      setup("fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n")
    );
    const ownerNow = currentMillis() + retentionMs + 1000;
    const liveClock = yield* Clock.Clock;
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => ownerNow,
      currentTimeMillis: Effect.succeed(ownerNow),
      currentTimeNanosUnsafe: () => BigInt(ownerNow) * 1000000n,
      currentTimeNanos: Effect.succeed(BigInt(ownerNow) * 1000000n),
      monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: liveClock.monotonicTimeNanos,
      sleep: (duration) => liveClock.sleep(duration),
    };
    yield* processStatementSubmission({
      DB: db,
      STATEMENT_STAGING_BUCKET: bucket,
      userId: userA,
      submissionId,
    }).pipe(Effect.provideService(Clock.Clock, clock));
    const state = yield* fromTestPromise(() =>
      db
        .prepare(
          "SELECT status, failure_reason, completed_at_ms FROM statement_submissions WHERE id = ?"
        )
        .bind(submissionId)
        .first()
    );
    const counts = yield* fromTestPromise(() =>
      db.prepare("SELECT count(*) AS count FROM transactions WHERE user_id = ?").bind(userA).first()
    );
    expect(state).toMatchObject({
      status: "failed",
      failure_reason: "retention-expired",
      completed_at_ms: ownerNow,
    });
    expect(counts).toMatchObject({ count: 0 });
  })
);

it.each(["completed", "failed"] as const)(
  "rolls back %s settlement when outbox acknowledgment fails and resumes without duplicate output",
  (terminalStatus) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, bucket } = yield* fromTestPromise(() =>
          setup("fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n")
        );
        const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
        yield* fromTestPromise(() =>
          db
            .prepare(`CREATE TRIGGER reject_statement_ack
      BEFORE DELETE ON statement_ingestion_outbox
      BEGIN SELECT RAISE(ABORT, 'ack unavailable'); END`)
            .run()
        );
        const settle =
          terminalStatus === "completed"
            ? processStatementSubmission(input).pipe(Effect.asVoid)
            : failStatementSubmission({ ...input, reason: "resource-limit" });
        deepStrictEqual(
          yield* Effect.exit(settle),
          Exit.fail(new StatementProcessingUnavailable())
        );
        const pending = yield* fromTestPromise(() =>
          db
            .prepare(`SELECT status,
      (SELECT count(*) FROM statement_ingestion_outbox WHERE submission_id = ?) AS pending
      FROM statement_submissions WHERE id = ?`)
            .bind(submissionId, submissionId)
            .first()
        );
        expect(pending).toEqual({
          status: terminalStatus === "completed" ? "processing" : "queued",
          pending: 1,
        });
        yield* fromTestPromise(() => db.prepare("DROP TRIGGER reject_statement_ack").run());
        yield* settle;
        yield* settle;
        const finished = yield* fromTestPromise(() =>
          db
            .prepare(`SELECT status,
      (SELECT count(*) FROM statement_ingestion_outbox WHERE submission_id = ?) AS pending,
      (SELECT count(*) FROM source_attestations WHERE statement_submission_id = ?) AS attestations
      FROM statement_submissions WHERE id = ?`)
            .bind(submissionId, submissionId, submissionId)
            .first()
        );
        expect(finished).toEqual({
          status: terminalStatus,
          pending: 0,
          attestations: terminalStatus === "completed" ? 1 : 0,
        });
      })
    )
);

const observeStatementReads = (
  bucket: R2Bucket
): { observed: { heads: number; gets: number; bytes: number }; bucket: R2Bucket } => {
  const observed = { heads: 0, gets: 0, bytes: 0 };
  const instrumented = new Proxy(bucket, {
    get(target, property): unknown {
      if (property === "head") {
        return (...args: Parameters<R2Bucket["head"]>): ReturnType<R2Bucket["head"]> => {
          observed.heads += 1;
          return target.head(...args);
        };
      }
      if (property === "get") {
        return (...args: Parameters<R2Bucket["get"]>): ReturnType<R2Bucket["get"]> =>
          target.get(...args).then((object) => {
            observed.gets += 1;
            observed.bytes += object?.size ?? 0;
            return object;
          });
      }
      const method: unknown = Reflect.get(target, property, target);
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
  return { observed, bucket: instrumented };
};
const boundedStatementCsv = (): string =>
  "fecha,valor,moneda,contraparte\n" +
  Array.from({ length: 97 }, (_, index) => `2026-08-01,-${index + 1},COP,Cafe`).join("\n") +
  "\n";

effectIt.effect(
  "reads the original once while finalizing 97 rows exactly once across restarts",
  () =>
    Effect.gen(function* () {
      const csv = boundedStatementCsv();
      const { db, bucket } = yield* fromTestPromise(() => setup(csv));
      const monitored = observeStatementReads(bucket);
      const input = {
        DB: db,
        STATEMENT_STAGING_BUCKET: monitored.bucket,
        userId: userA,
        submissionId,
      };
      expect(yield* processStatementSubmission({ ...input, userId: userB })).toBe("completed");
      expect(monitored.observed).toEqual({ heads: 0, gets: 0, bytes: 0 });
      for (const expected of ["continue", "continue", "continue", "completed"]) {
        expect(yield* processStatementSubmission(input)).toBe(expected);
      }
      expect(yield* processStatementSubmission(input)).toBe("completed");
      expect(monitored.observed).toEqual({
        heads: 1,
        gets: 1,
        bytes: new TextEncoder().encode(csv).byteLength,
      });
      const counts = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT
        (SELECT count(*) FROM transactions WHERE user_id = ?) AS transactions,
        (SELECT count(*) FROM source_attestations WHERE statement_submission_id = ?) AS attestations,
        (SELECT count(*) FROM statement_record_outcomes WHERE submission_id = ?) AS outcomes`)
          .bind(userA, submissionId, submissionId)
          .first()
      );
      expect(counts).toEqual({ transactions: 97, attestations: 97, outcomes: 97 });
    }),
  30_000
);

effectIt.effect(
  "recovers partial materialization once and publishes a lost write response without duplicate captures",
  () =>
    Effect.gen(function* () {
      const csv = boundedStatementCsv();
      const { db, bucket } = yield* fromTestPromise(() => setup(csv));
      const monitored = observeStatementReads(bucket);
      let attempts = 0;
      const interruptedDB = new Proxy(db, {
        get(target, property): unknown {
          if (property === "batch") {
            return (...args: Parameters<D1Database["batch"]>): ReturnType<D1Database["batch"]> => {
              attempts += 1;
              if (attempts === 1) {
                return Promise.reject(new Error("Synthetic failure before commit"));
              }
              if (attempts === 2) {
                return target.batch(...args).then(() => {
                  throw new Error("Synthetic lost response after commit");
                });
              }
              return target.batch(...args);
            };
          }
          const method: unknown = Reflect.get(target, property, target);
          return typeof method === "function" ? method.bind(target) : method;
        },
      });
      const input = {
        DB: interruptedDB,
        STATEMENT_STAGING_BUCKET: monitored.bucket,
        userId: userA,
        submissionId,
      };
      for (let index = 0; index < 2; index += 1) {
        deepStrictEqual(
          yield* Effect.exit(processStatementSubmission(input)),
          Exit.fail(new StatementProcessingUnavailable())
        );
      }
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM transactions").first()
        )
      ).toEqual({ count: 0 });
      for (const expected of ["continue", "continue", "continue", "completed"]) {
        expect(yield* processStatementSubmission(input)).toBe(expected);
      }
      expect(yield* processStatementSubmission(input)).toBe("completed");
      expect(monitored.observed).toEqual({
        heads: 2,
        gets: 2,
        bytes: new TextEncoder().encode(csv).byteLength * 2,
      });
      const counts = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT
        (SELECT count(*) FROM transactions WHERE user_id = ?) AS transactions,
        (SELECT count(*) FROM source_attestations WHERE statement_submission_id = ?) AS attestations,
        (SELECT count(*) FROM statement_record_outcomes WHERE submission_id = ?) AS outcomes`)
          .bind(userA, submissionId, submissionId)
          .first()
      );
      expect(counts).toEqual({ transactions: 97, attestations: 97, outcomes: 97 });
    }),
  30_000
);

effectIt.effect(
  "settles an oversized review after 33 captures without retrying or undoing them",
  () =>
    Effect.gen(function* () {
      const source = yield* fromTestPromise(() =>
        Bun.file(
          new URL(
            "../../src/shell/ingestion/internal/fixtures/shared-string-review.xlsx",
            import.meta.url
          )
        ).bytes()
      );
      const { db, bucket } = yield* fromTestPromise(() => setup(source, "xlsx"));
      yield* fromTestPromise(() =>
        applyTestMigration({
          db,
          source: new URL("../migrations/0036_statement_whatsapp_documents.sql", import.meta.url),
        })
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)"
          )
          .bind(userA, submissionId)
          .run()
      );
      const monitored = observeStatementReads(bucket);
      const input = {
        DB: db,
        STATEMENT_STAGING_BUCKET: monitored.bucket,
        userId: userA,
        submissionId,
      };
      expect(yield* processStatementSubmission(input)).toBe("continue");
      expect(yield* processStatementSubmission(input)).toBe("completed");
      expect(yield* processStatementSubmission(input)).toBe("completed");
      const state = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT status,failure_reason,
      input_rows,accepted_rows,needs_review_rows FROM statement_submissions WHERE id=?`)
          .bind(submissionId)
          .first()
      );
      expect(state).toEqual({
        status: "failed",
        failure_reason: "resource-limit",
        input_rows: 33,
        accepted_rows: 33,
        needs_review_rows: 0,
      });
      const counts = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT
      (SELECT count(*) FROM transactions) AS transactions,
      (SELECT count(*) FROM source_attestations) AS attestations,
      (SELECT count(*) FROM statement_record_outcomes) AS outcomes,
      (SELECT count(*) FROM statement_needs_review) AS reviews`)
          .first()
      );
      expect(counts).toEqual({ transactions: 33, attestations: 33, outcomes: 33, reviews: 0 });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT submission_id,consumed_at_ms IS NOT NULL AS consumed FROM statement_backfill_entitlements WHERE user_id=?"
            )
            .bind(userA)
            .first()
        )
      ).toEqual({ submission_id: submissionId, consumed: 1 });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare(`SELECT status,published_submission_id
      FROM statement_staging_objects WHERE id=?`)
            .bind(stagingId)
            .first()
        )
      ).toEqual({ status: "deleting", published_submission_id: null });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare(`SELECT count(*) AS count
      FROM statement_ingestion_outbox WHERE submission_id=?`)
            .bind(submissionId)
            .first()
        )
      ).toEqual({ count: 0 });
      expect(monitored.observed).toEqual({ heads: 1, gets: 1, bytes: source.byteLength });
    })
);

effectIt.effect(
  "keeps oversized inert XLSX evidence valid when only Transactions are persisted",
  () =>
    Effect.gen(function* () {
      const source = yield* fromTestPromise(() =>
        Bun.file(
          new URL(
            "../../src/shell/ingestion/internal/fixtures/shared-string-accepted.xlsx",
            import.meta.url
          )
        ).bytes()
      );
      const { db, bucket } = yield* fromTestPromise(() => setup(source, "xlsx"));
      const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
      expect(yield* processStatementSubmission(input)).toBe("continue");
      expect(yield* processStatementSubmission(input)).toBe("completed");
      const state = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT status,input_rows,accepted_rows,
      needs_review_rows FROM statement_submissions WHERE id=?`)
          .bind(submissionId)
          .first()
      );
      expect(state).toEqual({
        status: "completed",
        input_rows: 34,
        accepted_rows: 34,
        needs_review_rows: 0,
      });
      const attested = yield* fromTestPromise(() =>
        db
          .prepare(`SELECT count(*) AS count FROM source_attestations a
      JOIN statement_staging_objects s ON s.id=? WHERE a.statement_submission_id=?
      AND a.user_id=? AND a.statement_content_hash=s.sha256 AND a.source_format='xlsx'`)
          .bind(stagingId, submissionId, userA)
          .first()
      );
      expect(attested).toEqual({ count: 34 });
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM statement_needs_review").first()
        )
      ).toEqual({ count: 0 });
    })
);

effectIt.effect(
  "admits the documented complete-row boundary and inserts admitted records natively",
  () =>
    Effect.gen(function* () {
      const raw = "\u0001".repeat(166_000) + "x".repeat(3_806);
      const context = {
        userId: userA,
        submissionId,
        serviceMarket: "CO",
        locale: "es-CO",
        timeZone: "America/Bogota",
        sourceFormat: "csv" as const,
        parserRevision: "statement-parser-v1",
        extractorRevision: "statement-mechanical-v1",
        expiresAt: 1_800_086_400_000,
        createdAt: 1_800_000_000_000,
      };
      for (const [extra, expected] of [
        [0, true],
        [1, true],
        [2, false],
      ] as const) {
        const { db } = yield* fromTestPromise(() => setup("Header\nvalue"));
        const row: NeedsReviewStatementRow = {
          outcome: "needs-review",
          recordNumber: 1,
          reason: "mapping-unavailable",
          knownMoney: Option.none(),
          issues: [{ path: "", message: `Statement mapping is unavailable.${" ".repeat(extra)}` }],
          evidence: {
            sourceFormat: "csv",
            recordNumber: 1,
            startLine: 2,
            endLine: 2,
            rawRecord: raw,
            fields: [raw],
          },
        };
        const evidence = yield* Schema.encodeEffect(Schema.fromJsonString(StatementRowEvidence))(
          row.evidence
        );
        const issues = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Array(CapturedFieldIssue))
        )(row.issues);
        expect(new TextEncoder().encode(evidence).byteLength).toBe(1_999_706);
        expect(new TextEncoder().encode(issues).byteLength).toBe(59 + extra);
        expect(statementReviewAdmission(context)(row)).toBe(expected);
        if (!expected) continue;
        // Exercise actual D1 record encoding, independently of the production preflight. All
        // values are bounded synthetic data; do not expose the provider's raw exception.
        const inserted = yield* Effect.exit(
          Effect.tryPromise(() =>
            db
              .prepare(`INSERT INTO statement_needs_review
        (id,user_id,submission_id,record_number,reason,original_evidence,known_money,issues,status,
        evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .bind(
                "10000000-0000-4000-8000-000000000701",
                userA,
                submissionId,
                1,
                row.reason,
                evidence,
                null,
                issues,
                "pending",
                context.expiresAt,
                context.createdAt,
                context.serviceMarket,
                context.locale,
                context.timeZone,
                context.sourceFormat,
                context.parserRevision,
                context.extractorRevision
              )
              .run()
          )
        );
        expect(Exit.isSuccess(inserted)).toBe(true);
      }
    }),
  30_000
);

effectIt.effect("fails an already-processing oversized review row without undoing captures", () =>
  Effect.gen(function* () {
    const source = yield* fromTestPromise(() =>
      Bun.file(
        new URL(
          "../../src/shell/ingestion/internal/fixtures/shared-string-review.xlsx",
          import.meta.url
        )
      ).bytes()
    );
    const { db, bucket } = yield* fromTestPromise(() => setup(source, "xlsx"));
    // Simulate a submission admitted by an earlier processor: there is no queued admission
    // left to run. Its first chunk commits normally before the next chunk reaches overflow.
    yield* fromTestPromise(() =>
      db.batch([
        db
          .prepare(
            "UPDATE statement_submissions SET status='processing',started_at_ms=? WHERE id=?"
          )
          .bind(currentMillis(), submissionId),
        db
          .prepare(
            "INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)"
          )
          .bind(userA, submissionId),
      ])
    );
    const monitored = observeStatementReads(bucket);
    const input = {
      DB: db,
      STATEMENT_STAGING_BUCKET: monitored.bucket,
      userId: userA,
      submissionId,
    };
    expect(yield* processStatementSubmission(input)).toBe("continue");
    expect(yield* processStatementSubmission(input)).toBe("completed");
    expect(yield* processStatementSubmission(input)).toBe("completed");
    expect(
      yield* fromTestPromise(() =>
        db
          .prepare(`SELECT status,failure_reason,input_rows,
      accepted_rows,needs_review_rows FROM statement_submissions WHERE id=?`)
          .bind(submissionId)
          .first()
      )
    ).toEqual({
      status: "failed",
      failure_reason: "resource-limit",
      input_rows: 33,
      accepted_rows: 33,
      needs_review_rows: 0,
    });
    expect(
      yield* fromTestPromise(() =>
        db
          .prepare(`SELECT
      (SELECT count(*) FROM transactions) AS transactions,
      (SELECT count(*) FROM source_attestations) AS attestations,
      (SELECT count(*) FROM statement_record_outcomes) AS outcomes,
      (SELECT count(*) FROM statement_needs_review) AS reviews`)
          .first()
      )
    ).toEqual({ transactions: 33, attestations: 33, outcomes: 33, reviews: 0 });
    expect(
      yield* fromTestPromise(() =>
        db
          .prepare(`SELECT submission_id,
      consumed_at_ms IS NOT NULL AS consumed FROM statement_backfill_entitlements WHERE user_id=?`)
          .bind(userA)
          .first()
      )
    ).toEqual({ submission_id: submissionId, consumed: 1 });
    expect(monitored.observed).toEqual({ heads: 1, gets: 1, bytes: source.byteLength });
  })
);

effectIt.effect(
  "rejects derived material above its aggregate budget before capturing any rows",
  () =>
    Effect.gen(function* () {
      const source = yield* fromTestPromise(() =>
        Bun.file(
          new URL(
            "../../src/shell/ingestion/internal/fixtures/shared-string-repeated-accepted.xlsx",
            import.meta.url
          )
        ).bytes()
      );
      const { db, bucket } = yield* fromTestPromise(() => setup(source, "xlsx"));
      const monitored = observeStatementReads(bucket);
      expect(
        yield* processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: monitored.bucket,
          userId: userA,
          submissionId,
        })
      ).toBe("completed");
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare(`SELECT
      (SELECT count(*) FROM transactions WHERE counterparty='Cafe') AS transactions,
      (SELECT count(*) FROM source_attestations) AS attestations,
      (SELECT count(*) FROM statement_record_outcomes) AS outcomes,
      (SELECT count(*) FROM statement_needs_review) AS reviews`)
            .first()
        )
      ).toEqual({ transactions: 0, attestations: 0, outcomes: 0, reviews: 0 });
      expect(monitored.observed).toEqual({ heads: 1, gets: 1, bytes: source.byteLength });
    })
);

effectIt.effect("releases an unspent reservation when the first review row exceeds storage", () =>
  Effect.gen(function* () {
    const source = yield* fromTestPromise(() =>
      Bun.file(
        new URL(
          "../../src/shell/ingestion/internal/fixtures/shared-string-row-limit.xlsx",
          import.meta.url
        )
      ).bytes()
    );
    const { db, bucket } = yield* fromTestPromise(() => setup(source, "xlsx"));
    yield* fromTestPromise(() =>
      db
        .prepare("INSERT INTO statement_backfill_entitlements (user_id,submission_id) VALUES (?,?)")
        .bind(userA, submissionId)
        .run()
    );
    const monitored = observeStatementReads(bucket);
    const input = {
      DB: db,
      STATEMENT_STAGING_BUCKET: monitored.bucket,
      userId: userA,
      submissionId,
    };
    expect(yield* processStatementSubmission(input)).toBe("completed");
    expect(yield* processStatementSubmission(input)).toBe("completed");
    expect(
      yield* fromTestPromise(() =>
        db
          .prepare(`SELECT status,failure_reason,input_rows,
      accepted_rows,needs_review_rows FROM statement_submissions WHERE id=?`)
          .bind(submissionId)
          .first()
      )
    ).toEqual({
      status: "failed",
      failure_reason: "resource-limit",
      input_rows: null,
      accepted_rows: null,
      needs_review_rows: null,
    });
    expect(
      yield* fromTestPromise(() =>
        db
          .prepare(`SELECT
      (SELECT count(*) FROM transactions) AS transactions,
      (SELECT count(*) FROM source_attestations) AS attestations,
      (SELECT count(*) FROM statement_record_outcomes) AS outcomes,
      (SELECT count(*) FROM statement_needs_review) AS reviews`)
          .first()
      )
    ).toEqual({ transactions: 0, attestations: 0, outcomes: 0, reviews: 0 });
    expect(
      yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT submission_id,consumed_at_ms FROM statement_backfill_entitlements WHERE user_id=?"
          )
          .bind(userA)
          .first()
      )
    ).toEqual({ submission_id: null, consumed_at_ms: null });
    expect(monitored.observed).toEqual({ heads: 1, gets: 1, bytes: source.byteLength });
  })
);

effectIt.effect(
  "refuses corrupted derived evidence without rereading source or duplicating earlier captures",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() => setup(boundedStatementCsv()));
      const monitored = observeStatementReads(bucket);
      const input = {
        DB: db,
        STATEMENT_STAGING_BUCKET: monitored.bucket,
        userId: userA,
        submissionId,
      };
      expect(yield* processStatementSubmission(input)).toBe("continue");
      yield* fromTestPromise(() =>
        db.prepare("DROP TRIGGER statement_materialization_part_immutable").run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "UPDATE statement_materialization_parts SET body='[]' WHERE submission_id=? AND chunk_index=1"
          )
          .bind(submissionId)
          .run()
      );
      expect(yield* processStatementSubmission(input)).toBe("completed");
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM transactions").first()
        )
      ).toEqual({ count: 32 });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare("SELECT status,failure_reason FROM statement_submissions WHERE id=?")
            .bind(submissionId)
            .first()
        )
      ).toEqual({ status: "failed", failure_reason: "malformed-file" });
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM statement_materialization_parts").first()
        )
      ).toEqual({ count: 0 });
      expect(monitored.observed.gets).toBe(1);
    })
);
effectIt.effect(
  "refuses a substituted source digest after publication without consuming another chunk",
  () =>
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() => setup(boundedStatementCsv()));
      const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
      expect(yield* processStatementSubmission(input)).toBe("continue");
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE statement_staging_objects SET sha256=? WHERE id=?")
          .bind("0".repeat(64), stagingId)
          .run()
      );
      expect(yield* processStatementSubmission(input)).toBe("completed");
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM transactions").first()
        )
      ).toEqual({ count: 32 });
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM statement_materializations").first()
        )
      ).toEqual({ count: 0 });
    })
);
effectIt.effect("a foreign User cannot read or finalize a published materialization", () =>
  Effect.gen(function* () {
    const { db, bucket } = yield* fromTestPromise(() => setup(boundedStatementCsv()));
    const monitored = observeStatementReads(bucket);
    const input = {
      DB: db,
      STATEMENT_STAGING_BUCKET: monitored.bucket,
      userId: userA,
      submissionId,
    };
    expect(yield* processStatementSubmission(input)).toBe("continue");
    expect(yield* processStatementSubmission({ ...input, userId: userB })).toBe("completed");
    expect(
      yield* fromTestPromise(() =>
        db
          .prepare("SELECT processed_rows,status FROM statement_submissions WHERE id=?")
          .bind(submissionId)
          .first()
      )
    ).toEqual({ processed_rows: 32, status: "processing" });
    expect(
      yield* fromTestPromise(() =>
        db.prepare("SELECT count(*) AS count FROM transactions WHERE user_id=?").bind(userB).first()
      )
    ).toEqual({ count: 0 });
    expect(monitored.observed.gets).toBe(1);
  })
);

effectIt.effect(
  "migration preserves existing row receipts and atomically rejects a skipped cursor",
  () =>
    Effect.gen(function* () {
      const { db } = yield* fromTestPromise(() =>
        setup(
          "Header\nvalue",
          "csv",
          migrations.filter((name) => name !== "0077_statement_materialization")
        )
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_record_outcomes(user_id,submission_id,record_number,outcome) VALUES (?,?,1,'needs-review'),(?,?,2,'needs-review')"
          )
          .bind(userA, submissionId, userA, submissionId)
          .run()
      );
      yield* fromTestPromise(() =>
        applyTestMigration({
          db,
          source: new URL("../migrations/0077_statement_materialization.sql", import.meta.url),
        })
      );
      const progress = (): ReturnType<D1PreparedStatement["first"]> =>
        db
          .prepare(
            "SELECT processed_rows,processed_accepted_rows,processed_review_rows FROM statement_submissions WHERE id=?"
          )
          .bind(submissionId)
          .first();
      expect(yield* fromTestPromise(progress)).toEqual({
        processed_rows: 2,
        processed_accepted_rows: 0,
        processed_review_rows: 2,
      });
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO statement_record_outcomes(user_id,submission_id,record_number,outcome) VALUES (?,?,3,'needs-review')"
          )
          .bind(userA, submissionId)
          .run()
      );
      const skipped = yield* Effect.exit(
        Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO statement_record_outcomes(user_id,submission_id,record_number,outcome) VALUES (?,?,5,'needs-review')"
            )
            .bind(userA, submissionId)
            .run()
        )
      );
      expect(Exit.isFailure(skipped)).toBe(true);
      expect(yield* fromTestPromise(progress)).toEqual({
        processed_rows: 3,
        processed_accepted_rows: 0,
        processed_review_rows: 3,
      });
    })
);

effectIt.effect(
  "materializes the 20,000-row ceiling within one bounded D1 activity and reuses it",
  () =>
    Effect.gen(function* () {
      const csv =
        "fecha,valor,moneda,contraparte\n" +
        Array.from(
          { length: statementParserLimits.maximumRows },
          () => "2026-08-01,-1,COP,Cafe"
        ).join("\n") +
        "\n";
      const { db, bucket } = yield* fromTestPromise(() => setup(csv));
      const reads = observeStatementReads(bucket);
      let statements = 0;
      const measured = new Proxy(db, {
        get(target, property): unknown {
          if (property === "prepare") {
            return (sql: string): D1PreparedStatement => {
              statements += 1;
              return target.prepare(sql);
            };
          }
          const method: unknown = Reflect.get(target, property, target);
          return typeof method === "function" ? method.bind(target) : method;
        },
      });
      const input = {
        DB: measured,
        STATEMENT_STAGING_BUCKET: reads.bucket,
        userId: userA,
        submissionId,
      };
      expect(yield* processStatementSubmission(input)).toBe("continue");
      expect(statements).toBeLessThan(1000);
      const initialStatements = statements;
      expect(yield* processStatementSubmission(input)).toBe("continue");
      expect(statements - initialStatements).toBeLessThan(200);
      expect(reads.observed).toEqual({
        heads: 1,
        gets: 1,
        bytes: new TextEncoder().encode(csv).byteLength,
      });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare("SELECT processed_rows FROM statement_submissions WHERE id=?")
            .bind(submissionId)
            .first()
        )
      ).toEqual({ processed_rows: 64 });
    }),
  30_000
);

it.each(["failed-delete", "lost-reservation-response"] as const)(
  "recovers partial publication after %s without consuming an unused source rebuild",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const csv =
          "fecha,valor,moneda,contraparte\n" +
          Array.from({ length: 289 }, () => "2026-08-01,-1,COP,Cafe").join("\n") +
          "\n";
        const { db, bucket } = yield* fromTestPromise(() => setup(csv));
        const reads = observeStatementReads(bucket);
        let batches = 0;
        const interrupted = new Proxy(db, {
          get(target, property): unknown {
            if (property === "batch") {
              return (
                ...args: Parameters<D1Database["batch"]>
              ): ReturnType<D1Database["batch"]> => {
                batches += 1;
                return batches === 2
                  ? Promise.reject(new Error("partial publication"))
                  : target.batch(...args);
              };
            }
            const method: unknown = Reflect.get(target, property, target);
            return typeof method === "function" ? method.bind(target) : method;
          },
        });
        const input = {
          DB: interrupted,
          STATEMENT_STAGING_BUCKET: reads.bucket,
          userId: userA,
          submissionId,
        };
        deepStrictEqual(
          yield* Effect.exit(processStatementSubmission(input)),
          Exit.fail(new StatementProcessingUnavailable())
        );
        expect(
          yield* fromTestPromise(() =>
            db.prepare("SELECT count(*) AS count FROM statement_materialization_parts").first()
          )
        ).toEqual({ count: 8 });
        let loseResponse = true;
        const withLostReservationResponse = (statement: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(statement, {
            get(target, property): unknown {
              if (property === "bind") {
                return (...args: Parameters<D1PreparedStatement["bind"]>): D1PreparedStatement =>
                  withLostReservationResponse(target.bind(...args));
              }
              if (property === "all") {
                return (
                  ...args: Parameters<D1PreparedStatement["all"]>
                ): ReturnType<D1PreparedStatement["all"]> =>
                  target.all(...args).then((result) => {
                    if (loseResponse) {
                      loseResponse = false;
                      throw new Error("lost reservation response");
                    }
                    return result;
                  });
              }
              const method: unknown = Reflect.get(target, property, target);
              return typeof method === "function" ? method.bind(target) : method;
            },
          });
        const failingReservation = new Proxy(db, {
          get(target, property): unknown {
            if (property === "prepare") {
              return (sql: string): D1PreparedStatement =>
                sql.includes("SET source_parse_attempts")
                  ? withLostReservationResponse(target.prepare(sql))
                  : target.prepare(sql);
            }
            const method: unknown = Reflect.get(target, property, target);
            return typeof method === "function" ? method.bind(target) : method;
          },
        });
        if (failure === "failed-delete") {
          yield* fromTestPromise(() =>
            db
              .prepare(
                "CREATE TRIGGER fail_cache_cleanup BEFORE DELETE ON statement_materialization_parts BEGIN SELECT RAISE(ABORT,'cleanup unavailable'); END"
              )
              .run()
          );
        }
        deepStrictEqual(
          yield* Effect.exit(
            processStatementSubmission({
              ...input,
              DB: failure === "failed-delete" ? db : failingReservation,
            })
          ),
          Exit.fail(new StatementProcessingUnavailable())
        );
        expect(reads.observed.gets).toBe(1);
        expect(
          yield* fromTestPromise(() =>
            db.prepare("SELECT count(*) AS count FROM transactions").first()
          )
        ).toEqual({ count: 0 });
        if (failure === "failed-delete") {
          yield* fromTestPromise(() => db.prepare("DROP TRIGGER fail_cache_cleanup").run());
        }
        // The fixture's daily capture allowance is 100; prove three resumed chunks within it.
        for (let activity = 0; activity < 3; activity += 1) {
          expect(yield* processStatementSubmission({ ...input, DB: db })).toBe("continue");
        }
        expect(reads.observed.gets).toBe(2);
        expect(
          yield* fromTestPromise(() =>
            db.prepare("SELECT count(*) AS count FROM transactions").first()
          )
        ).toEqual({ count: 96 });
      })
    )
);

effectIt.effect("caps repeated partial-publication failures before further source work", () =>
  Effect.gen(function* () {
    const { db, bucket } = yield* fromTestPromise(() => setup(boundedStatementCsv()));
    const reads = observeStatementReads(bucket);
    const cacheWritesUnavailableDb = new Proxy(db, {
      get(target, property): unknown {
        if (property === "batch") {
          return (): ReturnType<D1Database["batch"]> =>
            Promise.reject(new Error("cache writes unavailable"));
        }
        const method: unknown = Reflect.get(target, property, target);
        return typeof method === "function" ? method.bind(target) : method;
      },
    });
    const input = {
      DB: cacheWritesUnavailableDb,
      STATEMENT_STAGING_BUCKET: reads.bucket,
      userId: userA,
      submissionId,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      deepStrictEqual(
        yield* Effect.exit(processStatementSubmission(input)),
        Exit.fail(new StatementProcessingUnavailable())
      );
    }
    expect(yield* processStatementSubmission({ ...input, DB: db })).toBe("completed");
    expect(reads.observed.gets).toBe(3);
    expect(
      yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT status,failure_reason,source_parse_attempts FROM statement_submissions WHERE id=?"
          )
          .bind(submissionId)
          .first()
      )
    ).toEqual({ status: "failed", failure_reason: "resource-limit", source_parse_attempts: 3 });
    expect(
      yield* fromTestPromise(() => db.prepare("SELECT count(*) AS count FROM transactions").first())
    ).toEqual({ count: 0 });
  })
);
