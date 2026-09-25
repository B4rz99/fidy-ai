import {
  type StagedStatementBytes,
  type StagedStatementReference,
  StagedStatementReference as StagedStatementReferenceSchema,
  type StatementStagingFailureReason,
  StatementStagingId,
} from "@fidy/server/statement-staging";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import { Data, Effect, Encoding, Fiber, Option, Result, Schema } from "effect";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import type { TransactionAuthority } from "../transactions/transaction-boundary";
import type { AtomicMutationRefusal } from "../atomic/atomic-mutation-unit";
import {
  type StatementPublicationOutcome,
  StatementStaging,
  StatementStagingFailed,
  type StatementStagingRefused,
  type StatementStagingService,
  type StatementStagingSweep,
  StatementStagingUnavailable,
} from "./statement-staging";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);

const userA = "10000000-0000-4000-8000-000000000101";
const userB = "10000000-0000-4000-8000-000000000102";
const idempotencyKey = "20000000-0000-4000-8000-000000000201";
const otherIdempotencyKey = "20000000-0000-4000-8000-000000000202";
const statementStagingLifetime = 24 * 60 * 60 * 1000;
const startedAtEpochMs = Date.parse("2026-09-01T00:00:00Z");
const secretSentinel = "password=hunter2-statement-secret";
const statementBytes = new TextEncoder().encode(
  `fecha,valor,descripcion\n2026-08-01,-45000,Cafe\n${secretSentinel}\n`
);

type StagingResult<A> = Result.Result<
  A,
  StatementStagingFailed | StatementStagingRefused | StatementStagingUnavailable
>;

const instances = new Set<Miniflare>();
const migrationsDirectoryUrl = new URL("../migrations/", import.meta.url);
// The proof needs stable User ownership, the statement staging schema, and the Subscription
// standing tables publication decides the Free allowance against, in deployment order. #698's
// migration also joins the shared canonical read budget, so the canonical audit tables and their
// budget triggers must exist before it runs.
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
  "0014_memory",
  "0015_statement_submission",
] as const;
const workerScript = "export default { fetch() { return new Response('ok') } }";
const stagingWorkerName = "statement-staging-test-worker";

const makeMiniflare = (): Promise<Miniflare> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const miniflare = new Miniflare({
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: {
                DB: { id: "statement-staging-test", type: "d1" },
                BUCKET: { type: "r2" },
              },
              manifest: {
                mainModule: "index.mjs",
                modules: { "index.mjs": { contents: workerScript, type: "esm" } },
              },
              name: stagingWorkerName,
              type: "worker",
            },
          },
        ],
      });
      instances.add(miniflare);
      yield* fromTestPromise(() => miniflare.ready);
      return miniflare;
    })
  );

const applyMigration = (database: D1Database, name: string): Promise<void> =>
  Bun.file(new URL(`${name}.sql`, migrationsDirectoryUrl))
    .text()
    .then((sql) => sql.replace(/^--.*$/gmu, "").trim())
    .then((sql) =>
      sql
        .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)
        .reduce<Promise<unknown>>(
          (previous, statement) => previous.then(() => database.prepare(statement).run()),
          Promise.resolve()
        )
    )
    .then(() => undefined);

const migrateDatabase = (database: D1Database): Promise<void> =>
  migrationNames.reduce(
    (previous, name) => previous.then(() => applyMigration(database, name)),
    Promise.resolve()
  );

