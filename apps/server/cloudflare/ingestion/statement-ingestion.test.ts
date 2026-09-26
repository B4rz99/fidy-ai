import {
  StatementContentDigest,
  StatementSourceFormat,
  StatementStagingId,
  StatementSubmissionId,
} from "@fidy/server/statement-staging";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import {
  BatchEnvelope,
  batchCallId,
  competingWriteDb,
  concurrentCorrection,
  correctionCall,
  defectiveBatchDb,
  seedTransaction,
} from "./statement-batch.test-fixture";
import { oversizedChildMessage } from "../mutations/canonical-mutation-batch";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";
import { statementConflictMessage } from "./statement-staging";
import { applyStatementTestMigration as applyMigration } from "./statement-migrations.test-fixture";
import {
  dispatchStatementExtraction,
  receiveStatementExtraction,
  reconcileStatementExtraction,
  runStatementExtractionWorkflow,
} from "./statement-delivery";
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
  "0013_transaction_reconciliation",
  "0014_memory",
  "0015_statement_submission",
  "0016_statement_processing",
  "0016_subscription_standing",
  "0016_budgets",
  "0017_forwarded_email",
  "0017_statement_dispatch",
] as const;

const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));
const bearer = (index: number): string => String(index + 1).repeat(43);
type Coordinator = Parameters<typeof coreWorker.fetch>[1]["USER_TRANSACTION_COORDINATOR"];
type Runtime = Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  coordinator: Option.Option<Coordinator>;
}>;

/** Native coordination proves the deployed binding shape; direct mode permits D1 fault injection. */
type Coordination = "direct" | "bound" | "without-r2";

const platformModule = (): Promise<string> =>
  Bun.build({
    entrypoints: [
      new URL("../transactions/transaction-platform-fixture.ts", import.meta.url).pathname,
    ],
    target: "browser",
  }).then((built) => {
    const output = built.outputs[0];
    if (!built.success || output === undefined) throw new Error("Coordinator bundle failed");
    return output.text();
  });

/** Bridge host Request/Response objects to Miniflare without adapting any platform bindings. */
const platformCoordinator = (miniflare: Miniflare): Promise<Coordinator> =>
  miniflare.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR").then((namespace) => ({
    getByName: (name) => ({
      fetch: (input, init) => {
        const request = new Request(input, init);
        return request
          .text()
          .then((body) =>
            namespace.getByName(name).fetch(request.url, {
              method: request.method,
              headers: Object.fromEntries(request.headers),
              body,
            })
          )
          .then((response) =>
            response.text().then(
              (body) =>
                new Response(body, {
                  status: response.status,
                  headers: Object.fromEntries(response.headers),
                })
            )
          );
      },
    }),
  }));

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

const setup = (coordination: Coordination = "direct"): Promise<Runtime> =>
  Effect.runPromise(
    Effect.gen(function* () {
      sequence += 1;
      const name = `statement-ingestion-${sequence}`;
      const module =
        coordination === "direct"
          ? "export default { fetch() { return new Response('ok') } }"
          : yield* fromTestPromise(platformModule);
      const miniflare = new Miniflare({
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: {
                DB: { id: name, type: "d1" },
                BUCKET: { name, type: "r2" },
                ...(coordination === "direct"
                  ? {}
                  : {
                      USER_TRANSACTION_COORDINATOR: {
                        type: "durable-object" as const,
                        worker: name,
                        exportName: "UserTransactionCoordinator",
                      },
                    }),
                ...(coordination === "bound"
                  ? {
                      STATEMENT_STAGING_BUCKET: { name, type: "r2" as const },
                    }
                  : {}),
              },
              ...(coordination === "direct"
                ? {}
                : {
                    exports: {
                      UserTransactionCoordinator: {
                        type: "durable-object" as const,
                        storage: "sqlite" as const,
                      },
                    },
                  }),
              manifest: {
                mainModule: "index.mjs",
                modules: {
                  "index.mjs": {
                    contents: module,
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
      const coordinator =
        coordination === "direct"
          ? Option.none()
          : Option.some(yield* fromTestPromise(() => platformCoordinator(miniflare)));
      return { bucket: bindings.BUCKET, db: bindings.DB, coordinator };
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
  USER_TRANSACTION_COORDINATOR: Option.getOrElse(runtime.coordinator, () => ({
    getByName: (name: string): Pick<Fetcher, "fetch"> => ({
      fetch: (command: Request): Promise<Response> =>
        new UserTransactionCoordinator(
          { id: { name } },
          {
            DB: runtime.db,
            STATEMENT_STAGING_BUCKET: runtime.bucket,
            AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
            HOSTED_AI_MODEL: approvedWorkersAiModel,
          }
        ).fetch(new Request(command)),
    }),
  })),
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

it(
  "enables forwarding through the public canonical mutation and reads its User-owned address",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        for (const [index, userId] of [userA, userB].entries()) {
          yield* fromTestPromise(() =>
            runtime.db
              .prepare(
                `INSERT INTO onboarding_consent_records
           (id, user_id, disclosure_json, disclosure_message_id, decision_message_id,
            decision_received_at_ms, accepted_at_ms) VALUES (?, ?, '{}', 'fixture', 'fixture', 1, 1)`
              )
              .bind(`30000000-0000-4000-8000-00000000010${index}`, userId)
              .run()
          );
        }
        const request = (index: number, method: string): Request =>
          new Request("https://api.fidyapp.com/ingestion/email-forwarding", {
            method,
            headers: sessionHeaders(index),
          });
        const enabled = yield* fromTestPromise(() => send(runtime, request(0, "POST")));
        expect(enabled.status).toBe(200);
        const parsed = Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({ address: Schema.String }),
          })
        );
        const address = (yield* parsed(yield* fromTestPromise(() => enabled.json()))).data.address;
        expect(address).toMatch(/^[a-f0-9]{48}@fidyapp\.com$/u);
        const read = yield* fromTestPromise(() => send(runtime, request(0, "GET")));
        expect(read.status).toBe(200);
        const own = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({ address: Schema.Struct({ address: Schema.String }) }),
          })
        )(yield* fromTestPromise(() => read.json()));
        expect(own.data.address.address).toBe(address);
        const other = yield* fromTestPromise(() => send(runtime, request(1, "GET")));
        expect(other.status).toBe(200);
        const otherAddress = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({ address: Schema.Struct({ address: Schema.String }) }),
          })
        )(yield* fromTestPromise(() => other.json()));
        expect(otherAddress.data.address.address).not.toBe(address);
      })
    ),
  30_000
);

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

const ReviewListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      submissionId: Schema.String,
      recordNumber: Schema.Int,
      reason: Schema.String,
      status: Schema.Literals(["pending", "expired", "resolved"]),
      originalEvidence: Schema.optional(Schema.Unknown),
    })
  ),
});

const batchCategory = "10000000-0000-4000-8000-000000000016";

/** The capture payload every manual-capture child in this file starts from. */
const capturePayload = (
  extra: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => ({
  categoryId: batchCategory,
  direction: "outflow",
  money: { amount: "45000.00", currency: "COP" },
  occurredAt: "2026-08-01T12:00:00.000Z",
  ...extra,
});

/** One canonical manual capture child, exactly as an atomic batch call carries it. */
const captureCall = (suffix: number): object => ({
  callId: batchCallId(suffix),
  operation: "transactions.createTransaction",
  input: { payload: capturePayload() },
});

/** One canonical statement child citing an already-staged reference, never raw bytes. */
const statementCall = (
  suffix: number,
  input: Readonly<{
    idempotencyKey: string;
    reference: Readonly<{ byteLength: number; sha256: string; stagingId: string }>;
  }>
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

/**
 * A D1 binding whose first row read after the unit batch fails once, then recovers: the committed
 * readback must retry a transient read defect instead of reporting an unreadable published unit.
 */
const flakyReadbackDb = (db: D1Database): D1Database => {
  let batched = false;
  let failed = false;
  const wrapStatement = (statement: unknown): object => {
    if (typeof statement !== "object" || statement === null) {
      throw new Error("Expected a D1 prepared statement");
    }
    return new Proxy(statement, {
      get: (target, property): unknown => {
        if (property === "first" && batched && !failed) {
          failed = true;
          return (): Promise<never> => Promise.reject(new Error("transient readback defect"));
        }
        const value: unknown = Reflect.get(target, property, target);
        if (property === "bind" && typeof value === "function") {
          return (...args: ReadonlyArray<unknown>): object => {
            const bound: unknown = value.apply(target, args);
            return wrapStatement(bound);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(db, {
    get: (target, property): unknown => {
      if (property === "batch") {
        return (...args: Parameters<D1Database["batch"]>): ReturnType<D1Database["batch"]> => {
          batched = true;
          return target.batch(...args);
        };
      }
      if (property === "prepare") {
        return (query: string): unknown => wrapStatement(target.prepare(query));
      }
      return Reflect.get(target, property, target);
    },
  });
};

/** The bearer token one agent credential is issued with. */
const agentToken = (fill: string): string => `fin_${fill.repeat(8)}_${fill.repeat(43)}`;

/**
 * Issues one PAT row directly, the file's only PAT builder: both the individual agent submission and
 * the in-batch scope test read their credentials from here, so a column change lands once.
 */
const issuePat = (
  input: Readonly<{
    current: number;
    db: D1Database;
    label: string;
    scopes: string;
    seed: number;
    token: string;
  }>
): Promise<unknown> =>
  digest(input.token).then((tokenDigest) =>
    input.db
      .prepare(
        `INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json,
           lifetime_days, created_at_ms, issued_at_ms, expires_at_ms, request_id)
         VALUES (?, ?, ?, ?, ?, ?, 7, ?, ?, ?, ?)`
      )
      .bind(
        `40000000-0000-4000-8000-${String(input.seed).padStart(12, "0")}`,
        userA,
        input.token.slice("fin_".length, "fin_".length + 8),
        tokenDigest,
        input.label,
        input.scopes,
        input.current,
        input.current,
        input.current + 7 * dayMilliseconds,
        `40000000-0000-4000-9000-${String(input.seed).padStart(12, "0")}`
      )
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

const failureOf = (response: Response): Promise<typeof FailureResponse.Type> =>
  response.json().then((body) => Schema.decodeUnknownSync(FailureResponse)(body));

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

/**
 * The rows a composed turn publishes: both children's domain state, the submission, the
 * Free-backfill reservation, the bounded outbox identity, and both audit trails. A turn that
 * published nothing left every one of them at zero, which is what the two assertions below state
 * from this one list. A staging row and a PAT row are not here: both pre-exist and a turn moves or
 * extends them, so their unchanged state is asserted where it is read.
 */
const canonicalStateTables = [
  "transactions",
  "transaction_audit",
  "statement_submissions",
  "statement_ingestion_outbox",
  "statement_submission_audit",
  "statement_backfill_entitlements",
] as const;

/** The one assertion for the rows a canonical turn left behind, stated once per named table. */
const expectCanonicalState = (
  db: D1Database,
  expected: Partial<Record<(typeof canonicalStateTables)[number], number>>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const table of canonicalStateTables) {
      const rows = expected[table];
      if (rows !== undefined) {
        expect(yield* fromTestPromise(() => count(db, table)), table).toBe(rows);
      }
    }
  });

/**
 * The assertion for a turn that committed nothing: every table a turn writes, at zero. This walks
 * the whole list, so a stray audit, domain, entitlement, or outbox row written outside the aborted
 * unit's own batch still fails the claim.
 */
const expectNothingCommitted = (db: D1Database): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const table of canonicalStateTables) {
      expect(yield* fromTestPromise(() => count(db, table)), table).toBe(0);
    }
  });

/** Row count over one relation: a table, or a table with a WHERE fragment, in the caller's schema. */
const count = (db: D1Database, relation: string): Promise<number> =>
  db
    .prepare(`SELECT count(*) AS total FROM ${relation}`)
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
        const runtime = yield* fromTestPromise(() => setup("bound"));
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
  "refuses publication without the coordinator R2 binding while other mutations remain usable",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup("without-r2"));
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const idempotencyKey = "20000000-0000-4000-8000-000000000950";
        const individual = yield* fromTestPromise(() =>
          submit(runtime, { idempotencyKey, index: 0, reference: staged })
        );
        expect(individual.status).toBe(503);
        expect(yield* fromTestPromise(() => failureCode(individual))).toBe("unavailable");

        const mixed = yield* fromTestPromise(() =>
          batch(runtime, 0, [
            captureCall(1),
            statementCall(2, { idempotencyKey, reference: staged }),
          ])
        );
        expect(mixed.status).toBe(503);
        expect(yield* fromTestPromise(() => mixed.json())).toEqual({ status: "unavailable" });
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
          statement_submission_audit: 0,
          transactions: 0,
          transaction_audit: 0,
        });
        expect(yield* fromTestPromise(() => stagedObjectKeys(runtime))).toHaveLength(1);
        expect(
          yield* fromTestPromise(() =>
            scalar<{ status: string }>(runtime.db, "SELECT status FROM statement_staging_objects")
          )
        ).toEqual({ status: "available" });

        const capture = yield* fromTestPromise(() => batch(runtime, 0, [captureCall(3)]));
        expect(capture.status).toBe(200);
        const envelope = yield* fromTestPromise(() => batchEnvelopeOf(capture));
        expect(envelope.data.results.map(({ operation }) => operation)).toEqual([
          "transactions.createTransaction",
        ]);
        expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(1);
      })
    ),
  30_000
);

