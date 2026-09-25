import {
  StatementContentDigest,
  StatementIdempotencyKey,
  StatementSourceFormat,
  StatementStagingId,
  StatementSubmissionId,
} from "@fidy/server/statement-staging";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";
import { transactionSession } from "../transactions/transactions";
import { executeStatementSubmission } from "./statement-ingestion";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure")<{
  readonly cause: unknown;
}> {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: (cause) => new TestPromiseFailure({ cause }),
  }).pipe(Effect.orDie);

const browserOrigin = "https://app.fidyapp.com";
const userA = "10000000-0000-4000-8000-000000000101";
const userB = "10000000-0000-4000-8000-000000000102";
const sessionA = "10000000-0000-4000-8000-000000000201";
const sessionB = "10000000-0000-4000-8000-000000000202";
const dayMilliseconds = 86_400_000;
const secretSentinel = "password=hunter2-statement-secret";
const statementCsv = `fecha,valor,descripcion\n2026-08-01,-45000,Cafe\n${secretSentinel}\n`;
const statementBytes = (text = statementCsv): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

let sequence = 0;
const instances: Array<Miniflare> = [];
const migrationNames = [
  "0001_categories",
  "0002_resource_admission",
  "0003_pending_consent",
  "0004_onboarding_email",
  "0005_verified_onboarding",
  "0006_browser_login",
  "0007_browser_pairing_email",
  "0008_support_recovery",
  "0009_card_enrollment",
  "0009_email_replacement",
  "0009_transactions",
  "0010_pat_lifecycle",
  "0011_transaction_corrections",
  "0012_billing_collection",
  "0012_statement_staging",
  "0012_transaction_search",
  "0013_category_keyword_rules",
  "0014_memory",
  "0015_statement_submission",
] as const;

const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));
const bearer = (index: number): string => String(index + 1).repeat(43);
const applyMigration = (db: D1Database, name: string): Promise<void> =>
  Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url))
    .text()
    .then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)
        .reduce<Promise<void>>(
          (last, statement) => last.then(() => db.prepare(statement).run()).then(() => undefined),
          Promise.resolve()
        )
    );

type Runtime = Readonly<{ db: D1Database; bucket: R2Bucket }>;

const seedUser = (
  db: D1Database,
  input: Readonly<{
    userId: string;
    pairingId: string;
    sessionId: string;
    index: number;
    current: number;
  }>
): Promise<unknown> =>
  Promise.all([digest(`verifier${input.index}`), digest(bearer(input.index))]).then(
    ([verifierDigest, tokenDigest]) =>
      db
        .prepare(
          "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
        )
        .bind(input.userId, input.current)
        .run()
        .then(() =>
          db
            .prepare(
              "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
            )
            .bind(
              input.pairingId,
              `ABCD-123${input.index}`,
              verifierDigest,
              input.userId,
              input.current,
              input.current + 600_000
            )
            .run()
        )
        .then(() =>
          db
            .prepare(
              "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
              input.sessionId,
              input.pairingId,
              input.userId,
              tokenDigest,
              input.current,
              input.current + 600_000,
              input.current + 3_600_000,
              input.current + 7_776_000_000
            )
            .run()
        )
  );

const setup = (): Promise<Runtime> =>
  Effect.runPromise(
    Effect.gen(function* () {
      sequence += 1;
      const name = `statement-ingestion-${sequence}`;
      const miniflare = new Miniflare({
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: { DB: { id: name, type: "d1" }, BUCKET: { type: "r2" } },
              manifest: {
                mainModule: "index.mjs",
                modules: {
                  "index.mjs": {
                    contents: "export default { fetch() { return new Response('ok') } }",
                    type: "esm",
                  },
                },
              },
              name,
              type: "worker",
            },
          },
        ],
      });
      instances.push(miniflare);
      yield* fromTestPromise(() => miniflare.ready);
      const bindings = yield* fromTestPromise(() =>
        miniflare.getBindings<{ DB: D1Database; BUCKET: R2Bucket }>(name)
      );
      yield* fromTestPromise(() =>
        migrationNames.reduce(
          (previous, migration) => previous.then(() => applyMigration(bindings.DB, migration)),
          Promise.resolve()
        )
      );
      const current = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        seedUser(bindings.DB, {
          current,
          index: 0,
          pairingId: "10000000-0000-4000-8000-000000000301",
          sessionId: sessionA,
          userId: userA,
        }).then(() =>
          seedUser(bindings.DB, {
            current,
            index: 1,
            pairingId: "10000000-0000-4000-8000-000000000302",
            sessionId: sessionB,
            userId: userB,
          })
        )
      );
      return { bucket: bindings.BUCKET, db: bindings.DB };
    })
  );

afterEach(() =>
  Effect.runPromise(
    fromTestPromise(() => Promise.all(instances.splice(0).map((miniflare) => miniflare.dispose())))
  )
);

const coreEnvironment = (runtime: Runtime): Parameters<typeof coreWorker.fetch>[1] => ({
  AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
  BROWSER_ORIGIN: browserOrigin,
  CLOUDFLARE_ACCESS_AUDIENCE: "",
  CLOUDFLARE_ACCESS_ISSUER: "",
  CONTRACT_DIGEST: "a".repeat(64),
  DB: runtime.db,
  HOSTED_AI_MODEL: approvedWorkersAiModel,
  KAPSO_API_KEY: "",
  KAPSO_WEBHOOK_SECRET: "",
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  STATEMENT_STAGING_BUCKET: runtime.bucket,
  USER_TRANSACTION_COORDINATOR: {
    getByName: (name: string): Pick<Fetcher, "fetch"> => ({
      fetch: (command: Request): Promise<Response> =>
        new UserTransactionCoordinator(
          { id: { name } },
          { DB: runtime.db, STATEMENT_STAGING_BUCKET: runtime.bucket }
        ).fetch(new Request(command)),
    }),
  },
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
  WOMPI_ENVIRONMENT: "",
  WOMPI_INTEGRITY_SECRET: "",
  WOMPI_PRIVATE_KEY: "",
  WOMPI_PUBLIC_KEY: "",
});

const send = (runtime: Runtime, request: Request): Promise<Response> => {
  const core = coreEnvironment(runtime);
  return publicWorker.fetch(request, {
    BROWSER_ORIGIN: browserOrigin,
    CORE: { fetch: (internal) => coreWorker.fetch(new Request(internal), core) },
    LOCAL_CANONICAL_READ_BEARER: "",
    PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  });
};

const sessionHeaders = (index: number): Record<string, string> => ({
  cookie: `__Host-fidy_session=${bearer(index)}`,
  origin: browserOrigin,
});

const upload = (
  runtime: Runtime,
  input: Readonly<{ index: number; body: BodyInit }>
): Promise<Response> =>
  send(
    runtime,
    new Request("https://api.fidyapp.com/ingestion/statements/bytes", {
      body: input.body,
      headers: sessionHeaders(input.index),
      method: "POST",
    })
  );

const uploadWithBearer = (
  runtime: Runtime,
  input: Readonly<{ body: BodyInit; token: string }>
): Promise<Response> =>
  send(
    runtime,
    new Request("https://api.fidyapp.com/ingestion/statements/bytes", {
      body: input.body,
      headers: { authorization: `Bearer ${input.token}`, origin: browserOrigin },
      method: "POST",
    })
  );

