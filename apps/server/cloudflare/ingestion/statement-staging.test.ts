import {
  type StagedStatementBytes,
  type StatementStagingFailureReason,
  StatementStagingId,
  StatementSubmissionId,
} from "../../src/shell/ingestion/contract";
import { Data, Effect, Exit, Fiber, Option, Predicate, Result } from "effect";
import { readCanonicalSubmission } from "./internal/statement-ingestion";
import { prepareHeldStatementReviewDecision, prepareHeldStatementSubmission } from "./operations";
import type { StatementDecisionWork } from "./contract";
import assert from "node:assert/strict";
import { Hex } from "effect/encoding";
import { installTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  StatementStaging,
  StatementStagingFailed,
  type StatementStagingService,
  type StatementStagingSweep,
  StatementStagingUnavailable,
} from "./internal/statement-staging";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);

const userA = "10000000-0000-4000-8000-000000000101";
const userB = "10000000-0000-4000-8000-000000000102";
const statementStagingLifetime = 24 * 60 * 60 * 1000;
const startedAtEpochMs = Date.parse("2026-09-01T00:00:00Z");
const statementBytes = new TextEncoder().encode(
  `fecha,valor,descripcion\n2026-08-01,-45000,Cafe\npassword=hunter2-statement-secret\n`
);

type StagingResult<A> = Result.Result<A, StatementStagingFailed | StatementStagingUnavailable>;

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const migrationsDirectoryUrl = new URL("../migrations/", import.meta.url);
// Migrate in deployment order so staging and its retention sweep use real D1 schema.
const migrationNames = [
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
  "0012_transaction_search",
  "0013_category_keyword_rules",
  "0013_transaction_reconciliation",
  "0014_memory",
  "0015_statement_submission",
  "0016_budgets",
  "0037_budget_crossing_facts",
  "0016_statement_processing",
  "0017_forwarded_email",
  "0017_statement_dispatch",
  "0032_statement_capture_entitlement",
  "0033_statement_clarification",
  "0035_statement_hosted_origin",
  "0018_batch_envelope_audit",
  "0019_canonical_child_guards",
  "0035_billing_corrections",
] as const;
type Runtime = Readonly<{
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly staging: StatementStagingService;
}>;

let nowEpochMs = (): number => startedAtEpochMs;
const currentNowEpochMs = (): number => nowEpochMs();

const makeRuntime = (): Promise<Runtime> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db: database, bucket } = yield* fromTestPromise(() => storage.acquire());
      yield* fromTestPromise(() =>
        installTestSchema({
          db: database,
          sources: migrationNames.map((name) => new URL(`${name}.sql`, migrationsDirectoryUrl)),
        })
      );
      yield* fromTestPromise(() =>
        [userA, userB].reduce<Promise<unknown>>(
          (previous, userId) =>
            previous.then(() =>
              database
                .prepare(
                  "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
                )
                .bind(userId, startedAtEpochMs)
                .run()
            ),
          Promise.resolve()
        )
      );
      return {
        bucket,
        database,
        staging: StatementStaging.make({
          bucket,
          database,
          nowEpochMs: currentNowEpochMs,
        }),
      };
    })
  );

afterEach(() => {
  nowEpochMs = (): number => startedAtEpochMs;
});

const request = (body: Uint8Array | ReadableStream<Uint8Array>): Request =>
  new Request("https://core.internal/ingestion/statements", {
    body: body instanceof Uint8Array ? body.slice().buffer : body,
    method: "POST",
  });