it(
  "offers a queued submission with only its owned identity and starts one deterministic Workflow on redelivery",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const staged = yield* fromTestPromise(() => stageOne(runtime));
        const submitted = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000990",
            index: 0,
            reference: staged.staged,
          })
        );
        const submission = yield* fromTestPromise(() => submissionOf(submitted));
        const offered: Array<unknown> = [];
        yield* dispatchStatementExtraction({
          DB: runtime.db,
          STATEMENT_EXTRACTION_QUEUE: {
            send: (body) => {
              offered.push(body);
              return Promise.resolve();
            },
          },
        });
        expect(offered).toEqual([{ version: 1, userId: userA, submissionId: submission.id }]);
        const created: Array<unknown> = [];
        const work = offered[0];
        yield* receiveStatementExtraction({
          environment: {
            DB: runtime.db,
            STATEMENT_EXTRACTION_WORKFLOW: {
              create: (options) => {
                created.push(options);
                return Promise.resolve();
              },
              get: (): Promise<void> => Promise.resolve(),
            },
          },
          messages: [
            { body: work, ack: (): void => undefined },
            { body: work, ack: (): void => undefined },
          ],
        });
        expect(created).toEqual([
          {
            id: submission.id,
            params: work,
            retention: { successRetention: "3 days", errorRetention: "3 days" },
          },
          {
            id: submission.id,
            params: work,
            retention: { successRetention: "3 days", errorRetention: "3 days" },
          },
        ]);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);
      })
    ),
  30_000
);

it(
  "publishes an accepted statement through the Core scheduled dispatcher without exposing its bytes",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const staged = yield* fromTestPromise(() => stageOne(runtime));
        const submitted = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000993",
            index: 0,
            reference: staged.staged,
          })
        );
        const submission = yield* fromTestPromise(() => submissionOf(submitted));
        const offered: Array<unknown> = [];
        yield* fromTestPromise(() =>
          coreWorker.scheduled(
            { cron: "* * * * *", noRetry: () => undefined, scheduledTime: 0 },
            {
              ...coreEnvironment(runtime),
              STATEMENT_EXTRACTION_QUEUE: {
                metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
                send: (body: unknown) => {
                  offered.push(body);
                  return Promise.resolve({
                    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
                  });
                },
                sendBatch: () =>
                  Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
              },
            }
          )
        );
        expect(offered).toEqual([{ version: 1, userId: userA, submissionId: submission.id }]);
      })
    ),
  30_000
);

it(
  "retains an outbox intent when Queue publication fails and offers it again after the cooldown",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const staged = yield* fromTestPromise(() => stageOne(runtime));
        const submitted = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000992",
            index: 0,
            reference: staged.staged,
          })
        );
        const submission = yield* fromTestPromise(() => submissionOf(submitted));
        const failed = yield* Effect.exit(
          dispatchStatementExtraction({
            DB: runtime.db,
            STATEMENT_EXTRACTION_QUEUE: { send: () => Promise.reject(new Error("Queue down")) },
          })
        );
        expect(failed._tag).toBe("Failure");
        const visible = yield* fromTestPromise(() => getSubmission(runtime, 0, submission.id));
        expect((yield* fromTestPromise(() => submissionOf(visible))).status).toBe("queued");
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              "UPDATE statement_ingestion_outbox SET last_attempt_at_ms = 0 WHERE submission_id = ?"
            )
            .bind(submission.id)
            .run()
        );
        const offered: Array<unknown> = [];
        yield* dispatchStatementExtraction({
          DB: runtime.db,
          STATEMENT_EXTRACTION_QUEUE: {
            send: (body) => {
              offered.push(body);
              return Promise.resolve();
            },
          },
        });
        expect(offered).toEqual([{ version: 1, userId: userA, submissionId: submission.id }]);
      })
    ),
  30_000
);

it(
  "refuses forged and cross-User Queue work before Workflow creation",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const staged = yield* fromTestPromise(() => stageOne(runtime));
        const submitted = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000991",
            index: 0,
            reference: staged.staged,
          })
        );
        const submission = yield* fromTestPromise(() => submissionOf(submitted));
        const created: Array<unknown> = [];
        yield* receiveStatementExtraction({
          environment: {
            DB: runtime.db,
            STATEMENT_EXTRACTION_WORKFLOW: {
              create: (options) => {
                created.push(options);
                return Promise.resolve();
              },
              get: (): Promise<void> => Promise.resolve(),
            },
          },
          messages: [
            {
              body: { version: 1, userId: userB, submissionId: submission.id },
              ack: (): void => undefined,
            },
            {
              body: { version: 99, userId: userA, submissionId: submission.id },
              ack: (): void => undefined,
            },
          ],
        });
        expect(created).toEqual([]);
        const visible = yield* fromTestPromise(() => getSubmission(runtime, 0, submission.id));
        expect((yield* fromTestPromise(() => submissionOf(visible))).status).toBe("queued");
      })
    ),
  30_000
);