const submit = (
  runtime: Runtime,
  input: Readonly<{
    index: number;
    idempotencyKey: string;
    reference: Readonly<{ stagingId: string; byteLength: number; sha256: string }>;
  }>
): Promise<Response> =>
  send(
    runtime,
    new Request("https://api.fidyapp.com/ingestion/statements", {
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        reference: input.reference,
      }),
      headers: { "content-type": "application/json", ...sessionHeaders(input.index) },
      method: "POST",
    })
  );

const submitWithBearer = (
  runtime: Runtime,
  input: Readonly<{
    idempotencyKey: string;
    reference: Readonly<{ stagingId: string; byteLength: number; sha256: string }>;
    token: string;
  }>
): Promise<Response> =>
  send(
    runtime,
    new Request("https://api.fidyapp.com/ingestion/statements", {
      body: JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        reference: input.reference,
      }),
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        origin: browserOrigin,
      },
      method: "POST",
    })
  );

const getSubmission = (runtime: Runtime, index: number, id: string): Promise<Response> =>
  send(
    runtime,
    new Request(`https://api.fidyapp.com/ingestion/statements/${id}`, {
      headers: sessionHeaders(index),
      method: "GET",
    })
  );

const getSubmissionWithBearer = (runtime: Runtime, id: string, token: string): Promise<Response> =>
  send(
    runtime,
    new Request(`https://api.fidyapp.com/ingestion/statements/${id}`, {
      headers: { authorization: `Bearer ${token}`, origin: browserOrigin },
      method: "GET",
    })
  );