/** Deterministic WebSession identity per seeded User, standing in for the browser login proof. */
const sessionIds = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
] as const;
const pairingIds = [
  "30000000-0000-4000-8000-000000000011",
  "30000000-0000-4000-8000-000000000012",
] as const;
const publicCodes = ["AAA111111", "BBB222222"] as const;
const sessionDigest = (index: number): Uint8Array => new Uint8Array(32).fill(index + 1);
const seededSessions = [
  { digest: sessionDigest(0), id: sessionIds[0], userId: userA },
  { digest: sessionDigest(1), id: sessionIds[1], userId: userB },
] as const;
/** Seeds one consumed pairing and its live WebSession per User, the caller the service rechecks. */
const seedSessions = (database: D1Database): Promise<void> =>
  database
    .batch(
      seededSessions.flatMap((session, index) => [
        database
          .prepare(
            `INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state,
               created_at_ms, expires_at_ms)
             VALUES (?, ?, ?, ?, 'consumed', ?, ?)`
          )
          .bind(
            pairingIds[index],
            publicCodes[index],
            sessionDigest(index),
            session.userId,
            startedAtEpochMs,
            startedAtEpochMs + 600_000
          ),
        database
          .prepare(
            `INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms,
               fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            session.id,
            pairingIds[index],
            session.userId,
            session.digest,
            startedAtEpochMs,
            startedAtEpochMs + 600_000,
            startedAtEpochMs + 7_776_000_000,
            startedAtEpochMs + 7_776_000_000
          ),
      ])
    )
    .then(() => undefined);

type Runtime = Readonly<{
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly staging: StatementStagingService;
  readonly miniflare: Miniflare;
}>;

let nowEpochMs = (): number => startedAtEpochMs;
const currentNowEpochMs = (): number => nowEpochMs();

const makeRuntime = (): Promise<Runtime> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const miniflare = yield* fromTestPromise(makeMiniflare);
      const bindings = yield* fromTestPromise(() =>
        miniflare.getBindings<{ readonly DB: D1Database; readonly BUCKET: R2Bucket }>(
          stagingWorkerName
        )
      );
      yield* fromTestPromise(() => migrateDatabase(bindings.DB));
      yield* fromTestPromise(() =>
        [userA, userB].reduce<Promise<unknown>>(
          (previous, userId) =>
            previous.then(() =>
              bindings.DB.prepare(
                "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
              )
                .bind(userId, startedAtEpochMs)
                .run()
            ),
          Promise.resolve()
        )
      );
      yield* fromTestPromise(() => seedSessions(bindings.DB));
      return {
        bucket: bindings.BUCKET,
        database: bindings.DB,
        miniflare,
        staging: StatementStaging.make({
          bucket: bindings.BUCKET,
          database: bindings.DB,
          nowEpochMs: currentNowEpochMs,
        }),
      };
    })
  );

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      nowEpochMs = (): number => startedAtEpochMs;
      yield* fromTestPromise(() =>
        Promise.all([...instances].map((miniflare): Promise<void> => miniflare.dispose()))
      );
      instances.clear();
    })
  )
);

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

/** The proof's live-caller gate: the seeded WebSession the canonical caller would present. */
const callerAuthorityFor = (userId: string): TransactionAuthority => {
  const session = seededSessions.find((candidate) => candidate.userId === userId);
  if (session === undefined) throw new Error(`No seeded WebSession for ${userId}`);
  return liveWebSessionAuthority({ subject: session, current: currentNowEpochMs() });
};

/** The winner's real publication, invoked later to race the losing call's conditional unit. */
const winnerPublication =
  (runtime: Runtime, staged: StagedStatementBytes): (() => Promise<unknown>) =>
  () =>
    Effect.runPromise(
      runtime.staging.publishStagedStatementSubmission({
        authority: callerAuthorityFor(userA),
        idempotencyKey,
        reference: reference(staged),
        userId: userA,
      })
    );

/** Commits the winning publication between the losing precondition read and its D1 unit. */
const publishWinnerBeforeBatch = (
  database: D1Database,
  beforeBatch: () => Promise<unknown>
): D1Database => {
  let fired = false;
  return new Proxy(database, {
    get: (target, property): unknown =>
      property === "batch"
        ? (...args: Parameters<D1Database["batch"]>): ReturnType<D1Database["batch"]> => {
            if (fired) return target.batch(...args);
            fired = true;
            return beforeBatch().then(() => target.batch(...args));
          }
        : Reflect.get(target, property, target),
  });
};

const stage = (
  runtime: Runtime,
  userId: string,
  body: Uint8Array | ReadableStream<Uint8Array>
): Promise<StagingResult<StagedStatementBytes>> =>
  Effect.runPromise(
    Effect.result(runtime.staging.stageStatementBytes({ request: request(body), userId }))
  );

const publish = (
  input: Readonly<{
    runtime: Runtime;
    userId: string;
    reference: unknown;
    key: string;
  }>
): Promise<StagingResult<StatementPublicationOutcome>> =>
  Effect.runPromise(
    Effect.result(
      input.runtime.staging.publishStagedStatementSubmission({
        authority: callerAuthorityFor(input.userId),
        idempotencyKey: input.key,
        reference: Schema.decodeUnknownSync(StagedStatementReferenceSchema)(input.reference),
        userId: input.userId,
      })
    )
  );

const publishOnce = (
  input: Readonly<{ runtime: Runtime; userId: string; reference: unknown }>
): Promise<StagingResult<StatementPublicationOutcome>> =>
  publish({ ...input, key: idempotencyKey });

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

/** The one successful publication outcome, or the refusal the test did not expect. */
const publishedOf = (
  result: StagingResult<StatementPublicationOutcome>
): Readonly<{ submissionId: string; replayed: boolean }> => {
  const outcome = requireValue(result);
  if (outcome._tag !== "Published") {
    throw new Error(`Expected a published submission, refused as ${outcome.refusal.code}`);
  }
  return { replayed: outcome.replayed, submissionId: outcome.submissionId };
};

/** The one closed refusal a publication decided, or a failure when it published instead. */
const refusalOf = (result: StagingResult<StatementPublicationOutcome>): AtomicMutationRefusal => {
  const outcome = requireValue(result);
  if (outcome._tag !== "Refused") throw new Error("Expected the statement publication to refuse");
  return outcome.refusal;
};

/** The one bounded refusal every absent, foreign, or mismatched staged reference shares. */
const expectsStagedMaterialRefusal = (result: StagingResult<StatementPublicationOutcome>): void => {
  expect(refusalOf(result)).toEqual({
    auditOutcome: "validation_failed",
    code: "validation_failed",
    message: "The staged statement material is unavailable; upload the file again.",
  });
};

const reference = (staged: StagedStatementBytes): StagedStatementReference => ({
  byteLength: staged.byteLength,
  sha256: staged.sha256,
  stagingId: staged.stagingId,
});

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

const digestHex = (bytes: Uint8Array): Promise<string> =>
  crypto.subtle
    .digest("SHA-256", Uint8Array.from(bytes))
    .then((value) => Encoding.encodeHex(new Uint8Array(value)));

const putWithSha256 = (bucket: R2Bucket, key: string, bytes: Uint8Array): Promise<unknown> =>
  crypto.subtle
    .digest("SHA-256", new Uint8Array(bytes))
    .then((digest) => bucket.put(key, bytes, { sha256: digest }));

const encodeJsonText = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

describe("Cloudflare statement byte staging", () => {
  it("keeps staged bytes non-authoritative until one D1 submission makes them authoritative", () =>
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

        const published = publishedOf(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userA })
          )
        );
        expect(published.replayed).toBe(false);
        expect(
          required(yield* fromTestPromise(() => stagingRow(runtime.database, staged.stagingId)))
            .status
        ).toBe("published");
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          1
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(1);
        const submission = yield* fromTestPromise(() =>
          runtime.database
            .prepare(
              "SELECT id, staging_id FROM statement_submissions WHERE user_id = ? AND idempotency_key = ?"
            )
            .bind(userA, idempotencyKey)
            .first<{ readonly id: string; readonly staging_id: string }>()
        );
        expect(submission).toEqual({ id: published.submissionId, staging_id: staged.stagingId });
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

  it("refuses a caller reference whose digest or size does not match the staged material", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );

        expect(
          refusalOf(
            yield* fromTestPromise(() =>
              publishOnce({
                reference: { ...reference(staged), sha256: "0".repeat(64) },
                runtime,
                userId: userA,
              })
            )
          )
        ).toEqual({
          auditOutcome: "validation_failed",
          code: "validation_failed",
          message: "The staged statement material is unavailable; upload the file again.",
        });
        expect(
          refusalOf(
            yield* fromTestPromise(() =>
              publishOnce({
                reference: { ...reference(staged), byteLength: staged.byteLength + 1 },
                runtime,
                userId: userA,
              })
            )
          ).code
        ).toBe("validation_failed");
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          0
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(0);
        // Refusals leave the real material fully publishable.
        expect(
          publishedOf(
            yield* fromTestPromise(() =>
              publishOnce({ reference: reference(staged), runtime, userId: userA })
            )
          ).replayed
        ).toBe(false);
      })
    ));

  it("cannot read or publish another User's staged reference", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );

        expect(reasonOf(yield* fromTestPromise(() => read(runtime, userB, staged.stagingId)))).toBe(
          "not-found"
        );
        expectsStagedMaterialRefusal(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userB })
          )
        );
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          0
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(0);
        expect(
          requireValue(yield* fromTestPromise(() => read(runtime, userA, staged.stagingId)))
        ).toEqual(statementBytes);
      })
    ));

  it("refuses publication when the staged object no longer exists", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        const row = required(
          yield* fromTestPromise(() => stagingRow(runtime.database, staged.stagingId))
        );
        yield* fromTestPromise(() => runtime.bucket.delete(row.object_key));

        expectsStagedMaterialRefusal(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userA })
          )
        );
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          0
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(0);
      })
    ));

  it("refuses material whose stored checksum no longer matches its recorded digest", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        const key = required(
          yield* fromTestPromise(() => stagingRow(runtime.database, staged.stagingId))
        ).object_key;
        const replaced = new TextEncoder().encode("x".repeat(statementBytes.byteLength));
        yield* fromTestPromise(() => runtime.bucket.delete(key));
        yield* fromTestPromise(() => putWithSha256(runtime.bucket, key, replaced));

        expectsStagedMaterialRefusal(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userA })
          )
        );
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          0
        );
      })
    ));

  it("replays one idempotency key and refuses a different reference under it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        const first = publishedOf(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userA })
          )
        );
        const replay = publishedOf(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userA })
          )
        );
        expect(replay).toEqual({ replayed: true, submissionId: first.submissionId });
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          1
        );
        // A replay adds no authoritative state but stays attributable: one audit row per call.
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(2);

        const other = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        expect(
          refusalOf(
            yield* fromTestPromise(() =>
              publish({ key: idempotencyKey, reference: reference(other), runtime, userId: userA })
            )
          ).code
        ).toBe("validation_failed");
        expect(
          refusalOf(
            yield* fromTestPromise(() =>
              publish({
                key: otherIdempotencyKey,
                reference: reference(staged),
                runtime,
                userId: userA,
              })
            )
          ).code
        ).toBe("validation_failed");
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          1
        );
      })
    ));

  it("refuses a replay whose credential died after dispatch", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        const first = publishedOf(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userA })
          )
        );
        // The session is revoked between dispatch and the replay's own authority unit.
        yield* fromTestPromise(() =>
          runtime.database
            .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE user_id = ?")
            .bind(currentNowEpochMs(), userA)
            .run()
        );
        const replayed = yield* Effect.result(
          runtime.staging.publishStagedStatementSubmission({
            authority: callerAuthorityFor(userA),
            idempotencyKey,
            reference: reference(staged),
            userId: userA,
          })
        );
        expect(Result.isFailure(replayed)).toBe(true);
        if (Result.isFailure(replayed)) {
          expect(replayed.failure).toMatchObject({
            _tag: "StatementStagingRefused",
            reason: "authority",
          });
        }
        // The refused replay returned nothing, attributed nothing, and changed no authority.
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          1
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(1);
        expect(first.replayed).toBe(false);
      })
    ));

  it("keeps a losing reference unpromoted when one idempotency key already won", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const winner = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        const loser = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );

        // The winner commits after the losing call has already read "no submission for this key",
        // so only the conditional D1 unit can decide what the losing reference may change.
        const stale = StatementStaging.make({
          bucket: runtime.bucket,
          database: publishWinnerBeforeBatch(runtime.database, winnerPublication(runtime, winner)),
          nowEpochMs: currentNowEpochMs,
        });
        const refused = yield* Effect.result(
          stale.publishStagedStatementSubmission({
            authority: callerAuthorityFor(userA),
            idempotencyKey,
            reference: reference(loser),
            userId: userA,
          })
        );
        expect(refusalOf(refused)).toEqual({
          auditOutcome: "validation_failed",
          code: "validation_failed",
          message:
            "The idempotency key already names different statement material. Stage that material and use a new key.",
        });
        expect(
          required(yield* fromTestPromise(() => stagingRow(runtime.database, loser.stagingId)))
            .status
        ).toBe("available");
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          1
        );
        expect(
          requireValue(yield* fromTestPromise(() => read(runtime, userA, loser.stagingId)))
        ).toEqual(statementBytes);

        // The losing material stays inside the bounded expiry and is swept like any abandonment.
        nowEpochMs = (): number => startedAtEpochMs + statementStagingLifetime;
        expect(requireValue(yield* fromTestPromise(() => sweep(runtime)))).toEqual({
          objectsDeleted: 1,
          rowsDeleted: 1,
        });
        expect(
          required(yield* fromTestPromise(() => stagingRow(runtime.database, winner.stagingId)))
            .status
        ).toBe("published");
      })
    ));

  it("attributes a losing call that resolves to the winner's same-material replay", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const winner = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );

        // The winner commits after the losing call has already read "no submission for this key",
        // so its refused unit classifies as a replay of the winner's own material. That replay must
        // still commit its caller-owned attribution: one audit row per canonical call, never zero.
        const stale = StatementStaging.make({
          bucket: runtime.bucket,
          database: publishWinnerBeforeBatch(runtime.database, winnerPublication(runtime, winner)),
          nowEpochMs: currentNowEpochMs,
        });
        const replayed = publishedOf(
          yield* Effect.result(
            stale.publishStagedStatementSubmission({
              authority: callerAuthorityFor(userA),
              idempotencyKey,
              reference: reference(winner),
              userId: userA,
            })
          )
        );
        expect(replayed.replayed).toBe(true);
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          1
        );
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_submission_audit"))
        ).toBe(2);
      })
    ));

  it("leaves an interrupted upload unpublished, then sweeps its bounded staging state", () =>
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
        // An unfinished upload is never publishable even though its bytes reached R2.
        expectsStagedMaterialRefusal(
          yield* fromTestPromise(() =>
            publishOnce({
              reference: {
                byteLength: row.byte_length,
                sha256: row.sha256,
                stagingId: row.id,
              },
              runtime,
              userId: userA,
            })
          )
        );
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          0
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

  it("refuses expired staged material before any sweep touches it", () =>
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
        expectsStagedMaterialRefusal(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userA })
          )
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

  it("sweeps expired abandoned staging but never published material", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const abandoned = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        const published = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        const publication = publishedOf(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(published), runtime, userId: userA })
          )
        );

        nowEpochMs = (): number => startedAtEpochMs + statementStagingLifetime;
        expect(requireValue(yield* fromTestPromise(() => sweep(runtime)))).toEqual({
          objectsDeleted: 1,
          rowsDeleted: 1,
        });
        expect(
          yield* fromTestPromise(() => count(runtime.database, "statement_staging_objects"))
        ).toBe(1);
        expect(yield* fromTestPromise(() => count(runtime.database, "statement_submissions"))).toBe(
          1
        );
        // The published submission keeps its material readable and replayable past staging expiry.
        expect(
          requireValue(yield* fromTestPromise(() => read(runtime, userA, published.stagingId)))
        ).toEqual(statementBytes);
        expect(
          publishedOf(
            yield* fromTestPromise(() =>
              publishOnce({ reference: reference(published), runtime, userId: userA })
            )
          )
        ).toEqual({ replayed: true, submissionId: publication.submissionId });
        expect(
          reasonOf(yield* fromTestPromise(() => read(runtime, userA, abandoned.stagingId)))
        ).toBe("not-found");
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
        expectsStagedMaterialRefusal(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userA })
          )
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

  it("records metadata-only audit success and keeps statement content out of refusals", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => makeRuntime());
        const staged = requireValue(
          yield* fromTestPromise(() => stage(runtime, userA, statementBytes))
        );
        requireValue(
          yield* fromTestPromise(() =>
            publishOnce({ reference: reference(staged), runtime, userId: userA })
          )
        );
        const audit = yield* fromTestPromise(() =>
          runtime.database.prepare("SELECT * FROM statement_submission_audit").first()
        );
        const staging = yield* fromTestPromise(() =>
          runtime.database.prepare("SELECT * FROM statement_staging_objects").first()
        );
        const refusal = yield* fromTestPromise(() =>
          publishOnce({
            reference: { ...reference(staged), sha256: "0".repeat(64) },
            runtime,
            userId: userA,
          })
        );

        for (const persisted of [audit, staging]) {
          expect(encodeJsonText(persisted)).not.toContain(secretSentinel);
          expect(encodeJsonText(persisted)).not.toContain("fecha,valor");
        }
        expect(Object.keys(audit ?? {}).sort()).toEqual([
          "id",
          "occurred_at_ms",
          "operation",
          "outcome",
          "user_id",
        ]);
        expect(Object.keys(refusalOf(refusal)).sort()).toEqual(["auditOutcome", "code", "message"]);
        expect(encodeJsonText(refusalOf(refusal))).not.toContain(secretSentinel);
      })
    ));
});