it("carries only an identity through Workflow history and delegates to the User coordinator", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests: Array<Readonly<{ name: string; body: unknown }>> = [];
      const coordinator = {
        getByName: (name: string): Pick<Fetcher, "fetch"> => ({
          fetch: (request: Request): Promise<Response> =>
            request.json().then((body) => {
              requests.push({ name, body });
              return new Response(null, { status: 200 });
            }),
        }),
      };
      const names: Array<string> = [];
      yield* fromTestPromise(() =>
        runStatementExtractionWorkflow({
          coordinator,
          payload: {
            version: 1,
            userId: userA,
            submissionId: "50000000-0000-4000-8000-000000000001",
          },
          activity: (name, _options, run) => {
            names.push(name);
            return run();
          },
        })
      );
      expect(names).toEqual(["finalize-statement-chunk-v1-0"]);
      expect(requests).toEqual([
        {
          name: userA,
          body: {
            _tag: "StatementWork",
            version: 1,
            userId: userA,
            submissionId: "50000000-0000-4000-8000-000000000001",
          },
        },
      ]);
    })
  ));

it("shows committed review rows only to their User through the canonical read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const { staged } = yield* fromTestPromise(() =>
        stageOne(runtime, 0, statementBytes("fecha,valor,descripcion\n2026-08-01,-45000,Cafe\n"))
      );
      const accepted = yield* fromTestPromise(() =>
        submit(runtime, {
          index: 0,
          idempotencyKey: "20000000-0000-4000-8000-000000000699",
          reference: staged,
        })
      );
      expect(accepted.status).toBe(202);
      const submission = yield* fromTestPromise(() => submissionOf(accepted));
      const coordinator = new UserTransactionCoordinator(
        { id: { name: userA } },
        {
          DB: runtime.db,
          STATEMENT_STAGING_BUCKET: runtime.bucket,
          AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
          HOSTED_AI_MODEL: approvedWorkersAiModel,
        }
      );
      const work = yield* fromTestPromise(() =>
        coordinator.fetch(
          new Request("https://coordinator.internal/statement-work", {
            method: "POST",
            body: JSON.stringify({
              _tag: "StatementWork",
              version: 1,
              userId: userA,
              submissionId: submission.id,
            }),
          })
        )
      );
      expect(work.status).toBe(200);
      const path = "https://api.fidyapp.com/ingestion/needs-review";
      const own = yield* fromTestPromise(() =>
        send(
          runtime,
          new Request(path, {
            method: "GET",
            headers: sessionHeaders(0),
          })
        )
      );
      expect(own.status).toBe(200);
      const ownBody = yield* Schema.decodeUnknownEffect(ReviewListResponse)(
        yield* fromTestPromise(() => own.json())
      );
      expect(ownBody.data).toHaveLength(1);
      expect(ownBody.data[0]).toMatchObject({
        submissionId: submission.id,
        reason: "mapping-unavailable",
      });
      expect(ownBody.data[0]?.originalEvidence).toBeDefined();
      // The cron can be delayed; a read must still suppress overdue raw evidence without
      // relying on a successful storage sweep. Clone the valid row with an expired deadline.
      const overdueDeadline = (yield* Clock.currentTimeMillis) - 1_000;
      yield* fromTestPromise(() =>
        runtime.db
          .prepare(`INSERT INTO statement_needs_review
          (id,user_id,submission_id,record_number,reason,original_evidence,known_money,issues,
           status,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,
           source_format,parser_revision,extractor_revision)
          SELECT ?,user_id,submission_id,999,reason,original_evidence,known_money,issues,
           'pending',?,created_at_ms,service_market,locale,time_zone,
           source_format,parser_revision,extractor_revision
          FROM statement_needs_review WHERE id = ?`)
          .bind("40000000-0000-4000-8000-000000000699", overdueDeadline, ownBody.data[0]?.id)
          .run()
      );
      const overdue = yield* fromTestPromise(() =>
        send(runtime, new Request(path, { method: "GET", headers: sessionHeaders(0) }))
      );
      const overdueBody = yield* Schema.decodeUnknownEffect(ReviewListResponse)(
        yield* fromTestPromise(() => overdue.json())
      );
      const overdueItem = overdueBody.data.find((item) => item.recordNumber === 999);
      expect(overdueItem?.status).toBe("expired");
      expect(overdueItem?.originalEvidence).toBeUndefined();
      const stillRaw = yield* fromTestPromise(() =>
        runtime.db
          .prepare("SELECT original_evidence FROM statement_needs_review WHERE record_number = 999")
          .first<{ original_evidence: string }>()
      );
      expect(stillRaw?.original_evidence).not.toBeNull();
      const foreign = yield* fromTestPromise(() =>
        send(
          runtime,
          new Request(path, {
            method: "GET",
            headers: sessionHeaders(1),
          })
        )
      );
      expect(foreign.status).toBe(200);
      const foreignBody = yield* Schema.decodeUnknownEffect(ReviewListResponse)(
        yield* fromTestPromise(() => foreign.json())
      );
      expect(foreignBody.data).toEqual([]);

      const token = agentToken("s");
      const current = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        issuePat({
          current,
          db: runtime.db,
          label: "No review read",
          scopes: '["write"]',
          seed: 55,
          token,
        })
      );
      const auditBefore = yield* fromTestPromise(() => count(runtime.db, "statement_review_audit"));
      const underScoped = yield* fromTestPromise(() =>
        send(
          runtime,
          new Request(path, {
            method: "GET",
            headers: { authorization: `Bearer ${token}`, origin: browserOrigin },
          })
        )
      );
      expect(underScoped.status).toBe(403);
      expect(yield* fromTestPromise(() => underScoped.text())).not.toContain("-45000");
      expect(yield* fromTestPromise(() => count(runtime.db, "statement_review_audit"))).toBe(
        auditBefore
      );
    })
  ));

it("continues a bounded statement across distinct durable Workflow steps", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const steps: Array<string> = [];
      let progress = 0;
      yield* fromTestPromise(() =>
        runStatementExtractionWorkflow({
          coordinator: {
            getByName: (_name: string): Pick<Fetcher, "fetch"> => ({
              fetch: (): Promise<Response> => {
                progress += 1;
                return Promise.resolve(new Response(null, { status: progress === 1 ? 202 : 200 }));
              },
            }),
          },
          payload: {
            version: 1,
            userId: userA,
            submissionId: "50000000-0000-4000-8000-000000000001",
          },
          activity: (name, _options, run) => {
            steps.push(name);
            return run();
          },
        })
      );
      expect(steps).toEqual(["finalize-statement-chunk-v1-0", "finalize-statement-chunk-v1-1"]);
    })
  ));