const streamOf = (chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/** Fails every object delete, so a sweep can be interrupted after it marks rows `deleting`. */
const failingBucket = (bucket: R2Bucket): R2Bucket =>
  new Proxy(bucket, {
    get: (target, property): unknown =>
      property === "delete"
        ? (): Promise<void> => Promise.reject(new Error("object storage unavailable"))
        : Reflect.get(target, property, target),
  });

/** Fails the object write and its compensating delete, so a discarded upload keeps its row. */
const failingUploadBucket = (bucket: R2Bucket): R2Bucket =>
  new Proxy(bucket, {
    get: (target, property): unknown =>
      property === "put" || property === "delete"
        ? (): Promise<void> => Promise.reject(new Error("object storage unavailable"))
        : Reflect.get(target, property, target),
  });

/** Holds the object write open after it lands, so an interruption can race the availability update. */
const gatedBucket = (
  bucket: R2Bucket,
  entered: PromiseWithResolvers<void>,
  release: PromiseWithResolvers<void>
): R2Bucket =>
  new Proxy(bucket, {
    get: (target, property): unknown =>
      property === "put"
        ? (...args: Parameters<R2Bucket["put"]>): ReturnType<R2Bucket["put"]> =>
            target.put(...args).then((value) => {
              entered.resolve();
              return release.promise.then(() => value);
            })
        : Reflect.get(target, property, target),
  });

const stage = (
  runtime: Runtime,
  userId: string,
  body: Uint8Array | ReadableStream<Uint8Array>
): Promise<StagingResult<StagedStatementBytes>> =>
  Effect.runPromise(
    Effect.result(runtime.staging.stageStatementBytes({ request: request(body), userId }))
  );

const read = (
  runtime: Runtime,
  userId: string,
  stagingId: string
): Promise<StagingResult<Uint8Array>> =>
  Effect.runPromise(
    Effect.result(
      runtime.staging.readOwnedStagedBytes({
        stagingId: StatementStagingId.make(stagingId),
        userId,
      })
    )
  );

const sweep = (runtime: Runtime): Promise<StagingResult<StatementStagingSweep>> =>
  Effect.runPromise(Effect.result(runtime.staging.sweepExpiredStatementStaging));

const requireValue = <A, E extends Error>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};

const required = <A>(option: Option.Option<A>): A => Option.getOrThrow(option);

const reasonOf = (result: StagingResult<unknown>): StatementStagingFailureReason => {
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(StatementStagingFailed);
    if (result.failure instanceof StatementStagingFailed) return result.failure.reason;
  }
  throw new Error("Expected the staging adapter to refuse");
};

type StagingRowRecord = Readonly<{
  id: string;
  object_key: string;
  status: string;
  sha256: string;
  byte_length: number;
}>;

const count = (
  database: D1Database,
  table: "statement_staging_objects" | "statement_submissions" | "statement_submission_audit"
): Promise<number> =>
  database
    .prepare(`SELECT count(*) AS total FROM ${table}`)
    .first<{ readonly total: number }>()
    .then((row) => row?.total ?? 0);

const stagingRow = (
  database: D1Database,
  stagingId: string
): Promise<Option.Option<StagingRowRecord>> =>
  database
    .prepare(
      "SELECT id, object_key, status, sha256, byte_length FROM statement_staging_objects WHERE id = ?"
    )
    .bind(stagingId)
    .first<StagingRowRecord>()
    .then(Option.fromNullishOr);

const onlyStagingRow = (database: D1Database): Promise<Option.Option<StagingRowRecord>> =>
  database
    .prepare(
      "SELECT id, object_key, status, sha256, byte_length FROM statement_staging_objects LIMIT 1"
    )
    .first<StagingRowRecord>()
    .then(Option.fromNullishOr);

/** Simulates a corrupt driver projection after the real User-scoped query has run. */
const corruptFirst = (
  database: D1Database,
  select: string,
  corrupt: (row: unknown) => unknown
): D1Database => {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property): unknown => {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "first") return () => target.first().then(corrupt);
        return Reflect.get(target, property, target);
      },
    });
  return new Proxy(database, {
    get: (target, property): unknown =>
      property === "prepare"
        ? (sql: string) => (sql.includes(select) ? wrap(target.prepare(sql)) : target.prepare(sql))
        : Reflect.get(target, property, target),
  });
};