const batchCallId = (suffix: number): string =>
  `20000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const batchCategory = "10000000-0000-4000-8000-000000000016";

/** One canonical manual capture child, exactly as an atomic batch call carries it. */
const captureCall = (suffix: number): object => ({
  callId: batchCallId(suffix),
  operation: "transactions.createTransaction",
  input: {
    payload: {
      categoryId: batchCategory,
      direction: "outflow",
      money: { amount: "45000.00", currency: "COP" },
      occurredAt: "2026-08-01T12:00:00.000Z",
    },
  },
});

/** One canonical correction child addressing a seeded Transaction at an observed revision. */
const correctionCall = (suffix: number, id: string, expectedRevision: number): object => ({
  callId: batchCallId(suffix),
  operation: "transactions.updateTransaction",
  input: { params: { id }, payload: { expectedRevision, changes: { notes: "late" } } },
});

/** One canonical statement child citing an already-staged reference, never raw bytes. */
const statementCall = (
  suffix: number,
  input: Readonly<{ idempotencyKey: string; reference: StagedData }>
): object => ({
  callId: batchCallId(suffix),
  operation: "ingestion.submitForExtraction",
  input: {
    payload: {
      idempotencyKey: input.idempotencyKey,
      reference: {
        byteLength: input.reference.byteLength,
        sha256: input.reference.sha256,
        stagingId: input.reference.stagingId,
      },
    },
  },
});

const batch = (runtime: Runtime, index: number, calls: ReadonlyArray<object>): Promise<Response> =>
  send(
    runtime,
    new Request("https://api.fidyapp.com/operations/atomic-batch", {
      body: JSON.stringify({ calls }),
      headers: { "content-type": "application/json", ...sessionHeaders(index) },
      method: "POST",
    })
  );

const batchWithBearer = (
  runtime: Runtime,
  token: string,
  calls: ReadonlyArray<object>
): Promise<Response> =>
  send(
    runtime,
    new Request("https://api.fidyapp.com/operations/atomic-batch", {
      body: JSON.stringify({ calls }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: browserOrigin,
      },
      method: "POST",
    })
  );

/** A D1 binding whose unit batch always fails, so a defect can never leave partial state. */
const defectiveDb = (db: D1Database): D1Database =>
  new Proxy(db, {
    get: (target, property): unknown =>
      property === "batch"
        ? (): Promise<never> => Promise.reject(new Error("D1 unit defect"))
        : Reflect.get(target, property, target),
  });

/** Runs one competing write before the first unit batch, moving a premise after preparation. */
const beforeBatchDb = (db: D1Database, before: () => Promise<unknown>): D1Database => {
  let fired = false;
  return new Proxy(db, {
    get: (target, property): unknown =>
      property === "batch"
        ? (...args: Parameters<D1Database["batch"]>): ReturnType<D1Database["batch"]> => {
            if (fired) return target.batch(...args);
            fired = true;
            return before().then(() => target.batch(...args));
          }
        : Reflect.get(target, property, target),
  });
};

/** Seeds one retained Transaction directly, so a correction has a premise the unit re-checks. */
const seedTransaction = (
  runtime: Runtime,
  input: Readonly<{ id: string; userId: string }>
): Promise<unknown> =>
  runtime.db
    .prepare(
      `INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, notes,
         occurred_at, created_at)
       VALUES (?, ?, '10.00', 'COP', 'outflow', ?, 'seed', '2026-08-01T12:00:00.000Z',
         '2026-08-01T12:00:00.000Z')`
    )
    .bind(input.id, input.userId, batchCategory)
    .run();

/** Advances one seeded Transaction to revision 1 through the same evidence a real correction keeps. */
const concurrentCorrection = (
  runtime: Runtime,
  input: Readonly<{ evidenceId: string; id: string; userId: string }>
): Promise<unknown> =>
  runtime.db
    .prepare(
      `INSERT INTO transaction_corrections (id, user_id, transaction_id, previous_revision,
         changed_fields, before_facts, after_facts, corrected_at)
       VALUES (?, ?, ?, 0, '["notes"]', '{"notes":"seed"}', '{"notes":"concurrent"}',
         '2026-08-01T12:00:00.000Z')`
    )
    .bind(input.evidenceId, input.userId, input.id)
    .run()
    .then(() =>
      runtime.db
        .prepare(
          "UPDATE transactions SET notes = 'concurrent', revision = 1 WHERE user_id = ? AND id = ? AND revision = 0"
        )
        .bind(input.userId, input.id)
        .run()
    );

const StagedResponse = Schema.Struct({
  data: Schema.Struct({
    byteLength: Schema.Int,
    expiresAt: Schema.String,
    sha256: StatementContentDigest,
    sourceFormat: StatementSourceFormat,
    stagingId: StatementStagingId,
  }),
  next: Schema.Array(Schema.Unknown),
});
const SubmissionResponse = Schema.Struct({
  data: Schema.Struct({
    id: StatementSubmissionId,
    parserRevision: Schema.String,
    sourceFormat: StatementSourceFormat,
    status: Schema.String,
    submittedAt: Schema.String,
  }),
  next: Schema.Array(Schema.Unknown),
});
const FailureResponse = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  next: Schema.Array(Schema.Unknown),
});
/** One committed atomic batch envelope; each child output is decoded against its own schema. */
const BatchEnvelope = Schema.Struct({
  data: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        operation: Schema.String,
        output: Schema.Unknown,
      })
    ),
  }),
  next: Schema.Array(Schema.Unknown),
});
/** One rejected atomic batch, before its child-specific failure details are asserted. */
const BatchRejection = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    failedCallIndex: Schema.Int,
    message: Schema.String,
    operation: Schema.String,
  }),
  next: Schema.Array(Schema.Unknown),
});

type StagedData = (typeof StagedResponse.Type)["data"];
type SubmissionData = (typeof SubmissionResponse.Type)["data"];

const failureCode = (response: Response): Promise<string> =>
  response
    .json()
    .then((body) => Schema.decodeUnknownSync(FailureResponse)(body))
    .then((body) => body.error.code);

/** Stages one CSV file and returns both the raw response and the decoded acknowledgement. */
const stageOne = (
  runtime: Runtime,
  index = 0,
  body: BodyInit = statementBytes()
): Promise<Readonly<{ response: Response; staged: StagedData }>> =>
  upload(runtime, { body, index }).then((response) =>
    response.json().then((decoded) => ({
      response,
      staged: Schema.decodeUnknownSync(StagedResponse)(decoded).data,
    }))
  );

const submissionOf = (response: Response): Promise<SubmissionData> =>
  response
    .json()
    .then((body) => Schema.decodeUnknownSync(SubmissionResponse)(body))
    .then(({ data }) => data);

/** One committed batch body decoded through its exact envelope; child outputs stay unknown. */
const batchEnvelopeOf = (response: Response): Promise<typeof BatchEnvelope.Type> =>
  response.json().then((body) => Schema.decodeUnknownSync(BatchEnvelope)(body));

/** One already-read batch body decoded through its exact envelope, preserving it for messages. */
const batchEnvelopeFrom = (body: string): typeof BatchEnvelope.Type =>
  Schema.decodeSync(Schema.fromJsonString(BatchEnvelope))(body);

/** One committed statement child output decoded into the canonical submission projection. */
const batchSubmissionOf = (output: unknown): SubmissionData =>
  Schema.decodeUnknownSync(SubmissionResponse)(output).data;

/** One rejected batch body decoded into its child-specific failure details. */
const batchRejectionOf = (response: Response): Promise<typeof BatchRejection.Type> =>
  response.json().then((body) => Schema.decodeUnknownSync(BatchRejection)(body));

type StagedBody = Readonly<{ body: string; staged: StagedData }>;

/** Reads one staging response body as text, keeping the raw spelling for content-leak scans. */
const stagedBodyOf = (response: Response): Promise<string> => response.text();

/** Decodes one staging acknowledgement out of its preserved body text. */
const stagedWithBody = (body: string): StagedBody => ({
  body,
  staged: Schema.decodeSync(Schema.fromJsonString(StagedResponse))(body).data,
});

const count = (db: D1Database, table: string): Promise<number> =>
  db
    .prepare(`SELECT count(*) AS total FROM ${table}`)
    .first<{ total: number }>()
    .then((row) => row?.total ?? -1);

const scalar = <A>(db: D1Database, sql: string, ...bindings: ReadonlyArray<string>): Promise<A> =>
  db
    .prepare(sql)
    .bind(...bindings)
    .first<A>()
    .then((row) => {
      if (row === null) throw new Error("Expected one row");
      return row;
    });

/** One D1 row decoded through its exact schema; absence is an exception, not a value. */
const firstRow = <A, E>(
  db: D1Database,
  schema: Schema.Codec<A, E>,
  sql: string,
  ...bindings: ReadonlyArray<string>
): Promise<A> =>
  db
    .prepare(sql)
    .bind(...bindings)
    .first()
    .then((row) => Schema.decodeUnknownSync(schema)(row));

const submissionStateRow = Schema.Struct({
  completed_at_ms: Schema.OptionFromNullOr(Schema.Int),
  failure_reason: Schema.OptionFromNullOr(Schema.String),
  status: Schema.String,
});
const entitlementRow = Schema.Struct({
  consumed_at_ms: Schema.OptionFromNullOr(Schema.Int),
  submission_id: Schema.OptionFromNullOr(Schema.String),
});
const reclaimedStagingRow = Schema.Struct({
  object_deleted_at_ms: Schema.OptionFromNullOr(Schema.Int),
  object_key: Schema.String,
  status: Schema.String,
});
const patActivityRow = Schema.Struct({ last_used_at_ms: Schema.OptionFromNullOr(Schema.Int) });

/** One query's raw rows as a JSON string, for content-leak scans of every stored column. */
const rowsJson = (result: D1Result<unknown>): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(result.results);

const stagedObjectKeys = (runtime: Runtime): Promise<ReadonlyArray<string>> =>
  runtime.bucket
    .list({ prefix: "staging/statement/v1/" })
    .then((result) => result.objects.map(({ key }) => key));

/** Seeds one submission row directly, to isolate admission bounds and retention from publication. */
const seedSubmission = (
  runtime: Runtime,
  input: Readonly<{
    userId: string;
    submittedAtMs: number;
    seed: number;
    status: "queued" | "processing" | "completed";
  }>
): Promise<void> => {
  const suffix = String(input.seed).padStart(12, "0");
  const submissionId = `50000000-0000-4000-8000-${suffix}`;
  const stagingId = `60000000-0000-4000-8000-${suffix}`;
  const idempotencyKey = `70000000-0000-4000-8000-${suffix}`;
  const retention = input.submittedAtMs + dayMilliseconds;
  const submissionStatements = {
    completed: (): D1PreparedStatement =>
      runtime.db
        .prepare(
          `INSERT INTO statement_submissions (id, user_id, idempotency_key, staging_id, submitted_at_ms,
             source_format, parser_revision, service_market, locale, time_zone, status,
             retention_expires_at_ms, started_at_ms, completed_at_ms, input_rows, accepted_rows,
             needs_review_rows)
           VALUES (?, ?, ?, ?, ?, 'csv', 'statement-parser-v1', 'CO', 'es-CO', 'America/Bogota',
             'completed', ?, ?, ?, 0, 0, 0)`
        )
        .bind(
          submissionId,
          input.userId,
          idempotencyKey,
          stagingId,
          input.submittedAtMs,
          retention,
          input.submittedAtMs,
          input.submittedAtMs
        ),
    processing: (): D1PreparedStatement =>
      runtime.db
        .prepare(
          `INSERT INTO statement_submissions (id, user_id, idempotency_key, staging_id, submitted_at_ms,
             source_format, parser_revision, service_market, locale, time_zone, status,
             retention_expires_at_ms, started_at_ms)
           VALUES (?, ?, ?, ?, ?, 'csv', 'statement-parser-v1', 'CO', 'es-CO', 'America/Bogota',
             'processing', ?, ?)`
        )
        .bind(
          submissionId,
          input.userId,
          idempotencyKey,
          stagingId,
          input.submittedAtMs,
          retention,
          input.submittedAtMs
        ),
    queued: (): D1PreparedStatement =>
      runtime.db
        .prepare(
          `INSERT INTO statement_submissions (id, user_id, idempotency_key, staging_id, submitted_at_ms,
             source_format, parser_revision, service_market, locale, time_zone, status,
             retention_expires_at_ms)
           VALUES (?, ?, ?, ?, ?, 'csv', 'statement-parser-v1', 'CO', 'es-CO', 'America/Bogota',
             'queued', ?)`
        )
        .bind(
          submissionId,
          input.userId,
          idempotencyKey,
          stagingId,
          input.submittedAtMs,
          retention
        ),
  };
  return runtime.db
    .batch([
      runtime.db
        .prepare(
          `INSERT INTO statement_staging_objects (id, user_id, object_key, byte_length, sha256,
             source_format, status, created_at_ms, expires_at_ms, published_submission_id)
           VALUES (?, ?, ?, 8, ?, 'csv', 'published', ?, ?, ?)`
        )
        .bind(
          stagingId,
          input.userId,
          `staging/statement/v1/seed-${input.seed}`,
          "a".repeat(64),
          input.submittedAtMs,
          retention,
          submissionId
        ),
      submissionStatements[input.status](),
    ])
    .then(() => undefined);
};

/** Seeds a contiguous seed range sequentially, so each insert sees the previous one committed. */
const seedSubmissions = (
  runtime: Runtime,
  input: Readonly<{
    first: number;
    last: number;
    userId: string;
    submittedAtMs: number;
    status: "queued" | "processing" | "completed";
  }>
): Promise<void> =>
  Array.from({ length: input.last - input.first + 1 }, (_, index) => input.first + index).reduce(
    (previous, seed) =>
      previous.then(() =>
        seedSubmission(runtime, {
          seed,
          status: input.status,
          submittedAtMs: input.submittedAtMs,
          userId: input.userId,
        })
      ),
    Promise.resolve()
  );

it(
  "stages one statement into private R2 and publishes a visible queued submission",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { response, staged } = yield* fromTestPromise(() => stageOne(runtime));

        expect(response.status).toBe(201);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(staged.sourceFormat).toBe("csv");
        expect(staged.byteLength).toBe(statementBytes().byteLength);
        const [objectKey] = yield* fromTestPromise(() => stagedObjectKeys(runtime));
        // The opaque locator stays server-only: it is neither the staging id nor content-derived.
        expect(objectKey?.startsWith("staging/statement/v1/")).toBe(true);
        expect(Object.values(staged)).not.toContain(objectKey);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);

        const idempotencyKey = "20000000-0000-4000-8000-000000000901";
        const first = yield* fromTestPromise(() =>
          submit(runtime, { idempotencyKey, index: 0, reference: staged })
        );
        expect(first.status).toBe(202);
        const published = yield* fromTestPromise(() => submissionOf(first));
        expect(published).toMatchObject({
          parserRevision: "statement-parser-v1",
          sourceFormat: "csv",
          status: "queued",
        });

        const replayed = yield* fromTestPromise(() =>
          submit(runtime, { idempotencyKey, index: 0, reference: staged })
        );
        expect(replayed.status).toBe(202);
        expect(yield* fromTestPromise(() => submissionOf(replayed))).toEqual(published);

        const visible = yield* fromTestPromise(() => getSubmission(runtime, 0, published.id));
        expect(visible.status).toBe(200);
        expect(yield* fromTestPromise(() => submissionOf(visible))).toEqual(published);
        const foreign = yield* fromTestPromise(() => getSubmission(runtime, 1, published.id));
        expect(foreign.status).toBe(404);

        // One authoritative row and one attributable audit row per canonical call: the publication,
        // its replay, and each read (success for the owner, not-found for the foreign caller).
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);
        const audits = yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              `SELECT operation, outcome, count(*) AS total FROM statement_submission_audit
               GROUP BY operation, outcome ORDER BY operation, outcome`
            )
            .all<{ operation: string; outcome: string; total: number }>()
        );
        expect(audits.results).toEqual([
          { operation: "ingestion.getStatementSubmission", outcome: "not_found", total: 1 },
          { operation: "ingestion.getStatementSubmission", outcome: "success", total: 1 },
          { operation: "ingestion.submitForExtraction", outcome: "success", total: 2 },
        ]);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_ingestion_outbox"))).toBe(
          1
        );
        expect(
          yield* fromTestPromise(() =>
            scalar<{ status: string; source_format: string }>(
              runtime.db,
              "SELECT status, source_format FROM statement_staging_objects"
            )
          )
        ).toEqual({ source_format: "csv", status: "published" });
      })
    ),
  30_000
);

it(
  "refuses oversized, unsupported, and empty uploads before any durable work",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const oversized = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new Uint8Array(5 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.close();
          },
        });
        const tooLarge = yield* fromTestPromise(() =>
          upload(runtime, { body: oversized, index: 0 })
        );
        expect(tooLarge.status).toBe(413);

        // A PDF claim is refused because of its actual signature, not a declared media type.
        const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
        const unsupported = yield* fromTestPromise(() => upload(runtime, { body: pdf, index: 0 }));
        expect(unsupported.status).toBe(400);
        expect(yield* fromTestPromise(() => failureCode(unsupported))).toBe("validation_failed");

        const empty = yield* fromTestPromise(() =>
          upload(runtime, { body: new Uint8Array(), index: 0 })
        );
        expect(empty.status).toBe(400);

        expect(yield* fromTestPromise(() => count(runtime.db, "statement_staging_objects"))).toBe(
          0
        );
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
        expect(yield* fromTestPromise(() => stagedObjectKeys(runtime))).toHaveLength(0);
      })
    ),
  30_000
);

it(
  "stages bytes only for a live browser session, never for a bearer or an anonymous caller",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const anonymous = yield* fromTestPromise(() =>
          send(
            runtime,
            new Request("https://api.fidyapp.com/ingestion/statements/bytes", {
              body: statementBytes(),
              headers: { origin: browserOrigin },
              method: "POST",
            })
          )
        );
        // A PAT bearer performs for the API, but byte staging stays a browser-session capability.
        const withBearer = yield* fromTestPromise(() =>
          uploadWithBearer(runtime, {
            body: statementBytes(),
            token: `fin_${"w".repeat(8)}_${"a".repeat(43)}`,
          })
        );
        const unknownSession = yield* fromTestPromise(() =>
          send(
            runtime,
            new Request("https://api.fidyapp.com/ingestion/statements/bytes", {
              body: statementBytes(),
              headers: {
                cookie: `__Host-fidy_session=${"z".repeat(43)}`,
                origin: browserOrigin,
              },
              method: "POST",
            })
          )
        );

        expect(anonymous.status).toBe(401);
        expect(withBearer.status).toBe(401);
        expect(unknownSession.status).toBe(401);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_staging_objects"))).toBe(
          0
        );
        expect(yield* fromTestPromise(() => stagedObjectKeys(runtime))).toHaveLength(0);
      })
    ),
  30_000
);

it(
  "never lets statement content or an object locator reach a response or a row",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const uploaded = yield* fromTestPromise(() =>
          upload(runtime, { body: statementBytes(), index: 0 })
            .then(stagedBodyOf)
            .then(stagedWithBody)
        );
        const { body: uploadBody, staged } = uploaded;
        const submitResponse = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000902",
            index: 0,
            reference: staged,
          })
        );
        const mismatched = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000903",
            index: 0,
            reference: { ...staged, sha256: "0".repeat(64) },
          })
        );

        const bodies = yield* fromTestPromise(() =>
          Promise.all([Promise.resolve(uploadBody), submitResponse.text(), mismatched.text()])
        );
        for (const body of bodies) {
          expect(body).not.toContain(secretSentinel);
          expect(body).not.toContain("fecha,valor");
          expect(body).not.toContain("staging/statement/v1/");
        }

        const rows = yield* fromTestPromise(() =>
          Promise.all(
            [
              "statement_staging_objects",
              "statement_submissions",
              "statement_submission_audit",
              "statement_ingestion_outbox",
            ].map((table) => runtime.db.prepare(`SELECT * FROM ${table}`).all().then(rowsJson))
          )
        );
        for (const row of rows) {
          expect(row).not.toContain(secretSentinel);
          expect(row).not.toContain("fecha,valor");
        }
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);
        expect(mismatched.status).toBe(400);
        expect(submitResponse.status).toBe(202);
      })
    ),
  30_000
);

it(
  "refuses a cross-User or tampered staged reference without creating authoritative state",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));

        const foreign = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000904",
            index: 1,
            reference: staged,
          })
        );
        expect(foreign.status).toBe(400);
        const tampered = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000905",
            index: 0,
            reference: { ...staged, byteLength: staged.byteLength + 1 },
          })
        );
        expect(tampered.status).toBe(400);

        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_ingestion_outbox"))).toBe(
          0
        );
        // Both refusals stay attributable through metadata-only audit rows, and neither creates
        // authoritative state: a foreign caller's miss and the owner's tampered reference.
        const refusals = yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              `SELECT user_id, operation, outcome FROM statement_submission_audit
               ORDER BY user_id`
            )
            .all<{ user_id: string; operation: string; outcome: string }>()
        );
        expect(refusals.results).toEqual([
          {
            user_id: userA,
            operation: "ingestion.submitForExtraction",
            outcome: "validation_failed",
          },
          {
            user_id: userB,
            operation: "ingestion.submitForExtraction",
            outcome: "validation_failed",
          },
        ]);
        // The real owner can still publish the untouched material.
        const owned = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000906",
            index: 0,
            reference: staged,
          })
        );
        expect(owned.status).toBe(202);
      })
    ),
  30_000
);

it(
  "bounds concurrent uploads with a released outstanding-work lease",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const held: Array<PromiseWithResolvers<void>> = [];
        const openUpload = (): Promise<Response> => {
          const release = Promise.withResolvers<void>();
          held.push(release);
          const stream = new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(statementBytes("fecha,valor\n"));
              release.promise
                .then(() => {
                  controller.close();
                })
                .catch(() => undefined);
            },
          });
          return upload(runtime, { body: stream, index: 0 });
        };
        const first = openUpload();
        const second = openUpload();
        const outstanding = (): Promise<number> =>
          scalar<{ total: number }>(
            runtime.db,
            `SELECT count(*) AS total FROM resource_admission_events
             WHERE policy_key = 'ingestion.upload.outstanding.v1' AND released_at_epoch_ms IS NULL`
          ).then(({ total }) => total);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if ((yield* fromTestPromise(outstanding)) >= 2) break;
          yield* Effect.sleep("10 millis");
        }
        expect(yield* fromTestPromise(outstanding)).toBe(2);

        const refused = yield* fromTestPromise(() =>
          upload(runtime, { body: statementBytes(), index: 0 })
        );
        expect(refused.status).toBe(429);
        expect(yield* fromTestPromise(() => failureCode(refused))).toBe("rate_limited");

        for (const release of held) release.resolve();
        const settled = yield* fromTestPromise(() => Promise.all([first, second]));
        expect(settled.map(({ status }) => status)).toEqual([201, 201]);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_staging_objects"))).toBe(
          2
        );
      })
    ),
  30_000
);

it(
  "enforces the Free backfill, then restores it when the queued submission expires",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const first = yield* fromTestPromise(() => stageOne(runtime));
        const queued = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000907",
            index: 0,
            reference: first.staged,
          })
        );
        expect(queued.status).toBe(202);

        const second = yield* fromTestPromise(() => stageOne(runtime));
        const paywalled = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000908",
            index: 0,
            reference: second.staged,
          })
        );
        expect(paywalled.status).toBe(402);
        expect(yield* fromTestPromise(() => failureCode(paywalled))).toBe("paywall_required");
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);

        // A queued submission past its retention bound fails visibly and frees its material.
        const expired = yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              "UPDATE statement_submissions SET submitted_at_ms = 0, retention_expires_at_ms = 1"
            )
            .run()
        );
        expect(expired.meta.changes).toBe(1);
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              `UPDATE statement_staging_objects SET created_at_ms = 0, expires_at_ms = 1
               WHERE id IN (SELECT staging_id FROM statement_submissions)`
            )
            .run()
        );
        yield* fromTestPromise(() =>
          coreWorker.scheduled(
            { cron: "* * * * *", noRetry: () => undefined, scheduledTime: 0 },
            coreEnvironment(runtime)
          )
        );

        const submissionState = yield* fromTestPromise(() =>
          firstRow(
            runtime.db,
            submissionStateRow,
            "SELECT status, failure_reason, completed_at_ms FROM statement_submissions"
          )
        );
        expect(submissionState.status).toBe("failed");
        expect(submissionState.failure_reason).toEqual(Option.some("retention-expired"));
        expect(Option.isSome(submissionState.completed_at_ms)).toBe(true);
        const entitlement = yield* fromTestPromise(() =>
          firstRow(
            runtime.db,
            entitlementRow,
            "SELECT consumed_at_ms, submission_id FROM statement_backfill_entitlements"
          )
        );
        expect(Option.isNone(entitlement.consumed_at_ms)).toBe(true);
        expect(Option.isNone(entitlement.submission_id)).toBe(true);
        // The failed submission's own material is reclaimed; the User's next staged file is not.
        const reclaimed = yield* fromTestPromise(() =>
          firstRow(
            runtime.db,
            reclaimedStagingRow,
            `SELECT staging.object_key, staging.object_deleted_at_ms, staging.status
             FROM statement_staging_objects AS staging
             JOIN statement_submissions AS submission ON submission.staging_id = staging.id`
          )
        );
        expect(reclaimed.status).toBe("deleting");
        expect(Option.isSome(reclaimed.object_deleted_at_ms)).toBe(true);
        expect(yield* fromTestPromise(() => runtime.bucket.head(reclaimed.object_key))).toBeNull();
        expect(yield* fromTestPromise(() => stagedObjectKeys(runtime))).toHaveLength(1);

        const restored = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000909",
            index: 0,
            reference: second.staged,
          })
        );
        expect(restored.status).toBe(202);
      })
    ),
  30_000
);

it(
  "fails an expired submission whose extraction already started and reclaims its object",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const current = yield* Clock.currentTimeMillis;
        yield* fromTestPromise(() =>
          seedSubmission(runtime, {
            seed: 31,
            status: "processing",
            submittedAtMs: current - dayMilliseconds - 60_000,
            userId: userA,
          })
        );
        yield* fromTestPromise(() =>
          coreWorker.scheduled(
            { cron: "* * * * *", noRetry: () => undefined, scheduledTime: 0 },
            coreEnvironment(runtime)
          )
        );

        // An extraction that started but never produced an outcome cannot outlive retention either.
        const submissionState = yield* fromTestPromise(() =>
          firstRow(
            runtime.db,
            submissionStateRow,
            "SELECT status, failure_reason, completed_at_ms FROM statement_submissions WHERE user_id = ?",
            userA
          )
        );
        expect(submissionState.status).toBe("failed");
        expect(submissionState.failure_reason).toEqual(Option.some("retention-expired"));
        expect(Option.isSome(submissionState.completed_at_ms)).toBe(true);
        const reclaimed = yield* fromTestPromise(() =>
          firstRow(
            runtime.db,
            reclaimedStagingRow,
            `SELECT staging.object_key, staging.object_deleted_at_ms, staging.status
             FROM statement_staging_objects AS staging
             JOIN statement_submissions AS submission ON submission.staging_id = staging.id`
          )
        );
        expect(reclaimed.status).toBe("deleting");
        expect(Option.isSome(reclaimed.object_deleted_at_ms)).toBe(true);
      })
    ),
  30_000
);

it(
  "refuses submissions beyond the outstanding and rolling-hour limits",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const current = yield* Clock.currentTimeMillis;
        yield* fromTestPromise(() =>
          seedSubmissions(runtime, {
            first: 1,
            last: 5,
            status: "queued",
            submittedAtMs: current - 1_000,
            userId: userA,
          })
        );
        const staged = yield* fromTestPromise(() => stageOne(runtime));
        const outstanding = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000910",
            index: 0,
            reference: staged.staged,
          })
        );
        expect(outstanding.status).toBe(400);
        expect(yield* fromTestPromise(() => failureCode(outstanding))).toBe("validation_failed");
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(5);

        // Pro standing skips the Free allowance but never the submission pressure bounds.
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              "INSERT INTO trial_periods (user_id, started_at_ms, ends_at_ms) VALUES (?, ?, ?)"
            )
            .bind(userB, current - dayMilliseconds, current - dayMilliseconds + 604_800_000)
            .run()
        );
        yield* fromTestPromise(() =>
          seedSubmissions(runtime, {
            first: 6,
            last: 25,
            status: "completed",
            submittedAtMs: current - 2_000,
            userId: userB,
          })
        );
        const proStaged = yield* fromTestPromise(() => stageOne(runtime, 1));
        const hourly = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000911",
            index: 1,
            reference: proStaged.staged,
          })
        );
        expect(hourly.status).toBe(400);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(25);
      })
    ),
  30_000
);

it(
  "accounts for an agent submission through the same canonical publication",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const token = `fin_${"w".repeat(8)}_${"a".repeat(43)}`;
        const tokenDigest = yield* fromTestPromise(() => digest(token));
        const current = yield* Clock.currentTimeMillis;
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              `INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json,
                 lifetime_days, created_at_ms, issued_at_ms, expires_at_ms, request_id)
               VALUES (?, ?, ?, ?, 'Statement agent', '["read","write"]', 7, ?, ?, ?, ?)`
            )
            .bind(
              "40000000-0000-4000-8000-000000000001",
              userA,
              token.slice("fin_".length, "fin_".length + 8),
              tokenDigest,
              current,
              current,
              current + 7 * dayMilliseconds,
              "40000000-0000-4000-9000-000000000001"
            )
            .run()
        );
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const submitted = yield* fromTestPromise(() =>
          submitWithBearer(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000912",
            reference: staged,
            token,
          })
        );

        const submittedBody = yield* fromTestPromise(() => submitted.clone().text());
        expect(submitted.status, submittedBody).toBe(202);
        const published = yield* fromTestPromise(() => submissionOf(submitted));
        const readBack = yield* fromTestPromise(() =>
          getSubmissionWithBearer(runtime, published.id, token)
        );
        expect(readBack.status).toBe(200);
        expect(yield* fromTestPromise(() => submissionOf(readBack))).toEqual(published);

        // A refused PAT submission is attributable as one rejected canonical audit row, and still
        // leaves no statement audit row and no authoritative submission behind.
        const foreign = yield* fromTestPromise(() => stageOne(runtime, 1));
        const refused = yield* fromTestPromise(() =>
          submitWithBearer(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000914",
            reference: foreign.staged,
            token,
          })
        );
        expect(refused.status).toBe(400);

        const audit = yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              "SELECT operation, outcome FROM pat_audit WHERE pat_id IS NOT NULL ORDER BY rowid"
            )
            .all<{ operation: string; outcome: string }>()
        );
        expect(audit.results).toEqual([
          { operation: "ingestion.submitForExtraction", outcome: "accepted" },
          { operation: "ingestion.getStatementSubmission", outcome: "accepted" },
          { operation: "ingestion.submitForExtraction", outcome: "rejected" },
        ]);
        // A PAT call is audited once, in pat_audit: the statement audit keeps only the publication.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          1
        );
        expect(
          yield* fromTestPromise(() =>
            firstRow(
              runtime.db,
              patActivityRow,
              "SELECT last_used_at_ms FROM pats WHERE id = ?",
              "40000000-0000-4000-8000-000000000001"
            )
          )
        ).toMatchObject({ last_used_at_ms: Option.some(expect.any(Number)) });
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);
      })
    ),
  30_000
);

it(
  "audits a malformed submission id as absent without echoing it",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const malformed = yield* fromTestPromise(() => getSubmission(runtime, 0, "not-a-uuid"));
        expect(malformed.status).toBe(404);

        const audit = yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              `SELECT operation, outcome, count(*) AS total FROM statement_submission_audit
               GROUP BY operation, outcome`
            )
            .all<{ operation: string; outcome: string; total: number }>()
        );
        expect(audit.results).toEqual([
          { operation: "ingestion.getStatementSubmission", outcome: "not_found", total: 1 },
        ]);
        const rows = yield* fromTestPromise(() =>
          runtime.db.prepare("SELECT * FROM statement_submission_audit").all().then(rowsJson)
        );
        expect(rows).not.toContain("not-a-uuid");
      })
    ),
  30_000
);

it(
  "refuses an expired session before any read audit commits",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        yield* fromTestPromise(() =>
          runtime.db.prepare("UPDATE web_sessions SET idle_expires_at_ms = created_at_ms").run()
        );
        const refused = yield* fromTestPromise(() =>
          getSubmission(runtime, 0, "50000000-0000-4000-8000-000000000999")
        );
        expect(refused.status).toBe(401);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          0
        );
      })
    ),
  30_000
);

it(
  "bounds canonical statement work with the shared daily budget and leaves staging open",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const current = yield* Clock.currentTimeMillis;
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              `WITH RECURSIVE budget(value) AS (
                 SELECT 1 UNION ALL SELECT value + 1 FROM budget WHERE value < 256
               )
               INSERT INTO statement_submission_audit (id, user_id, operation, outcome, occurred_at_ms)
               SELECT '90000000-0000-4000-8000-' || substr('000000000000' || value, -12),
                      ?, 'ingestion.getStatementSubmission', 'success', ?
               FROM budget`
            )
            .bind(userA, current)
            .run()
        );

        const refused = yield* fromTestPromise(() =>
          getSubmission(runtime, 0, "50000000-0000-4000-8000-000000000999")
        );
        expect(refused.status).toBe(429);
        expect(yield* fromTestPromise(() => failureCode(refused))).toBe("rate_limited");

        // The same spent budget refuses canonical publication, while byte staging stays open:
        // the budget bounds canonical work, not the non-authoritative transport that feeds it.
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const submitted = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000913",
            index: 0,
            reference: staged,
          })
        );
        expect(submitted.status).toBe(429);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
      })
    ),
  30_000
);

/** The idempotency key whose losing unit race must record exactly one refusal audit. */
const lostRaceIdempotencyKey = Schema.decodeSync(StatementIdempotencyKey)(
  "20000000-0000-4000-8000-000000000921"
);

it(
  "records one refusal audit when a publication loses its own unit race",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const current = yield* Clock.currentTimeMillis;
        const idempotencyKey = lostRaceIdempotencyKey;
        const { staged: winner } = yield* fromTestPromise(() => stageOne(runtime));
        const { staged: loser } = yield* fromTestPromise(() => stageOne(runtime));
        const subject = Option.getOrThrow(
          yield* fromTestPromise(() =>
            transactionSession({
              db: runtime.db,
              request: new Request("https://api.fidyapp.com/ingestion/statements", {
                headers: sessionHeaders(0),
              }),
            })
          )
        );

        // The winner commits after the losing call has read "no submission for this key" and before
        // its own conditional D1 unit runs, so only that unit can attribute the loss. One canonical
        // call remains one refusal: the unit's recorded refusal is answered without a second write.
        const database = beforeBatchDb(runtime.db, () =>
          executeStatementSubmission({
            current,
            environment: { DB: runtime.db, STATEMENT_STAGING_BUCKET: runtime.bucket },
            input: {
              idempotencyKey,
              reference: {
                byteLength: winner.byteLength,
                sha256: winner.sha256,
                stagingId: winner.stagingId,
              },
            },
            subject,
          }).then((response) => response.text())
        );
        const refused = yield* fromTestPromise(() =>
          executeStatementSubmission({
            current,
            environment: { DB: database, STATEMENT_STAGING_BUCKET: runtime.bucket },
            input: {
              idempotencyKey,
              reference: {
                byteLength: loser.byteLength,
                sha256: loser.sha256,
                stagingId: loser.stagingId,
              },
            },
            subject,
          })
        );
        expect(refused.status).toBe(400);
        expect(yield* fromTestPromise(() => failureCode(refused))).toBe("validation_failed");
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);
        expect(
          yield* fromTestPromise(() =>
            scalar<{ total: number }>(
              runtime.db,
              `SELECT count(*) AS total FROM statement_submission_audit
               WHERE user_id = ? AND outcome = 'validation_failed'`,
              userA
            )
          )
        ).toEqual({ total: 1 });
      })
    ),
  30_000
);

it(
  "refuses an unparseable canonical submission input before any staging lookup",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const malformed = yield* fromTestPromise(() =>
          send(
            runtime,
            new Request("https://api.fidyapp.com/ingestion/statements", {
              body: JSON.stringify({
                idempotencyKey: "not-a-uuid",
                reference: { byteLength: 1, sha256: "b".repeat(64), stagingId: "not-a-uuid" },
              }),
              headers: {
                "content-type": "application/json",
                ...sessionHeaders(0),
              },
              method: "POST",
            })
          )
        );
        expect(malformed.status).toBe(400);
        expect(yield* fromTestPromise(() => failureCode(malformed))).toBe("validation_failed");
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
      })
    ),
  30_000
);

it(
  "publishes a staged statement and another canonical mutation in one atomic batch",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const idempotencyKey = "20000000-0000-4000-8000-000000000920";

        const committed = yield* fromTestPromise(() =>
          batch(runtime, 0, [
            captureCall(1),
            statementCall(2, { idempotencyKey, reference: staged }),
          ])
        );
        const body = yield* fromTestPromise(() => committed.text());
        expect(committed.status, body).toBe(200);
        const envelope = batchEnvelopeFrom(body);
        expect(envelope.data.results.map(({ callId }) => callId)).toEqual([
          batchCallId(1),
          batchCallId(2),
        ]);
        expect(envelope.data.results.map(({ operation }) => operation)).toEqual([
          "transactions.createTransaction",
          "ingestion.submitForExtraction",
        ]);
        expect(batchSubmissionOf(envelope.data.results[1]?.output).status).toBe("queued");

        // One D1 unit committed both children, both metadata-only success audits, and the bounded
        // extraction identity; the staging row is promoted only because the submission exists.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_ingestion_outbox"))).toBe(
          1
        );
        expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(1);
        expect(yield* fromTestPromise(() => count(runtime.db, "transaction_audit"))).toBe(1);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          1
        );
        expect(
          yield* fromTestPromise(() =>
            firstRow(
              runtime.db,
              Schema.Struct({ matches: Schema.Int, status: Schema.String }),
              `SELECT staging.status AS status,
                      (staging.published_submission_id = submission.id
                        AND outbox.submission_id = submission.id) AS matches
               FROM statement_staging_objects AS staging
               JOIN statement_submissions AS submission ON submission.staging_id = staging.id
               JOIN statement_ingestion_outbox AS outbox ON outbox.submission_id = submission.id`
            )
          )
        ).toEqual({ matches: 1, status: "published" });
      })
    ),
  30_000
);

it(
  "rolls back a mixed batch when the statement child refuses at commit time",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const current = yield* Clock.currentTimeMillis;
        // The staged material expires after its child was admitted but before the unit commits.
        const raced = {
          ...runtime,
          db: beforeBatchDb(runtime.db, () =>
            runtime.db
              .prepare("UPDATE statement_staging_objects SET expires_at_ms = ? WHERE id = ?")
              .bind(current - 1, staged.stagingId)
              .run()
          ),
        };
        const refused = yield* fromTestPromise(() =>
          batch(raced, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000921",
              reference: staged,
            }),
          ])
        );
        expect(refused.status).toBe(400);
        const rejection = yield* fromTestPromise(() => batchRejectionOf(refused));
        expect(rejection.error).toMatchObject({
          code: "validation_failed",
          failedCallIndex: 1,
          operation: "ingestion.submitForExtraction",
        });

        // The earlier capture child and the statement success audit both rolled back; only the
        // statement child's own refusal audit remains, and the staged row was never promoted.
        expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "transaction_audit"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_ingestion_outbox"))).toBe(
          0
        );
        expect(
          yield* fromTestPromise(() => count(runtime.db, "statement_backfill_entitlements"))
        ).toBe(0);
        expect(
          yield* fromTestPromise(() =>
            firstRow(
              runtime.db,
              Schema.Struct({ outcome: Schema.String }),
              "SELECT outcome FROM statement_submission_audit"
            )
          )
        ).toEqual({ outcome: "validation_failed" });
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          1
        );
        expect(
          yield* fromTestPromise(() =>
            scalar<{ status: string }>(runtime.db, "SELECT status FROM statement_staging_objects")
          )
        ).toEqual({ status: "available" });
      })
    ),
  30_000
);

it(
  "rolls back a staged statement when a later batch child refuses at commit time",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const seededId = "30000000-0000-4000-8000-000000000790";
        yield* fromTestPromise(() => seedTransaction(runtime, { id: seededId, userId: userA }));
        // The correction's observed revision moves after it was admitted but before the unit.
        const raced = {
          ...runtime,
          db: beforeBatchDb(runtime.db, () =>
            concurrentCorrection(runtime, {
              evidenceId: "30000000-0000-4000-8000-000000000791",
              id: seededId,
              userId: userA,
            })
          ),
        };
        const refused = yield* fromTestPromise(() =>
          batch(raced, 0, [
            statementCall(1, {
              idempotencyKey: "20000000-0000-4000-8000-000000000922",
              reference: staged,
            }),
            correctionCall(2, seededId, 0),
          ])
        );
        expect(refused.status).toBe(400);
        const rejection = yield* fromTestPromise(() => batchRejectionOf(refused));
        expect(rejection.error).toMatchObject({
          code: "validation_failed",
          failedCallIndex: 1,
          operation: "transactions.updateTransaction",
        });

        // The refused sibling rolls back the whole unit: no submission, no outbox, no statement
        // audit, and only the correction's own refusal audit remains.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_ingestion_outbox"))).toBe(
          0
        );
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          0
        );
        expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(1);
        expect(
          yield* fromTestPromise(() =>
            firstRow(
              runtime.db,
              Schema.Struct({ outcome: Schema.String }),
              "SELECT outcome FROM transaction_audit WHERE operation = 'transactions.updateTransaction'"
            )
          )
        ).toEqual({ outcome: "validation_failed" });
        expect(
          yield* fromTestPromise(() =>
            scalar<{ status: string }>(runtime.db, "SELECT status FROM statement_staging_objects")
          )
        ).toEqual({ status: "available" });
      })
    ),
  30_000
);

it(
  "maps an atomic batch unit D1 defect to the closed unavailable failure without partial state",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const defective = { ...runtime, db: defectiveDb(runtime.db) };

        const individual = yield* fromTestPromise(() =>
          submit(defective, {
            idempotencyKey: "20000000-0000-4000-8000-000000000923",
            index: 0,
            reference: staged,
          })
        );
        expect(individual.status).toBe(503);
        expect(yield* fromTestPromise(() => failureCode(individual))).toBe("unavailable");
        const batched = yield* fromTestPromise(() =>
          batch(defective, 0, [
            statementCall(1, {
              idempotencyKey: "20000000-0000-4000-8000-000000000924",
              reference: staged,
            }),
            captureCall(2),
          ])
        );
        expect(batched.status).toBe(503);

        // A defect is never an invented refusal: nothing authoritative, audited, or promoted.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_ingestion_outbox"))).toBe(
          0
        );
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          0
        );
        expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "transaction_audit"))).toBe(0);
        expect(
          yield* fromTestPromise(() =>
            scalar<{ status: string }>(runtime.db, "SELECT status FROM statement_staging_objects")
          )
        ).toEqual({ status: "available" });
      })
    ),
  30_000
);

it(
  "replays an idempotent statement retry inside a later atomic batch",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const idempotencyKey = "20000000-0000-4000-8000-000000000925";
        const calls = [statementCall(1, { idempotencyKey, reference: staged }), captureCall(2)];

        const first = yield* fromTestPromise(() => batch(runtime, 0, calls));
        expect(first.status).toBe(200);
        const firstBody = yield* fromTestPromise(() => batchEnvelopeOf(first));
        const published = batchSubmissionOf(firstBody.data.results[0]?.output);
        const replayed = yield* fromTestPromise(() => batch(runtime, 0, calls));
        expect(replayed.status).toBe(200);
        const replayBody = yield* fromTestPromise(() => batchEnvelopeOf(replayed));
        // The retry still commits its sibling child, but the statement is the same submission and
        // a second canonical call is attributable as one replay audit row.
        expect(batchSubmissionOf(replayBody.data.results[0]?.output)).toEqual(published);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_ingestion_outbox"))).toBe(
          1
        );
        expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(2);
        expect(yield* fromTestPromise(() => count(runtime.db, "transaction_audit"))).toBe(2);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          2
        );
      })
    ),
  30_000
);

it(
  "refuses an oversized aggregate atomic batch body before any child is admitted",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const padding = "x".repeat(5_000);
        const calls = Array.from({ length: 12 }, (_, index) => ({
          callId: batchCallId(index + 1),
          operation: "transactions.createTransaction",
          input: {
            payload: {
              categoryId: batchCategory,
              direction: "outflow",
              money: { amount: "45000.00", currency: "COP" },
              occurredAt: "2026-08-01T12:00:00.000Z",
              padding,
            },
          },
        }));
        const refused = yield* fromTestPromise(() => batch(runtime, 0, calls));
        expect(refused.status).toBe(400);
        expect(yield* fromTestPromise(() => failureCode(refused))).toBe("validation_failed");
        // The aggregate bound is a request-shape refusal: no child is named, admitted, or audited.
        expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "transaction_audit"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          0
        );
      })
    ),
  30_000
);

it(
  "refuses a cross-User staged reference inside a batch without creating authoritative state",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime, 0));
        const refused = yield* fromTestPromise(() =>
          batch(runtime, 1, [
            statementCall(1, {
              idempotencyKey: "20000000-0000-4000-8000-000000000926",
              reference: staged,
            }),
            captureCall(2),
          ])
        );
        expect(refused.status).toBe(400);
        const rejection = yield* fromTestPromise(() => batchRejectionOf(refused));
        expect(rejection.error).toMatchObject({
          code: "validation_failed",
          failedCallIndex: 0,
          operation: "ingestion.submitForExtraction",
        });

        // Ownership is a child decision the batch cannot bypass: the stranger's sibling child and
        // the success audit roll back, and only the stranger's bounded refusal audit remains.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_ingestion_outbox"))).toBe(
          0
        );
        expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "transaction_audit"))).toBe(0);
        expect(
          yield* fromTestPromise(() =>
            firstRow(
              runtime.db,
              Schema.Struct({ outcome: Schema.String, user_id: Schema.String }),
              "SELECT user_id, outcome FROM statement_submission_audit"
            )
          )
        ).toEqual({ outcome: "validation_failed", user_id: userB });
        expect(
          yield* fromTestPromise(() =>
            scalar<{ status: string }>(runtime.db, "SELECT status FROM statement_staging_objects")
          )
        ).toEqual({ status: "available" });
      })
    ),
  30_000
);

it(
  "refuses a second staged statement child before any batch child is admitted",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const first = yield* fromTestPromise(() => stageOne(runtime));
        const second = yield* fromTestPromise(() => stageOne(runtime));
        const refused = yield* fromTestPromise(() =>
          batch(runtime, 0, [
            statementCall(1, {
              idempotencyKey: "20000000-0000-4000-8000-000000000927",
              reference: first.staged,
            }),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000928",
              reference: second.staged,
            }),
          ])
        );
        expect(refused.status).toBe(400);
        const rejection = yield* fromTestPromise(() => batchRejectionOf(refused));
        expect(rejection.error).toMatchObject({
          code: "validation_failed",
          failedCallIndex: 1,
          operation: "ingestion.submitForExtraction",
        });

        // Several files cannot multiply staging admission in one coordination turn.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_ingestion_outbox"))).toBe(
          0
        );
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          0
        );
        expect(
          yield* fromTestPromise(() =>
            count(runtime.db, "statement_staging_objects WHERE status = 'available'")
          )
        ).toBe(2);
      })
    ),
  30_000
);

it(
  "enforces a statement child's PAT scope inside an atomic batch",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const current = yield* Clock.currentTimeMillis;
        const readToken = `fin_${"r".repeat(8)}_${"r".repeat(43)}`;
        const writeToken = `fin_${"w".repeat(8)}_${"w".repeat(43)}`;
        const issue = (token: string, scopes: string, seed: number): Promise<unknown> =>
          digest(token).then((tokenDigest) =>
            runtime.db
              .prepare(
                `INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json,
                   lifetime_days, created_at_ms, issued_at_ms, expires_at_ms, request_id)
                 VALUES (?, ?, ?, ?, 'Statement batch agent', ?, 7, ?, ?, ?, ?)`
              )
              .bind(
                `40000000-0000-4000-8000-${String(seed).padStart(12, "0")}`,
                userA,
                token.slice("fin_".length, "fin_".length + 8),
                tokenDigest,
                scopes,
                current,
                current,
                current + 7 * dayMilliseconds,
                `40000000-0000-4000-9000-${String(seed).padStart(12, "0")}`
              )
              .run()
          );
        yield* fromTestPromise(() => issue(readToken, '["read"]', 1));
        yield* fromTestPromise(() => issue(writeToken, '["read","write"]', 2));

        const outOfScope = yield* fromTestPromise(() =>
          batchWithBearer(runtime, readToken, [
            statementCall(1, {
              idempotencyKey: "20000000-0000-4000-8000-000000000929",
              reference: staged,
            }),
          ])
        );
        expect(outOfScope.status).toBe(400);
        const rejection = yield* fromTestPromise(() => batchRejectionOf(outOfScope));
        expect(rejection.error).toMatchObject({
          code: "scope_missing",
          failedCallIndex: 0,
          operation: "ingestion.submitForExtraction",
        });
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
        expect(yield* fromTestPromise(() => count(runtime.db, "pat_audit"))).toBe(0);

        const committed = yield* fromTestPromise(() =>
          batchWithBearer(runtime, writeToken, [
            statementCall(1, {
              idempotencyKey: "20000000-0000-4000-8000-000000000930",
              reference: staged,
            }),
            captureCall(2),
          ])
        );
        expect(committed.status).toBe(200);
        // A scoped agent commits under the same unit, with one accepted PAT audit per child.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);
        expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(1);
        expect(
          yield* fromTestPromise(() => count(runtime.db, "pat_audit WHERE outcome = 'accepted'"))
        ).toBe(2);
      })
    ),
  30_000
);