it("continues a supported 97-row statement through four durable Workflow activities", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const steps: Array<string> = [];
      yield* fromTestPromise(() =>
        runStatementExtractionWorkflow({
          coordinator: {
            getByName: (_name: string): Pick<Fetcher, "fetch"> => ({
              fetch: (): Promise<Response> =>
                Promise.resolve(
                  new Response(null, {
                    status: steps.length < 4 ? 202 : 200,
                  })
                ),
            }),
          },
          payload: {
            version: 1,
            userId: userA,
            submissionId: "50000000-0000-4000-8000-000000000001",
          },
          activity: (name, _options, run) => {
            steps.push(name);
            return run();
          },
        })
      );
      expect(steps).toEqual(
        Array.from({ length: 4 }, (_, index) => `finalize-statement-chunk-v1-${index}`)
      );
    })
  ));

it("reports exhausted statement work to the same User coordinator without copying content into Workflow history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      yield* fromTestPromise(() =>
        runStatementExtractionWorkflow({
          coordinator: {
            getByName: (_name: string): Pick<Fetcher, "fetch"> => ({
              fetch: (request: Request): Promise<Response> =>
                request.json().then((body) => {
                  requests.push(body);
                  return Promise.resolve(
                    new Response(null, { status: requests.length === 1 ? 503 : 200 })
                  );
                }),
            }),
          },
          payload: {
            version: 1,
            userId: userA,
            submissionId: "50000000-0000-4000-8000-000000000001",
          },
          activity: (_name, _options, run) => run(),
        })
      );
      expect(requests).toEqual([
        {
          _tag: "StatementWork",
          version: 1,
          userId: userA,
          submissionId: "50000000-0000-4000-8000-000000000001",
        },
        {
          _tag: "StatementFailed",
          version: 1,
          userId: userA,
          submissionId: "50000000-0000-4000-8000-000000000001",
        },
      ]);
    })
  ));

it("marks an accepted unsupported XLSX payload terminal without inventing Transactions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const { staged } = yield* fromTestPromise(() =>
        stageOne(runtime, 0, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))
      );
      const accepted = yield* fromTestPromise(() =>
        submit(runtime, {
          index: 0,
          idempotencyKey: "20000000-0000-4000-8000-000000000682",
          reference: staged,
        })
      );
      expect(accepted.status).toBe(202);
      const submission = yield* fromTestPromise(() => submissionOf(accepted));
      const coordinator = new UserTransactionCoordinator(
        { id: { name: userA } },
        {
          DB: runtime.db,
          STATEMENT_STAGING_BUCKET: runtime.bucket,
          AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
          HOSTED_AI_MODEL: approvedWorkersAiModel,
        }
      );
      const response = yield* fromTestPromise(() =>
        coordinator.fetch(
          new Request("https://coordinator.internal/statement-work", {
            method: "POST",
            body: JSON.stringify({
              _tag: "StatementWork",
              version: 1,
              userId: userA,
              submissionId: submission.id,
            }),
          })
        )
      );
      expect(response.status).toBe(200);
      const state = yield* fromTestPromise(() =>
        firstRow(
          runtime.db,
          submissionStateRow,
          "SELECT status, failure_reason, completed_at_ms FROM statement_submissions WHERE id = ?",
          submission.id
        )
      );
      expect(state.status).toBe("failed");
      expect(Option.isSome(state.failure_reason)).toBe(true);
      expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(0);
    })
  ));