const completedSubmission = (
  runtime: Runtime,
  stagingId: string
): Effect.Effect<StatementSubmissionId> =>
  Effect.gen(function* () {
    const submissionId = StatementSubmissionId.make("20000000-0000-4000-8000-000000000101");
    yield* fromTestPromise(() =>
      runtime.database
        .prepare(`INSERT INTO statement_submissions
    (id,user_id,idempotency_key,staging_id,source_format,parser_revision,service_market,locale,time_zone,status,submitted_at_ms,started_at_ms,completed_at_ms,retention_expires_at_ms,input_rows,accepted_rows,needs_review_rows)
    VALUES (?, ?, ?, ?, 'csv', 'v1', 'CO', 'es-CO', 'America/Bogota', 'completed', ?, ?, ?, ?, 0, 0, 0)`)
        .bind(
          submissionId,
          userA,
          "30000000-0000-4000-8000-000000000101",
          stagingId,
          startedAtEpochMs,
          startedAtEpochMs,
          startedAtEpochMs,
          startedAtEpochMs + statementStagingLifetime
        )
        .run()
    );
    return submissionId;
  });

const publicationWork = (
  runtime: Runtime,
  staged: StagedStatementBytes
): StatementDecisionWork => ({
  db: runtime.database,
  bucket: Option.some(runtime.bucket),
  userId: userA,
  authority: { table: "hosted_turns", predicate: "0 = 1", bindings: [] },
  originSessionId: Option.none(),
  originTurns: Option.none(),
  publicationOrigin: Option.some({
    sql: "SELECT user_id FROM statement_submissions WHERE 0 = 1",
    params: [],
  }),
  requiredScope: Option.none(),
  current: startedAtEpochMs,
  input: {
    payload: {
      idempotencyKey: "30000000-0000-4000-8000-000000000101",
      reference: {
        stagingId: staged.stagingId,
        byteLength: staged.byteLength,
        sha256: staged.sha256,
      },
    },
  },
});

const digestHex = (bytes: Uint8Array): Promise<string> =>
  crypto.subtle
    .digest("SHA-256", Uint8Array.from(bytes))
    .then((value) => Hex.encode(new Uint8Array(value)));

