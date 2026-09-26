import {
  type StagedStatementBytes,
  type StatementStagingFailureReason,
  StatementStagingId,
} from "@fidy/server/statement-staging";
import { Data, Effect, Encoding, Fiber, Option, Result } from "effect";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  StatementStaging,
  StatementStagingFailed,
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
const statementStagingLifetime = 24 * 60 * 60 * 1000;
const startedAtEpochMs = Date.parse("2026-09-01T00:00:00Z");
const statementBytes = new TextEncoder().encode(
  `fecha,valor,descripcion\n2026-08-01,-45000,Cafe\npassword=hunter2-statement-secret\n`
);

type StagingResult<A> = Result.Result<A, StatementStagingFailed | StatementStagingUnavailable>;

const instances = new Set<Miniflare>();
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
  "0014_memory",
  "0015_statement_submission",
  "0016_statement_processing",
  "0017_statement_dispatch",
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

const digestHex = (bytes: Uint8Array): Promise<string> =>
  crypto.subtle
    .digest("SHA-256", Uint8Array.from(bytes))
    .then((value) => Encoding.encodeHex(new Uint8Array(value)));

describe("Cloudflare statement byte staging", () => {
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