it("settles an errored Workflow when its final failure-report activity also exhausted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const staged = yield* fromTestPromise(() => stageOne(runtime));
      const accepted = yield* fromTestPromise(() =>
        submit(runtime, {
          index: 0,
          idempotencyKey: "20000000-0000-4000-8000-000000000681",
          reference: staged.staged,
        })
      );
      const submission = yield* fromTestPromise(() => submissionOf(accepted));
      const now = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        runtime.db
          .prepare(`UPDATE statement_ingestion_outbox
        SET published_at_ms = ? WHERE submission_id = ?`)
          .bind(now, submission.id)
          .run()
      );
      const coordinator = new UserTransactionCoordinator(
        { id: { name: userA } },
        {
          DB: runtime.db,
          STATEMENT_STAGING_BUCKET: runtime.bucket,
          AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
          HOSTED_AI_MODEL: approvedWorkersAiModel,
        }
      );
      yield* reconcileStatementExtraction({
        DB: runtime.db,
        STATEMENT_EXTRACTION_WORKFLOW: {
          get: () => Promise.resolve({ status: () => Promise.resolve({ status: "errored" }) }),
        },
        USER_TRANSACTION_COORDINATOR: {
          getByName: (_name): Pick<Fetcher, "fetch"> => ({
            fetch: (request) =>
              coordinator.fetch(request instanceof Request ? request : new Request(request)),
          }),
        },
      });
      const state = yield* fromTestPromise(() =>
        firstRow(
          runtime.db,
          submissionStateRow,
          "SELECT status, failure_reason, completed_at_ms FROM statement_submissions WHERE id = ?",
          submission.id
        )
      );
      expect(state.status).toBe("failed");
      expect(state.failure_reason).toEqual(Option.some("resource-limit"));
    })
  ));

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

        // Password-protected Office files are OLE containers, not supported XLSX ZIPs. Refuse
        // them before staging: this path never accepts or persists a decryption password.
        const protectedOffice = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        const protectedResult = yield* fromTestPromise(() =>
          upload(runtime, { body: protectedOffice, index: 0 })
        );
        expect(protectedResult.status).toBe(400);
        expect(yield* fromTestPromise(() => failureCode(protectedResult))).toBe(
          "validation_failed"
        );

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
        const runtime = yield* fromTestPromise(() => setup("bound"));
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

        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
        });
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
  "refuses a missing or altered staged R2 object through the canonical route",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const missing = yield* fromTestPromise(() => stageOne(runtime));
        const [missingKey] = yield* fromTestPromise(() => stagedObjectKeys(runtime));
        if (missingKey === undefined) throw new Error("Expected a staged object");
        yield* fromTestPromise(() => runtime.bucket.delete(missingKey));
        const absent = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000910",
            index: 0,
            reference: missing.staged,
          })
        );
        expect(absent.status).toBe(400);

        const changed = yield* fromTestPromise(() => stageOne(runtime));
        const keys = yield* fromTestPromise(() => stagedObjectKeys(runtime));
        const alteredKey = keys.find((key) => key !== missingKey);
        if (alteredKey === undefined) throw new Error("Expected a second staged object");
        const bytes = new TextEncoder().encode("x".repeat(changed.staged.byteLength));
        const digest = yield* fromTestPromise(() => crypto.subtle.digest("SHA-256", bytes));
        yield* fromTestPromise(() => runtime.bucket.delete(alteredKey));
        yield* fromTestPromise(() => runtime.bucket.put(alteredKey, bytes, { sha256: digest }));
        const altered = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000911",
            index: 0,
            reference: changed.staged,
          })
        );
        expect(altered.status).toBe(400);
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
          statement_submission_audit: 2,
        });
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
        const token = agentToken("w");
        const current = yield* Clock.currentTimeMillis;
        yield* fromTestPromise(() =>
          issuePat({
            current,
            db: runtime.db,
            label: "Statement agent",
            scopes: '["read","write"]',
            seed: 1,
            token,
          })
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
const lostRaceIdempotencyKey = "20000000-0000-4000-8000-000000000921";

/** The idempotency key whose submission dies between dispatch and its own unit commit. */
const revokedAtCommitIdempotencyKey = "20000000-0000-4000-8000-000000000941";

it(
  "records one refusal audit when a publication loses its own unit race",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const idempotencyKey = lostRaceIdempotencyKey;
        const { staged: winner } = yield* fromTestPromise(() => stageOne(runtime));
        const { staged: loser } = yield* fromTestPromise(() => stageOne(runtime));
        // The winner commits after the losing call has read "no submission for this key" and before
        // its own conditional D1 unit runs, so only that unit can attribute the loss. One canonical
        // call remains one refusal: the unit's recorded refusal is answered without a second write.
        const database = competingWriteDb(runtime.db, () =>
          submit(runtime, { index: 0, idempotencyKey, reference: winner }).then((response) =>
            response.text()
          )
        );
        const refused = yield* fromTestPromise(() =>
          submit({ ...runtime, db: database }, { index: 0, idempotencyKey, reference: loser })
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
        const runtime = yield* fromTestPromise(() => setup("bound"));
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
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 1,
          statement_ingestion_outbox: 1,
          transactions: 1,
          transaction_audit: 1,
          statement_submission_audit: 1,
        });
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
  "retries a mixed batch as a replay when the same statement publishes during its unit",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const idempotencyKey = "20000000-0000-4000-8000-000000000958";
        const raced = {
          ...runtime,
          db: competingWriteDb(runtime.db, () =>
            submit(runtime, { index: 0, idempotencyKey, reference: staged }).then((response) =>
              response.text()
            )
          ),
        };
        const committed = yield* fromTestPromise(() =>
          batch(raced, 0, [captureCall(1), statementCall(2, { idempotencyKey, reference: staged })])
        );
        expect(committed.status, yield* fromTestPromise(() => committed.clone().text())).toBe(200);
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 1,
          statement_ingestion_outbox: 1,
          transactions: 1,
          transaction_audit: 1,
          statement_submission_audit: 2,
        });
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
          db: competingWriteDb(runtime.db, () =>
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
        yield* expectCanonicalState(runtime.db, {
          transactions: 0,
          transaction_audit: 0,
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
        });
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
        yield* fromTestPromise(() =>
          seedTransaction({
            categoryId: batchCategory,
            db: runtime.db,
            id: seededId,
            occurredAt: "2026-08-01T12:00:00.000Z",
            userId: userA,
          })
        );
        // The correction's observed revision moves after it was admitted but before the unit.
        const raced = {
          ...runtime,
          db: competingWriteDb(runtime.db, () =>
            concurrentCorrection({
              correctedAt: "2026-08-01T12:00:00.000Z",
              db: runtime.db,
              evidenceId: "30000000-0000-4000-8000-000000000791",
              transactionId: seededId,
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
            correctionCall(2, seededId, { expectedRevision: 0, changes: { notes: "late" } }),
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
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
          statement_submission_audit: 0,
        });
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
        const defective = { ...runtime, db: defectiveBatchDb(runtime.db) };

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
        yield* expectNothingCommitted(runtime.db);
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
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 1,
          statement_ingestion_outbox: 1,
          transactions: 2,
          transaction_audit: 2,
          statement_submission_audit: 2,
        });
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
        // The size premises are measured independently of the guard under test: each child is
        // below the individual 4,096-byte bound, while their shared body exceeds 12 × 4,096 bytes.
        const padding = "x".repeat(3_890);
        const calls = Array.from({ length: 12 }, (_, index) => ({
          callId: batchCallId(index + 1),
          operation: "transactions.createTransaction",
          input: { payload: capturePayload({ padding }) },
        }));
        const encodedBytes = (value: unknown): number =>
          new TextEncoder().encode(JSON.stringify(value)).byteLength;
        for (const call of calls) {
          expect(encodedBytes(call.input)).toBeLessThanOrEqual(4_096);
        }
        expect(encodedBytes({ calls })).toBeGreaterThan(12 * 4_096);
        const refused = yield* fromTestPromise(() => batch(runtime, 0, calls));
        expect(refused.status).toBe(400);
        const failure = yield* fromTestPromise(() => failureOf(refused));
        expect(failure.error.code).toBe("validation_failed");
        // The aggregate bound is a request-shape refusal, not a child failure contract: it names no
        // child, so no failedCallIndex is fabricated and nothing is admitted or audited.
        expect(failure.error.message).toBe("Invalid atomic batch input.");
        yield* Effect.promise(() => expect(batchRejectionOf(refused)).rejects.toThrow());
        yield* expectCanonicalState(runtime.db, {
          transactions: 0,
          transaction_audit: 0,
          statement_submission_audit: 0,
        });
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
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
          transactions: 0,
          transaction_audit: 0,
        });
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
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
          statement_submission_audit: 0,
        });
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
        const readToken = agentToken("r");
        const writeToken = agentToken("w");
        for (const [token, scopes, seed] of [
          [readToken, '["read"]', 1],
          [writeToken, '["read","write"]', 2],
        ] as const) {
          yield* fromTestPromise(() =>
            issuePat({
              current,
              db: runtime.db,
              label: "Statement batch agent",
              scopes,
              seed,
              token,
            })
          );
        }

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
        yield* expectCanonicalState(runtime.db, { statement_submissions: 1, transactions: 1 });
        expect(
          yield* fromTestPromise(() => count(runtime.db, "pat_audit WHERE outcome = 'accepted'"))
        ).toBe(2);
      })
    ),
  30_000
);