describe("Cloudflare statement byte staging", () => {
  it("keeps corrupt present staging metadata unavailable rather than blaming the caller", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(makeRuntime);
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        const database = corruptFirst(
          runtime.database,
          "SELECT id, object_key, byte_length",
          (row) => (row === null ? null : { id: staged.stagingId, byte_length: "corrupt" })
        );
        const staging = StatementStaging.make({
          database,
          bucket: runtime.bucket,
          nowEpochMs: currentNowEpochMs,
        });
        assert.deepStrictEqual(
          yield* Effect.exit(
            staging.readOwnedStagedBytes({ userId: userA, stagingId: staged.stagingId })
          ),
          Exit.fail(new StatementStagingUnavailable({ reason: "authority_unavailable" }))
        );
        assert.deepStrictEqual(
          yield* Effect.exit(
            staging.readOwnedStagedBytes({ userId: userB, stagingId: staged.stagingId })
          ),
          Exit.fail(new StatementStagingFailed({ reason: "not-found" }))
        );
        assert.deepStrictEqual(
          yield* Effect.exit(
            staging.readOwnedStagedBytes({
              userId: userA,
              stagingId: StatementStagingId.make("90000000-0000-4000-8000-000000000101"),
            })
          ),
          Exit.fail(new StatementStagingFailed({ reason: "not-found" }))
        );
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          0
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(0);
        expect((yield* fromTestPromise(() => runtime.bucket.list())).objects).toHaveLength(1);
      })
    ));
  it.each([
    ["parser_revision", null],
    ["id", "corrupt"],
    ["started_at_ms", null],
    ["accepted_rows", 1],
    ["submitted_at_ms", 8640000000000001],
    ["started_at_ms", 8640000000000001],
    ["completed_at_ms", 8640000000000001],
  ] as const)(
    "keeps corrupt retained %s unavailable through the typed read and canonical projection",
    (column, value) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* fromTestPromise(makeRuntime);
          const staged = requireValue(
            yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
          );
          const submissionId = yield* completedSubmission(runtime, staged.stagingId);
          // D1 itself permits this out-of-Date-domain integer; other malformed shapes are injected
          // after the real owner query because the SQL constraints prevent retaining them normally.
          if (column === "completed_at_ms") {
            yield* fromTestPromise(() =>
              runtime.database
                .prepare("UPDATE statement_submissions SET completed_at_ms = ? WHERE id = ?")
                .bind(value, submissionId)
                .run()
            );
          }
          const database =
            column === "completed_at_ms"
              ? runtime.database
              : corruptFirst(runtime.database, "SELECT s.id, s.source_format", (row) =>
                  Predicate.isObject(row) ? { ...row, [column]: value } : row
                );
          const staging = StatementStaging.make({
            database,
            bucket: runtime.bucket,
            nowEpochMs: currentNowEpochMs,
          });
          assert.deepStrictEqual(
            yield* Effect.exit(
              staging.readOwnedStatementSubmission({ userId: userA, submissionId })
            ),
            Exit.fail(new StatementStagingUnavailable({ reason: "authority_unavailable" }))
          );
          const response = yield* readCanonicalSubmission({
            config: { database },
            userId: userA,
            submissionId,
            scope: Option.none(),
          });
          expect(response.status).toBe(503);
          const replay = yield* prepareHeldStatementSubmission({
            ...publicationWork(runtime, staged),
            db: database,
          });
          if (
            replay._tag !== "Prepared" ||
            replay.mutation.outcome._tag !== "StatementSubmission"
          ) {
            throw new Error("Expected a retained replay readback");
          }
          assert.deepStrictEqual(
            yield* Effect.exit(replay.mutation.outcome.publication.readCommitted(userA)),
            Exit.succeed(Option.none())
          );
          expect(yield* fromTestPromise(() => response.json())).toEqual({
            error: {
              code: "unavailable",
              message: "Canonical operation is temporarily unavailable.",
            },
            next: [],
          });
          expect(
            Option.isNone(
              yield* staging
                .readOwnedStatementSubmission({ userId: userB, submissionId })
                .pipe(Effect.orDie)
            )
          ).toBe(true);
          expect(
            (yield* readCanonicalSubmission({
              config: { database },
              userId: userB,
              submissionId,
              scope: Option.none(),
            })).status
          ).toBe(404);
          if (column === "completed_at_ms") {
            yield* fromTestPromise(() =>
              runtime.database
                .prepare("UPDATE statement_submissions SET completed_at_ms = ? WHERE id = ?")
                .bind(startedAtEpochMs, submissionId)
                .run()
            );
          }
          const valid = yield* readCanonicalSubmission({
            config: { database: runtime.database },
            userId: userA,
            submissionId,
            scope: Option.none(),
          });
          expect(valid.status).toBe(200);
          expect(yield* fromTestPromise(() => valid.json())).toEqual({
            data: {
              id: submissionId,
              sourceFormat: "csv",
              parserRevision: "v1",
              status: "completed",
              submittedAt: "2026-09-01T00:00:00.000Z",
              startedAt: "2026-09-01T00:00:00.000Z",
              completedAt: "2026-09-01T00:00:00.000Z",
              accounting: { inputRows: 0, acceptedRows: 0, needsReviewRows: 0 },
            },
            next: [],
          });
          expect(
            yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
          ).toBe(0);
          expect((yield* fromTestPromise(() => runtime.bucket.list())).objects).toHaveLength(1);
        })
      )
  );

  it("does not prepare a replay or caller refusal when a present idempotency row is corrupt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(makeRuntime);
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        yield* completedSubmission(runtime, staged.stagingId);
        const work = publicationWork(runtime, staged);
        const database = corruptFirst(
          runtime.database,
          "SELECT id, staging_id FROM statement_submissions",
          (row) => (Predicate.isObject(row) ? { ...row, id: null } : row)
        );
        expect(yield* prepareHeldStatementSubmission({ ...work, db: database })).toEqual({
          _tag: "Unavailable",
        });
        expect(
          (yield* prepareHeldStatementSubmission({ ...work, db: database, userId: userB }))._tag
        ).toBe("Refused");
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          1
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(0);
        expect((yield* fromTestPromise(() => runtime.bucket.list())).objects).toHaveLength(1);
      })
    ));

  it("keeps corrupt eligible clarification metadata out of caller refusal Audit and decisions", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(makeRuntime);
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        const submissionId = yield* completedSubmission(runtime, staged.stagingId);
        const reviewId = "40000000-0000-4000-8000-000000000101";
        const sessionId = "50000000-0000-4000-8000-000000000101";
        yield* fromTestPromise(() =>
          runtime.database.batch([
            runtime.database
              .prepare(
                `INSERT INTO browser_login_pairings (id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?, '123456789', zeroblob(32), ?, 'consumed', ?, ?)`
              )
              .bind(sessionId, userA, startedAtEpochMs, startedAtEpochMs + 600000),
            runtime.database
              .prepare(
                `INSERT INTO web_sessions (id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?, ?, ?, zeroblob(32), ?, ?, ?, ?)`
              )
              .bind(
                sessionId,
                sessionId,
                userA,
                startedAtEpochMs,
                startedAtEpochMs + 600000,
                startedAtEpochMs + 600000,
                startedAtEpochMs + 7776000000
              ),
            runtime.database
              .prepare(
                `INSERT INTO statement_clarifications (submission_id,user_id,state,expires_at_ms) VALUES (?, ?, 'awaiting', ?)`
              )
              .bind(submissionId, userA, startedAtEpochMs + 600000),
            runtime.database
              .prepare(`INSERT INTO statement_needs_review
        (id,user_id,submission_id,record_number,reason,original_evidence,issues,status,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision)
        VALUES (?, ?, ?, 1, 'missing-required-fact', 'private-evidence', '[]', 'pending', ?, ?, 'CO', 'es-CO', 'America/Bogota', 'csv', 'v1', 'v1')`)
              .bind(reviewId, userA, submissionId, startedAtEpochMs + 600000, startedAtEpochMs),
          ])
        );
        const work: StatementDecisionWork = {
          ...publicationWork(runtime, staged),
          authority: {
            table: "web_sessions",
            predicate: "web_sessions.id = ? AND web_sessions.user_id = ?",
            bindings: [sessionId, userA],
          },
          publicationOrigin: Option.none(),
          input: { params: { id: reviewId } },
        };
        const database = corruptFirst(
          runtime.database,
          "SELECT r.id, r.submission_id, r.record_number",
          (row) => (Predicate.isObject(row) ? { ...row, record_number: "corrupt" } : row)
        );
        const operation = "ingestion.skipNeedsReviewItem";
        expect(
          yield* prepareHeldStatementReviewDecision({ operation, work: { ...work, db: database } })
        ).toEqual({ _tag: "Failed" });
        expect(
          (yield* prepareHeldStatementReviewDecision({
            operation,
            work: { ...work, db: database, userId: userB },
          }))._tag
        ).toBe("Refused");
        const prepared = yield* prepareHeldStatementReviewDecision({ operation, work });
        expect(prepared._tag).toBe("Prepared");
        if (prepared._tag !== "Prepared" || prepared.mutation.outcome._tag !== "Owner") {
          throw new Error("Expected a prepared owner decision");
        }
        const corruptRead = corruptFirst(runtime.database, "SELECT s.id, s.source_format", (row) =>
          Predicate.isObject(row) ? { ...row, completed_at_ms: 8640000000000001 } : row
        );
        assert.deepStrictEqual(
          yield* Effect.exit(prepared.mutation.outcome.read(corruptRead, userA)),
          Exit.succeed(Option.none())
        );
        expect(
          yield* fromTestPromise(() =>
            runtime.database
              .prepare("SELECT count(*) AS total FROM statement_review_decisions")
              .first("total")
          )
        ).toBe(0);
        expect(
          yield* fromTestPromise(() =>
            runtime.database
              .prepare("SELECT count(*) AS total FROM statement_clarification_audit")
              .first("total")
          )
        ).toBe(0);
        expect(
          yield* fromTestPromise(() =>
            runtime.database
              .prepare("SELECT original_evidence FROM statement_needs_review WHERE id = ?")
              .bind(reviewId)
              .first("original_evidence")
          )
        ).toBe("private-evidence");
        expect((yield* fromTestPromise(() => runtime.bucket.list())).objects).toHaveLength(1);
      })
    ));

  it("keeps staged bytes non-authoritative and private until canonical publication", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );

        expect(staged.byteLength).toBe(statementBytes.byteLength);
        expect(staged.sha256).toBe(yield* fromTestPromise(() => digestHex(statementBytes)));
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_staging_objects"))
        ).toBe(1);
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          0
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(0);
        const row = required(
          yield* fromTestPromise(() => stagingRow(runtime.database, staged.stagingId))
        );
        expect(row.status).toBe("available");
        // The R2 locator never carries the opaque staging identity the caller holds.
        expect(row.object_key.startsWith("staging/statement/v1/")).toBe(true);
        expect(row.object_key.includes(staged.stagingId)).toBe(false);
        expect(
          requireValue(yield* fromTestPromise(() => read(runtime, userA, staged.stagingId)))
        ).toEqual(statementBytes);
      })
    ));

  it("rejects empty, overstated, and over-bound actual bytes without leaving staging state", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        expect(
          reasonOf(yield* fromTestPromise(() => stage(runtime, userA, new Uint8Array())))
        ).toBe("malformed-file");

        const overstated = new Request("https://core.internal/ingestion/statements", {
          body: statementBytes,
          headers: { "content-length": String(6 * 1024 * 1024) },
          method: "POST",
        });
        expect(
          reasonOf(
            yield* Effect.result(
              runtime.staging.stageStatementBytes({ request: overstated, userId: userA })
            )
          )
        ).toBe("resource-limit");

        // The actual streamed count decides, not a declared length: no Content-Length is present here.
        const oversized = streamOf([new Uint8Array(5 * 1024 * 1024), new Uint8Array(1024 * 1024)]);
        expect(reasonOf(yield* fromTestPromise(() => stage(runtime, userA, oversized)))).toBe(
          "resource-limit"
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_staging_objects"))
        ).toBe(0);
        const objects = yield* fromTestPromise(() =>
          runtime.bucket.list({ prefix: "staging/statement/v1/" })
        );
        expect(objects.objects).toHaveLength(0);
      })
    ));

  it("cannot read another User's staged reference", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );

        expect(reasonOf(yield* fromTestPromise(() => read(runtime, userB, staged.stagingId)))).toBe(
          "not-found"
        );
        expect(
          requireValue(yield* fromTestPromise(() => read(runtime, userA, staged.stagingId)))
        ).toEqual(statementBytes);
      })
    ));

  it("sweeps an interrupted upload whose R2 write preceded availability", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const staging = StatementStaging.make({
          bucket: gatedBucket(runtime.bucket, entered, release),
          database: runtime.database,
          nowEpochMs: currentNowEpochMs,
        });
        const fiber = yield* Effect.forkChild(
          Effect.result(
            staging.stageStatementBytes({ request: request(statementBytes), userId: userA })
          )
        );
        // The pending row is durable before the object write begins, so an interruption here is
        // indistinguishable from a lost response: bytes may exist without a usable staging reference.
        yield* fromTestPromise(() => entered.promise);
        expect(
          required(yield* fromTestPromise(() => onlyStagingRow(runtime.database))).status
        ).toBe("pending");
        // Interruption of the interruptible R2 write completes without waiting for the object write,
        // so the durable outcome is the pending row the next sweep owns.
        yield* Fiber.interrupt(fiber);
        release.resolve();

        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          0
        );
        const objects = yield* fromTestPromise(() =>
          runtime.bucket.list({ prefix: "staging/statement/v1/" })
        );
        expect(objects.objects).toHaveLength(1);
        const row = required(yield* fromTestPromise(() => onlyStagingRow(runtime.database)));
        // An unfinished upload is never readable even though its bytes reached R2.
        expect(row.status).toBe("pending");
        expect(reasonOf(yield* fromTestPromise(() => read(runtime, userA, row.id)))).toBe(
          "not-found"
        );

        nowEpochMs = (): number => startedAtEpochMs + statementStagingLifetime - 1;
        expect(requireValue(yield* fromTestPromise(() => sweep(runtime)))).toEqual({
          objectsDeleted: 0,
          rowsDeleted: 0,
        });
        nowEpochMs = (): number => startedAtEpochMs + statementStagingLifetime;
        expect(requireValue(yield* fromTestPromise(() => sweep(runtime)))).toEqual({
          objectsDeleted: 1,
          rowsDeleted: 1,
        });
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_staging_objects"))
        ).toBe(0);
        expect(
          (yield* fromTestPromise(() => runtime.bucket.list({ prefix: "staging/statement/v1/" })))
            .objects
        ).toHaveLength(0);
      })
    ));

  it("refuses reads of expired staged material before a sweep", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        nowEpochMs = (): number => startedAtEpochMs + statementStagingLifetime;

        // Expiry is a hard bound, not a sweep: the row is still present and both operations refuse.
        expect(reasonOf(yield* fromTestPromise(() => read(runtime, userA, staged.stagingId)))).toBe(
          "retention-expired"
        );
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          0
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(0);
        expect(
          required(yield* fromTestPromise(() => stagingRow(runtime.database, staged.stagingId)))
            .status
        ).toBe("available");

        expect(requireValue(yield* fromTestPromise(() => sweep(runtime)))).toEqual({
          objectsDeleted: 1,
          rowsDeleted: 1,
        });
      })
    ));

  it("resumes an interrupted sweep from its durable deleting state", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        nowEpochMs = (): number => startedAtEpochMs + statementStagingLifetime;
        const interrupted = StatementStaging.make({
          bucket: failingBucket(runtime.bucket),
          database: runtime.database,
          nowEpochMs: currentNowEpochMs,
        });
        const interruptedSweep = yield* Effect.result(interrupted.sweepExpiredStatementStaging);
        if (!Result.isFailure(interruptedSweep)) throw new Error("Expected the sweep to fail");
        expect(interruptedSweep.failure).toBeInstanceOf(StatementStagingUnavailable);

        // The durable outcome is a `deleting` row whose object still exists; a retry owns both.
        const row = required(
          yield* fromTestPromise(() => stagingRow(runtime.database, staged.stagingId))
        );
        expect(row.status).toBe("deleting");
        expect(yield* fromTestPromise(() => runtime.bucket.head(row.object_key))).not.toBeNull();
        expect(reasonOf(yield* fromTestPromise(() => read(runtime, userA, staged.stagingId)))).toBe(
          "not-found"
        );
        expect(requireValue(yield* fromTestPromise(() => sweep(runtime)))).toEqual({
          objectsDeleted: 1,
          rowsDeleted: 1,
        });
        expect(yield* fromTestPromise(() => runtime.bucket.head(row.object_key))).toBeNull();
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_staging_objects"))
        ).toBe(0);
      })
    ));

  it("keeps a discarded upload's row when its object delete fails, then sweeps it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        // The object write and its compensating delete both fail, so the discarded upload must keep
        // its durable row: the bounded sweep finds the object again instead of leaking one.
        const failing = StatementStaging.make({
          bucket: failingUploadBucket(runtime.bucket),
          database: runtime.database,
          nowEpochMs: currentNowEpochMs,
        });
        const discarded = yield* Effect.result(
          failing.stageStatementBytes({ request: request(statementBytes), userId: userA })
        );
        if (!Result.isFailure(discarded)) throw new Error("Expected the upload to fail");
        expect(discarded.failure).toBeInstanceOf(StatementStagingUnavailable);
        expect(
          yield* fromTestPromise(() =>
            runtime.database
              .prepare("SELECT status FROM statement_staging_objects")
              .first<{ status: string }>()
          )
        ).toEqual({ status: "deleting" });

        nowEpochMs = (): number => startedAtEpochMs + statementStagingLifetime;
        expect(requireValue(yield* fromTestPromise(() => sweep(runtime)))).toEqual({
          objectsDeleted: 1,
          rowsDeleted: 1,
        });
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_staging_objects"))
        ).toBe(0);
      })
    ));
});
