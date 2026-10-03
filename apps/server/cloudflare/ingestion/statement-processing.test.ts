import { statementParserLimits } from "../../src/shell/ingestion/contract";
import { Effect, Option } from "effect";
import { installTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { afterAll, expect } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { currentMillis } from "../runtime/operations";
import { failStatementSubmission, processStatementSubmission } from "./operations";
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
];
const storage = isolatedTestStorage();

const setup = (csv: string): Promise<{ db: D1Database; bucket: R2Bucket }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* fromTestPromise(() => storage.acquire());
      yield* fromTestPromise(() =>
        installTestSchema({
          db,
          sources: migrations.map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
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
      const bytes = new TextEncoder().encode(csv);
      const hash = yield* fromTestPromise(() => crypto.subtle.digest("SHA-256", bytes));
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
    VALUES (?,?,'staging/statement/v1/test',?,?,'csv','published',?,?,?)`)
          .bind(
            stagingId,
            userA,
            bytes.length,
            sha256,
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
    VALUES (?,?,?,?,?,'csv','statement-parser-v1','CO','es-CO','America/Bogota','queued',?)`)
          .bind(
            submissionId,
            userA,
            "10000000-0000-4000-8000-000000000603",
            stagingId,
            current,
            current + retentionMs
          )
          .run()
      );
      return { db, bucket };
    })
  );

afterAll(() => storage.dispose());

effectIt.effect(
  "clears all expired raw review evidence even when more than a hundred rows expire together",
  () =>
    Effect.gen(function* () {
      const { db } = yield* fromTestPromise(() =>
        setup("fecha,valor,descripcion\n2026-08-01,-1,Cafe\n")
      );
      const expiredAt = currentMillis() - 1_000;
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
      yield* fromTestPromise(() => expireStatementReviewEvidence({ DB: db }));
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
        yield* fromTestPromise(() =>
          processStatementSubmission({
            DB: db,
            STATEMENT_STAGING_BUCKET: bucket,
            userId: userA,
            submissionId,
          })
        )
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
      yield* fromTestPromise(() =>
        processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: userB,
          submissionId,
        })
      );
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
      yield* fromTestPromise(() => processStatementSubmission(input));
      yield* fromTestPromise(() => processStatementSubmission(input));
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
      yield* fromTestPromise(() =>
        processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: userA,
          submissionId,
        })
      );
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
              if (batches === 2) {
                throw new Error("simulated interruption before second row commit");
              }
              return target.batch(...args);
            };
          }
          return typeof method === "function" ? method.bind(target) : method;
        },
      });
      const input = { DB: db, STATEMENT_STAGING_BUCKET: bucket, userId: userA, submissionId };
      yield* fromTestPromise(() =>
        expect(processStatementSubmission({ ...input, DB: interruptedDB })).rejects.toThrow(
          "simulated interruption"
        )
      );
      const first = yield* fromTestPromise(() =>
        db.prepare("SELECT count(*) AS count FROM transactions").first<{ count: number }>()
      );
      expect(first?.count).toBe(1);
      expect(yield* fromTestPromise(() => processStatementSubmission(input))).toBe("completed");
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
      yield* fromTestPromise(() =>
        Promise.allSettled([processStatementSubmission(input), processStatementSubmission(input)])
      );
      expect(yield* fromTestPromise(() => processStatementSubmission(input))).toBe("completed");
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
      yield* fromTestPromise(() =>
        processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: userA,
          submissionId,
        })
      );
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
      yield* fromTestPromise(() =>
        failStatementSubmission({
          DB: db,
          userId: userA,
          submissionId,
          reason: "resource-limit",
        })
      );
      yield* fromTestPromise(() =>
        failStatementSubmission({
          DB: db,
          userId: userA,
          submissionId,
          reason: "resource-limit",
        })
      );
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
    yield* fromTestPromise(() =>
      processStatementSubmission({
        DB: db,
        STATEMENT_STAGING_BUCKET: bucket,
        userId: userA,
        submissionId,
      })
    );
    yield* fromTestPromise(() =>
      failStatementSubmission({
        DB: db,
        userId: userA,
        submissionId,
        reason: "resource-limit",
      })
    );
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
      const progress = yield* fromTestPromise(() =>
        processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: userA,
          submissionId,
        })
      );
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
      yield* fromTestPromise(() =>
        failStatementSubmission({
          DB: db,
          userId: userA,
          submissionId,
          reason: "resource-limit",
        })
      );
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
        ).toMatchObject({ inputRows: 32, acceptedRows: 0, needsReviewRows: 32 });
      }
      expect(entitlement?.consumed_at_ms).not.toBeNull();
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
      expect(yield* fromTestPromise(() => processStatementSubmission(input))).toBe("continue");
      expect(yield* fromTestPromise(() => processStatementSubmission(input))).toBe("completed");
      expect(yield* fromTestPromise(() => processStatementSubmission(input))).toBe("completed");
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
      expect(yield* fromTestPromise(() => processStatementSubmission(input))).toBe("continue");
      expect(yield* fromTestPromise(() => processStatementSubmission(input))).toBe("continue");
      expect(yield* fromTestPromise(() => processStatementSubmission(input))).toBe("continue");
      expect(yield* fromTestPromise(() => processStatementSubmission(input))).toBe("completed");
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
      yield* fromTestPromise(() =>
        processStatementSubmission({
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: userA,
          submissionId,
        })
      )
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
  "retention failure preserves visible partial accounting and does not refund useful Free work",
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
        yield* fromTestPromise(() =>
          processStatementSubmission({
            DB: db,
            STATEMENT_STAGING_BUCKET: bucket,
            userId: userA,
            submissionId,
          })
        )
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
      expect(entitlement?.consumed_at_ms).not.toBeNull();
    })
);