it(
  "refuses a submission whose credential died between dispatch and its unit commit",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const current = yield* Clock.currentTimeMillis;
        // The session is live for dispatch and every preparation read; it dies only when the
        // publication unit is about to run, so only the unit's own live-authority guard can see it.
        const database = competingWriteDb(runtime.db, () =>
          runtime.db
            .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE user_id = ?")
            .bind(current, userA)
            .run()
        );
        const refused = yield* fromTestPromise(() =>
          submit(
            { ...runtime, db: database },
            { index: 0, idempotencyKey: revokedAtCommitIdempotencyKey, reference: staged }
          )
        );
        expect(refused.status).toBe(401);
        expect(yield* fromTestPromise(() => failureCode(refused))).toBe("unauthenticated");

        // The dead credential refused the whole unit: no submission, no outbox, no audit row of
        // any outcome, and the staged material never became authoritative.
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
          statement_submission_audit: 0,
        });
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
  "rolls back a mixed batch when the caller's credential dies at commit time",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const current = yield* Clock.currentTimeMillis;
        // Both children were admitted under a live session; it is revoked only before the unit.
        const raced = {
          ...runtime,
          db: competingWriteDb(runtime.db, () =>
            runtime.db
              .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE user_id = ?")
              .bind(current, userA)
              .run()
          ),
        };
        const refused = yield* fromTestPromise(() =>
          batch(raced, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000942",
              reference: staged,
            }),
          ])
        );
        expect(refused.status).toBe(401);
        expect(yield* fromTestPromise(() => failureCode(refused))).toBe("unauthenticated");

        // A credential death at commit time refuses the whole coordination turn: neither child's
        // state or success audit survives, and no refusal row is invented for a dead credential.
        yield* expectNothingCommitted(runtime.db);
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
  "refuses a single child whose input outgrows the individual operation bound",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const oversized = {
          callId: batchCallId(1),
          operation: "transactions.createTransaction",
          input: { payload: capturePayload({ notes: "x".repeat(5_000) }) },
        };
        const refused = yield* fromTestPromise(() =>
          batch(runtime, 0, [oversized, captureCall(2)])
        );
        expect(refused.status).toBe(400);
        const rejection = yield* fromTestPromise(() => batchRejectionOf(refused));
        // The aggregate bound alone would let one child exceed the per-operation body cap: each
        // child is named and refused on the failure contract before any child is admitted. The
        // refusal's own message proves the size bound refused this child, not the input schema:
        // this payload is schema-invalid too, and an input-schema refusal is answered differently.
        expect(rejection.error).toMatchObject({
          code: "validation_failed",
          failedCallIndex: 0,
          message: oversizedChildMessage,
          operation: "transactions.createTransaction",
        });
        yield* expectCanonicalState(runtime.db, {
          transactions: 0,
          transaction_audit: 0,
          statement_submission_audit: 0,
        });
      })
    ),
  30_000
);

it(
  "retries a transient committed readback and answers the committed batch",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const flaky = { ...runtime, db: flakyReadbackDb(runtime.db) };

        const committed = yield* fromTestPromise(() =>
          batch(flaky, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000943",
              reference: staged,
            }),
          ])
        );
        const body = yield* fromTestPromise(() => committed.text());
        expect(committed.status, body).toBe(200);

        // The unit committed before the read failed, so the bounded retry reports the committed
        // records instead of answering an unreadable 503 a client retry would re-commit.
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 1,
          statement_ingestion_outbox: 1,
          transactions: 1,
          transaction_audit: 1,
          statement_submission_audit: 1,
        });
      })
    ),
  30_000
);

it(
  "enforces the Free backfill for a statement child inside an atomic batch",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const first = yield* fromTestPromise(() => stageOne(runtime));
        const queued = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000944",
            index: 0,
            reference: first.staged,
          })
        );
        expect(queued.status).toBe(202);
        const second = yield* fromTestPromise(() => stageOne(runtime));

        const paywalled = yield* fromTestPromise(() =>
          batch(runtime, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000945",
              reference: second.staged,
            }),
          ])
        );
        expect(paywalled.status).toBe(400);
        const rejection = yield* fromTestPromise(() => batchRejectionOf(paywalled));
        // The Free-backfill decision is a child decision: the batch answers it with the same code
        // the individual submission answers, naming the statement child that met it.
        expect(rejection.error).toMatchObject({
          code: "paywall_required",
          failedCallIndex: 1,
          operation: "ingestion.submitForExtraction",
        });
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(1);
        yield* expectCanonicalState(runtime.db, { transactions: 0, transaction_audit: 0 });
        expect(
          yield* fromTestPromise(() =>
            count(runtime.db, "statement_submission_audit WHERE outcome = 'resource_limit'")
          )
        ).toBe(1);
        expect(
          yield* fromTestPromise(() =>
            count(runtime.db, "statement_staging_objects WHERE status = 'available'")
          )
        ).toBe(1);
      })
    ),
  30_000
);

it(
  "refuses a statement child beyond the submission pressure limits inside an atomic batch",
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
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));

        const refused = yield* fromTestPromise(() =>
          batch(runtime, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000946",
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

        // Submission pressure is the same child decision inside a batch: no sixth submission, no
        // sibling capture, and one bounded refusal audit under the caller's authority.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(5);
        yield* expectCanonicalState(runtime.db, { transactions: 0, transaction_audit: 0 });
        expect(
          yield* fromTestPromise(() =>
            count(runtime.db, "statement_submission_audit WHERE outcome = 'resource_limit'")
          )
        ).toBe(1);
        expect(
          yield* fromTestPromise(() =>
            count(runtime.db, "statement_staging_objects WHERE status = 'available'")
          )
        ).toBe(1);
      })
    ),
  30_000
);

it(
  "refuses a statement child whose Free backfill is spent after it was admitted",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const current = yield* Clock.currentTimeMillis;
        // The grant holds through preparation and is spent only as the unit is about to run, so
        // only the unit's own entitlement guard plus the post-rollback premise re-check can see it.
        const raced = {
          ...runtime,
          db: competingWriteDb(runtime.db, () =>
            runtime.db
              .prepare(
                "INSERT INTO statement_backfill_entitlements (user_id, consumed_at_ms) VALUES (?, ?)"
              )
              .bind(userA, current)
              .run()
          ),
        };
        const refused = yield* fromTestPromise(() =>
          batch(raced, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000951",
              reference: staged,
            }),
          ])
        );
        expect(refused.status).toBe(400);
        const rejection = yield* fromTestPromise(() => batchRejectionOf(refused));
        expect(rejection.error).toMatchObject({
          code: "paywall_required",
          failedCallIndex: 1,
          operation: "ingestion.submitForExtraction",
        });

        // The unit re-decides the paywall it admitted against: the sibling capture rolls back, no
        // submission publishes, and one bounded refusal audit names the child that met it.
        yield* expectCanonicalState(runtime.db, {
          transactions: 0,
          transaction_audit: 0,
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
        });
        expect(
          yield* fromTestPromise(() =>
            count(runtime.db, "statement_submission_audit WHERE outcome = 'resource_limit'")
          )
        ).toBe(1);
        expect(
          yield* fromTestPromise(() =>
            count(runtime.db, "statement_staging_objects WHERE status = 'available'")
          )
        ).toBe(1);
      })
    ),
  30_000
);

it(
  "refuses a statement child whose submission pressure moves after it was admitted",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const current = yield* Clock.currentTimeMillis;
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        // Five outstanding submissions appear only as the unit is about to run, so the in-unit
        // outstanding guard is the one that refuses this child.
        const raced = {
          ...runtime,
          db: competingWriteDb(runtime.db, () =>
            seedSubmissions(runtime, {
              first: 1,
              last: 5,
              status: "queued",
              submittedAtMs: current - 1_000,
              userId: userA,
            })
          ),
        };
        const refused = yield* fromTestPromise(() =>
          batch(raced, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000952",
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

        // No sixth submission publishes, the sibling capture rolls back, and the pressure decision
        // is recorded once against the child that met it.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(5);
        yield* expectCanonicalState(runtime.db, { transactions: 0, transaction_audit: 0 });
        expect(
          yield* fromTestPromise(() =>
            count(runtime.db, "statement_submission_audit WHERE outcome = 'resource_limit'")
          )
        ).toBe(1);
      })
    ),
  30_000
);

it(
  "answers a conflicting idempotency key and a mismatched reference for a batch child",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const { staged: first } = yield* fromTestPromise(() => stageOne(runtime));
        const committed = yield* fromTestPromise(() =>
          submit(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000955",
            index: 0,
            reference: first,
          })
        );
        expect(committed.status).toBe(202);

        // A key already bound to different material is the same conflict an individual call answers.
        const { staged: other } = yield* fromTestPromise(() => stageOne(runtime));
        const conflicted = yield* fromTestPromise(() =>
          batch(runtime, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000955",
              reference: other,
            }),
          ])
        );
        expect(conflicted.status).toBe(400);
        const conflict = yield* fromTestPromise(() => batchRejectionOf(conflicted));
        expect(conflict.error).toMatchObject({
          code: "validation_failed",
          failedCallIndex: 1,
          message: statementConflictMessage,
          operation: "ingestion.submitForExtraction",
        });

        // A reference no staged object matches is the same closed staged-material refusal.
        const { staged: third } = yield* fromTestPromise(() => stageOne(runtime));
        const mismatched = yield* fromTestPromise(() =>
          batch(runtime, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000956",
              reference: { ...third, sha256: "0".repeat(64) },
            }),
          ])
        );
        expect(mismatched.status).toBe(400);
        const mismatch = yield* fromTestPromise(() => batchRejectionOf(mismatched));
        expect(mismatch.error).toMatchObject({
          code: "validation_failed",
          failedCallIndex: 1,
          operation: "ingestion.submitForExtraction",
        });

        // Neither batch published anything: the one committed submission stands, both siblings
        // rolled back, and each refusal was audited once under the caller's authority.
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 1,
          statement_ingestion_outbox: 1,
        });
        yield* expectCanonicalState(runtime.db, { transactions: 0, transaction_audit: 0 });
        expect(
          yield* fromTestPromise(() =>
            count(runtime.db, "statement_submission_audit WHERE outcome = 'validation_failed'")
          )
        ).toBe(2);
      })
    ),
  30_000
);

it(
  "leaves a shared daily budget abort unattributed when multiple children write audit rows",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const current = yield* Clock.currentTimeMillis;
        // 255 audit rows leave one slot, but a concurrent write may consume it before the batch
        // runs. A post-rollback recount cannot establish which child's audit write was refused.
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              `WITH RECURSIVE budget(value) AS (
                 SELECT 1 UNION ALL SELECT value + 1 FROM budget WHERE value < 255
               )
               INSERT INTO statement_submission_audit (id, user_id, operation, outcome, occurred_at_ms)
               SELECT '91000000-0000-4000-8000-' || substr('000000000000' || value, -12),
                      ?, 'ingestion.getStatementSubmission', 'success', ?
               FROM budget`
            )
            .bind(userA, current)
            .run()
        );
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const limited = yield* fromTestPromise(() =>
          batch(runtime, 0, [
            captureCall(1),
            statementCall(2, {
              idempotencyKey: "20000000-0000-4000-8000-000000000957",
              reference: staged,
            }),
          ])
        );
        expect(limited.status).toBe(503);

        // The abort has no provable child, so no refusal row is attempted: the day's audit count
        // is unchanged and neither child's state survives the rollback.
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submission_audit"))).toBe(
          255
        );
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
          transactions: 0,
          transaction_audit: 0,
        });
      })
    ),
  30_000
);
