import {
  StatementContentDigest,
  StatementSourceFormat,
  StatementStagingId,
  StatementSubmissionId,
} from "../../src/shell/ingestion/contract";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  canonicalAdmissionMigrationNames,
  hostedTurnTestMigrations,
  installTestSchema,
  isolatedTestStorage,
} from "../d1-test-fixture";
import { BatchEnvelope, batchCallId, competingWriteDb } from "./statement-batch.test-fixture";
import { getCanonicalOperationInput } from "../../src/shell/canonical-operations/operations";
import { CanonicalToolEvidence, ToolCallId, TranscriptTurnId } from "../../src/core/agent/contract";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import { WhatsAppHostedSubject } from "../whatsapp/contract";
import { mintHostedStatementCaller } from "../agent/operations";
import { whatsAppIdentityQuery } from "../identity/operations";
import { protectConsentStatement } from "../../src/shell/consent/operations";
import {
  executeHostedStatementCall,
  executeHostedStatementQuery,
} from "../canonical-operations/operations";
import { UserTransactionCoordinator } from "../transactions/runtime";
import {
  prepareHeldStatementReviewDecision,
  prepareStatementAbandonment,
  prepareStatementReviewDecision,
  readStatementSubmission,
} from "./operations";
import type {
  CanonicalMutationPreparation,
  CanonicalPreparationWork,
} from "../canonical-operations/contract";
import {
  OAuthClientId,
  OAuthConnectionId,
  OAuthCredentialId,
} from "../../src/core/oauth-agents/contract";
import type { OAuthCaller } from "../../src/shell/oauth-agents/contract";
import {
  dispatchStatementExtraction,
  executeStatementExtraction,
  receiveStatementExtraction,
  reconcileStatementExtraction,
  sweepExpiredUploadAdmission,
} from "./runtime";
import { publishOwnedStatement, stageOwnedStatement } from "./statement-publication.test-fixture";
import { makeAudit } from "../../src/shell/audit/runtime";
import { newId } from "../secret-material/operations";
import coreWorker from "../core-worker";
import { observeOperationalHealth } from "../runtime/operational-health/operations";
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
it(
  "observes all statement Audit projections with bounded ordering and User isolation",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const projections = [
          { table: "statement_submission_audit", operation: "ingestion.submitForExtraction" },
          { table: "statement_review_audit", operation: "ingestion.listNeedsReviewItems" },
          { table: "statement_clarification_audit", operation: "ingestion.skipNeedsReviewItem" },
        ];
        for (const userId of [userA, userB]) {
          for (const [index, projection] of projections.entries()) {
            yield* fromTestPromise(() =>
              runtime.db
                .prepare(
                  `INSERT INTO ${projection.table} (id,user_id,operation,outcome,occurred_at_ms) VALUES (?,?,?,'success',?)`
                )
                .bind(newId(), userId, projection.operation, index + 1)
                .run()
            );
          }
        }
        const audit = makeAudit({ database: runtime.db });
        const rows = yield* audit.publications({ userId: UserId.make(userA), limit: 3 });
        expect(rows.map(({ operation }) => operation)).toEqual(
          projections.map(({ operation }) => operation)
        );
        expect(rows.every(({ subjectUserId }) => subjectUserId === userA)).toBe(true);
        const bounded = yield* audit.publications({ userId: UserId.make(userA), limit: 2 });
        expect(bounded.map(({ id }) => id)).toEqual(rows.slice(0, 2).map(({ id }) => id));
        const foreign = yield* audit.publications({ userId: UserId.make(userB), limit: 3 });
        expect(foreign.every(({ subjectUserId }) => subjectUserId === userB)).toBe(true);
      })
    ),
  30_000
);

const statementBytes = (text = statementCsv): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

let sequence = 0;
const instances: Array<Miniflare> = [];
const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
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
  "0016_async_health",
  "0016_hosted_turn",
  "0016_statement_processing",
  "0016_subscription_standing",
  "0016_budgets",
  "0037_budget_crossing_facts",
  "0017_hosted_compaction",
  "0017_forwarded_email",
  "0017_statement_dispatch",
  "0018_batch_envelope_audit",
  "0018_dashboard",
  "0018_forwarded_email_processing",
  "0019_canonical_child_guards",
  "0020_dashboard_projection",
  ...hostedTurnTestMigrations,
  "0027_recurring",
  "0028_recurring_audit_budget",
  "0029_audit_owner_retention",
  "0035_billing_corrections",
  "0052_weekly_card_renewal",
  "0032_statement_capture_entitlement",
  "0033_statement_clarification",
  "0034_statement_clarification_audit",
  "0035_statement_hosted_origin",
  "0036_statement_whatsapp_documents",
  "0038_proactivity_consent",
  "0040_reminder_canonical_audit",
  "0032_oauth_review",
  "0034_oauth_refresh",
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

let platformBundle = Option.none<Promise<string>>();
const platformModule = (): Promise<string> =>
  Option.getOrElse(platformBundle, () => {
    const bundle = buildPlatformModule();
    platformBundle = Option.some(bundle);
    return bundle;
  });
const buildPlatformModule = (): Promise<string> =>
  Bun.build({
    entrypoints: [new URL("../coordinator-test-harness.ts", import.meta.url).pathname],
    target: "browser",
    external: ["cloudflare:workers"],
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
      db.batch([
        db
          .prepare(
            "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
          )
          .bind(input.userId, input.current),
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
          ),
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
          ),
      ])
  );

const boundStorage = (coordination: "bound" | "without-r2"): Promise<Runtime> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `statement-ingestion-${++sequence}`;
      const module = yield* fromTestPromise(platformModule);
      const miniflare = new Miniflare({
        workers: [
          {
            config: {
              name,
              type: "worker",
              compatibilityDate: "2026-09-08",
              env: {
                DB: { id: name, type: "d1" },
                BUCKET: { name, type: "r2" },
                USER_TRANSACTION_COORDINATOR: {
                  type: "durable-object",
                  worker: name,
                  exportName: "UserTransactionCoordinator",
                },
                ...(coordination === "bound"
                  ? { STATEMENT_STAGING_BUCKET: { name, type: "r2" as const } }
                  : {}),
              },
              exports: {
                UserTransactionCoordinator: { type: "durable-object", storage: "sqlite" },
              },
              manifest: {
                mainModule: "index.mjs",
                modules: { "index.mjs": { contents: module, type: "esm" } },
              },
            },
          },
        ],
      });
      instances.push(miniflare);
      yield* fromTestPromise(() => miniflare.ready);
      const bindings = yield* fromTestPromise(() =>
        miniflare.getBindings<{ DB: D1Database; BUCKET: R2Bucket }>(name)
      );
      const coordinator = Option.some(yield* fromTestPromise(() => platformCoordinator(miniflare)));
      return { db: bindings.DB, bucket: bindings.BUCKET, coordinator };
    })
  );

const setup = (coordination: Coordination = "direct"): Promise<Runtime> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime: Runtime =
        coordination === "direct"
          ? { ...(yield* fromTestPromise(() => storage.acquire())), coordinator: Option.none() }
          : yield* fromTestPromise(() => boundStorage(coordination));
      yield* fromTestPromise(() =>
        installTestSchema({
          db: runtime.db,
          sources: canonicalAdmissionMigrationNames(migrationNames).map(
            (name) => new URL(`../migrations/${name}.sql`, import.meta.url)
          ),
        })
      );
      const current = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        seedUser(runtime.db, {
          current,
          index: 0,
          pairingId: "10000000-0000-4000-8000-000000000301",
          sessionId: sessionA,
          userId: userA,
        }).then(() =>
          seedUser(runtime.db, {
            current,
            index: 1,
            pairingId: "10000000-0000-4000-8000-000000000302",
            sessionId: sessionB,
            userId: userB,
          })
        )
      );
      return runtime;
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
          { id: { name }, storage: { setAlarm: () => Promise.resolve() } },
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
  const headers = new Headers(request.headers);
  headers.set("cf-connecting-ip", "192.0.2.35");
  return publicWorker.fetch(new Request(request, { headers }), {
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

it("inherits the statement read owner's Clock for credential expiry and Audit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const clock = yield* Clock.Clock;
      const session = yield* fromTestPromise(() =>
        runtime.db
          .prepare(
            "SELECT MIN(idle_expires_at_ms, hard_expires_at_ms) AS expires_at_ms FROM web_sessions WHERE id = ?"
          )
          .bind(sessionA)
          .first<{ expires_at_ms: number }>()
      );
      if (session === null) return yield* Effect.die(new Error("Missing test WebSession"));
      const atTime = (millis: number): Clock.Clock => ({
        currentTimeMillisUnsafe: () => millis,
        currentTimeMillis: Effect.succeed(millis),
        currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
        currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
      });
      const query = {
        environment: coreEnvironment(runtime),
        request: new Request(
          "https://core.internal/ingestion/submissions/10000000-0000-4000-8000-000000000999"
        ),
        subject: {
          id: sessionA,
          userId: userA,
          digest: yield* fromTestPromise(() => digest(bearer(0))),
        },
      };
      const acceptedAt = session.expires_at_ms - 1;
      const accepted = yield* readStatementSubmission(query).pipe(
        Effect.provideService(Clock.Clock, atTime(acceptedAt))
      );
      expect(accepted.status).toBe(404);
      const expired = yield* readStatementSubmission(query).pipe(
        Effect.provideService(Clock.Clock, atTime(session.expires_at_ms))
      );
      expect(expired.status).toBe(401);
      expect(
        (yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              "SELECT occurred_at_ms FROM statement_submission_audit WHERE operation = 'ingestion.getStatementSubmission'"
            )
            .all()
        )).results
      ).toEqual([{ occurred_at_ms: acceptedAt }]);
    })
  ));

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

it(
  "rejects a skipped forwarding success Audit without enabling unaudited work",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(`INSERT INTO onboarding_consent_records
          (id, user_id, disclosure_json, disclosure_message_id, decision_message_id,
           decision_received_at_ms, accepted_at_ms)
          VALUES ('30000000-0000-4000-8000-000000000111', ?, '{}', 'fixture', 'fixture', 1, 1)`)
            .bind(userA)
            .run()
        );
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(`CREATE TRIGGER skip_forwarding_audit
        BEFORE INSERT ON statement_submission_audit
        WHEN NEW.operation = 'ingestion.enableEmailForwarding' AND NEW.outcome = 'success'
        BEGIN SELECT RAISE(IGNORE); END`)
            .run()
        );
        const response = yield* fromTestPromise(() =>
          send(
            runtime,
            new Request("https://api.fidyapp.com/ingestion/email-forwarding", {
              method: "POST",
              headers: sessionHeaders(0),
            })
          )
        );
        expect(response.status).toBe(400);
        expect(yield* fromTestPromise(() => response.text())).not.toMatch(
          /SQL|INSERT|canonical_child_guard/iu
        );
        const audits = yield* fromTestPromise(() =>
          runtime.db
            .prepare("SELECT operation,outcome FROM statement_submission_audit WHERE user_id = ?")
            .bind(userA)
            .all<{ operation: string; outcome: string }>()
        );
        expect(audits.results).toEqual([
          { operation: "ingestion.enableEmailForwarding", outcome: "validation_failed" },
        ]);
        const addresses = yield* fromTestPromise(() =>
          runtime.db
            .prepare("SELECT count(*) AS total FROM email_forwarding_addresses WHERE user_id = ?")
            .bind(userA)
            .first<{ total: number }>()
        );
        expect(addresses?.total).toBe(1);
      })
    ),
  30_000
);

const stageFixture = (
  runtime: Runtime,
  input: Readonly<{ index: number; body: BodyInit }>
): Promise<Response> =>
  stageOwnedStatement({
    storage: runtime,
    index: input.index,
    request: new Request("https://owner-fixture.internal/bytes", {
      body: input.body,
      method: "POST",
    }),
  });
const browserUpload = (
  runtime: Runtime,
  input: Readonly<{ index: number; body: BodyInit }>
): Promise<Response> =>
  send(
    runtime,
    new Request("https://api.fidyapp.com/ingestion/statements/bytes", {
      body: input.body,
      method: "POST",
      headers: sessionHeaders(input.index),
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

const browserSubmit = (
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

const publishFixture = (
  runtime: Runtime,
  input: Readonly<{
    index: number;
    idempotencyKey: string;
    reference: Readonly<{ stagingId: string; byteLength: number; sha256: string }>;
  }>
): Promise<Response> => publishOwnedStatement({ storage: runtime, input });
it("refuses direct browser statement staging and publication without a WhatsApp attachment", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const staging = yield* fromTestPromise(() =>
        browserUpload(runtime, { body: statementBytes(), index: 0 })
      );
      expect(staging.ok).toBe(false);
      const published = yield* fromTestPromise(() =>
        browserSubmit(runtime, {
          index: 0,
          idempotencyKey: "20000000-0000-4000-8000-000000000819",
          reference: {
            stagingId: "20000000-0000-4000-8000-000000000818",
            byteLength: 1,
            sha256: "0".repeat(64),
          },
        })
      );
      expect(published.status).toBe(403);
      expect(
        (yield* fromTestPromise(() =>
          runtime.db.prepare("SELECT id FROM statement_submissions").all()
        )).results
      ).toHaveLength(0);
      expect(
        (yield* fromTestPromise(() =>
          runtime.db.prepare("SELECT id FROM statement_staging_objects").all()
        )).results
      ).toHaveLength(0);
    })
  ));

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

const ReviewListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      submissionId: Schema.String,
      recordNumber: Schema.Int,
      reason: Schema.String,
      status: Schema.Literals(["pending", "expired", "resolved", "skipped", "abandoned"]),
      originalEvidence: Schema.optional(Schema.Unknown),
    })
  ),
});
const batchCategory = "10000000-0000-4000-8000-000000000016";
const capturePayload = (
  extra: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> => ({
  categoryId: batchCategory,
  direction: "outflow",
  money: { amount: "45000.00", currency: "COP" },
  occurredAt: "2026-08-01T12:00:00.000Z",
  ...extra,
});
const captureCall = (suffix: number): object => ({
  callId: batchCallId(suffix),
  operation: "transactions.createTransaction",
  input: { payload: capturePayload() },
});
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
  stageFixture(runtime, { body, index }).then((response) =>
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
          publishFixture(runtime, { idempotencyKey, index: 0, reference: staged })
        );
        expect(first.status).toBe(202);
        const published = yield* fromTestPromise(() => submissionOf(first));
        expect(published).toMatchObject({
          parserRevision: "statement-parser-v1",
          sourceFormat: "csv",
          status: "queued",
        });

        const replayed = yield* fromTestPromise(() =>
          publishFixture(runtime, { idempotencyKey, index: 0, reference: staged })
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
  "refuses browser and batch publication while unrelated mutations remain usable without R2",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup("without-r2"));
        const { staged } = yield* fromTestPromise(() => stageOne(runtime));
        const idempotencyKey = "20000000-0000-4000-8000-000000000950";
        const individual = yield* fromTestPromise(() =>
          browserSubmit(runtime, { idempotencyKey, index: 0, reference: staged })
        );
        expect(individual.status).toBe(403);
        expect(yield* fromTestPromise(() => failureCode(individual))).toBe("user_action_required");

        const mixed = yield* fromTestPromise(() =>
          batch(runtime, 0, [
            captureCall(1),
            statementCall(2, { idempotencyKey, reference: staged }),
          ])
        );
        expect(mixed.status).toBe(400);
        const rejection = yield* fromTestPromise(() => batchRejectionOf(mixed));
        expect(rejection.error).toMatchObject({
          code: "unavailable",
          failedCallIndex: 1,
          operation: "ingestion.submitForExtraction",
        });
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
          publishFixture(runtime, {
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

it.each([false, true])(
  "publishes an accepted statement through the Core scheduled dispatcher despite independent review-expiry failure (%s)",
  (failReviewExpiry) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const staged = yield* fromTestPromise(() => stageOne(runtime));
        const submitted = yield* fromTestPromise(() =>
          publishFixture(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000993",
            index: 0,
            reference: staged.staged,
          })
        );
        const submission = yield* fromTestPromise(() => submissionOf(submitted));
        const offered: Array<unknown> = [];
        const database: D1Database = {
          prepare: (query) => {
            if (failReviewExpiry && query.includes("UPDATE statement_needs_review")) {
              throw new Error("private sweep failure");
            }
            return runtime.db.prepare(query);
          },
          batch: (statements) => runtime.db.batch(statements),
          exec: (query) => runtime.db.exec(query),
          dump: () => runtime.db.dump(),
          withSession: (bookmark) => runtime.db.withSession(bookmark),
        };
        const result = yield* Effect.exit(
          fromTestPromise(() =>
            coreWorker.scheduled(
              { cron: "* * * * *", noRetry: () => undefined, scheduledTime: 0 },
              {
                ...coreEnvironment(runtime),
                DB: database,
                STATEMENT_EXTRACTION_QUEUE: {
                  metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
                  send: (body: unknown) => {
                    offered.push(body);
                    return Promise.resolve({
                      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
                    });
                  },
                  sendBatch: () =>
                    Promise.resolve({
                      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
                    }),
                },
              }
            )
          )
        );
        expect(result._tag).toBe(failReviewExpiry ? "Failure" : "Success");
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
          publishFixture(runtime, {
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
          publishFixture(runtime, {
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
        executeStatementExtraction({
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

const clarifyStatement = (
  runtime: Runtime,
  csv: string
): Promise<Readonly<{ submissionId: string; reviewIds: ReadonlyArray<string> }>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* fromTestPromise(() =>
        runtime.db
          .prepare(`INSERT INTO onboarding_consent_records
    (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms)
    VALUES ('30000000-0000-4000-8000-000000000198', ?, '{}', 'fixture', 'fixture', 1, 1)`)
          .bind(userA)
          .run()
      );
      const { staged } = yield* fromTestPromise(() => stageOne(runtime, 0, statementBytes(csv)));
      const accepted = yield* fromTestPromise(() =>
        publishFixture(runtime, {
          index: 0,
          idempotencyKey: "20000000-0000-4000-8000-000000000698",
          reference: staged,
        })
      );
      expect(accepted.status).toBe(202);
      const submission = yield* fromTestPromise(() => submissionOf(accepted));
      const coordinator = new UserTransactionCoordinator(
        { id: { name: userA }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
        {
          DB: runtime.db,
          STATEMENT_STAGING_BUCKET: runtime.bucket,
          AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
          HOSTED_AI_MODEL: approvedWorkersAiModel,
        }
      );
      const extracted = yield* fromTestPromise(() =>
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
      expect(extracted.status).toBe(200);
      const rows = yield* fromTestPromise(() =>
        runtime.db
          .prepare(
            "SELECT id FROM statement_needs_review WHERE submission_id = ? ORDER BY record_number"
          )
          .bind(submission.id)
          .all()
      );
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ id: Schema.String }))
      )(rows.results);
      return { submissionId: submission.id, reviewIds: decoded.map(({ id }) => id) };
    })
  );

const oauthClarificationSubject = (db: D1Database, current: number): Effect.Effect<OAuthCaller> =>
  Effect.gen(function* () {
    const oauthConnectionId = OAuthConnectionId.make("80000000-0000-4000-8000-000000000101");
    const credentialId = OAuthCredentialId.make("80000000-0000-4000-8000-000000000102");
    const clientId = OAuthClientId.make("80000000-0000-4000-8000-000000000104");
    const credentialDigest = new Uint8Array(32).fill(7);
    yield* fromTestPromise(() =>
      db.batch([
        db
          .prepare(`INSERT INTO oauth_connections (id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms)
      VALUES (?,?,?,?,'fixture','http://127.0.0.1/callback','https://api.fidyapp.com/mcp','["write"]',?,?)`)
          .bind(
            oauthConnectionId,
            "80000000-0000-4000-8000-000000000103",
            userA,
            clientId,
            current,
            current + dayMilliseconds
          ),
        db
          .prepare(
            `INSERT INTO oauth_grant_consents (id,connection_id,user_id,session_id,disclosure_revision,disclosure_text,accepted_at_ms) VALUES (?,?,?,?,'fixture','fixture',?)`
          )
          .bind(
            "80000000-0000-4000-8000-000000000105",
            oauthConnectionId,
            userA,
            sessionA,
            current
          ),
        db
          .prepare(
            `INSERT INTO oauth_access_credentials (id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES (?,?,?,?,?,?,'["write"]')`
          )
          .bind(
            credentialId,
            oauthConnectionId,
            userA,
            credentialDigest,
            current,
            current + dayMilliseconds
          ),
      ])
    );
    return {
      oauthConnectionId,
      credentialId,
      clientId,
      userId: UserId.make(userA),
      resource: "https://api.fidyapp.com/mcp",
      digest: credentialDigest,
      requiredScope: Option.some("write"),
    };
  });
const prepareOAuthClarification = (
  operation: "resolve" | "skip" | "abandon",
  work: CanonicalPreparationWork
): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const id = {
      abandon: "ingestion.abandonStatementSubmission",
      resolve: "ingestion.resolveNeedsReviewItem",
      skip: "ingestion.skipNeedsReviewItem",
    } as const;
    const input = yield* Schema.decodeUnknownEffect(getCanonicalOperationInput(id[operation]))(
      work.input
    ).pipe(Effect.orDie);
    return yield* operation === "abandon"
      ? prepareStatementAbandonment({ ...work, input })
      : prepareStatementReviewDecision({
          operation:
            operation === "resolve"
              ? "ingestion.resolveNeedsReviewItem"
              : "ingestion.skipNeedsReviewItem",
          work: { ...work, input },
        });
  });

const commitFreshClarification = (
  operation: "resolve" | "skip" | "abandon",
  work: CanonicalPreparationWork,
  previousRevision: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const prepared = yield* prepareOAuthClarification(operation, work);
    expect(prepared._tag).toBe("Prepared");
    if (prepared._tag !== "Prepared" || Option.isNone(prepared.mutation.oauthReview)) {
      return yield* Effect.die("Missing fresh review");
    }
    const review = prepared.mutation.oauthReview.value;
    expect(review.revision).not.toBe(previousRevision);
    yield* fromTestPromise(() =>
      work.db.batch([...review.guards, ...prepared.mutation.statements])
    );
    expect(
      (yield* fromTestPromise(() => work.db.prepare("SELECT id FROM transactions").all())).results
    ).toHaveLength(operation === "resolve" ? 1 : 0);
    expect(
      (yield* fromTestPromise(() =>
        work.db.prepare("SELECT review_id FROM statement_review_decisions").all()
      )).results
    ).toHaveLength(2);
    expect(
      yield* fromTestPromise(() =>
        work.db.prepare("SELECT state FROM statement_clarifications").first()
      )
    ).toEqual({ state: operation === "abandon" ? "abandoned" : "completed" });
    expect(
      (yield* fromTestPromise(() =>
        work.db.prepare("SELECT outcome FROM pat_audit WHERE oauth_connection_id IS NOT NULL").all()
      )).results
    ).toEqual([{ outcome: "accepted" }]);
  });

it.each(["resolve", "skip", "abandon"] as const)(
  "reviews eligible OAuth %s with a stable revision and atomic stale-snapshot refusal",
  (operation) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const statement = yield* fromTestPromise(() =>
          clarifyStatement(
            runtime,
            "date,amount,description\nunclear,unknown,Cafe\nunclear,unknown,Tienda\n"
          )
        );
        const [id, sibling] = statement.reviewIds;
        if (id === undefined || sibling === undefined) {
          return yield* Effect.die("Missing review fixture");
        }
        const current = yield* Clock.currentTimeMillis;
        const subject = yield* oauthClarificationSubject(runtime.db, current);
        const work: CanonicalPreparationWork = {
          db: runtime.db,
          subject,
          current,
          bucket: Option.some(runtime.bucket),
          input: {
            params: { id: operation === "abandon" ? statement.submissionId : id },
            ...(operation === "resolve"
              ? {
                  payload: {
                    extraction: {
                      money: { amount: "13000.00", currency: "COP" },
                      counterparty: "Tienda",
                      direction: "outflow",
                      occurredAt: "2026-08-02T12:00:00.000Z",
                    },
                  },
                }
              : {}),
          },
        };
        const first = yield* prepareOAuthClarification(operation, work);
        const resumed = yield* prepareOAuthClarification(operation, {
          ...work,
          current: current + 1,
        });
        expect(first._tag).toBe("Prepared");
        expect(resumed._tag).toBe("Prepared");
        if (first._tag !== "Prepared" || resumed._tag !== "Prepared") return;
        const review = first.mutation.oauthReview;
        expect(Option.isSome(review)).toBe(true);
        if (Option.isNone(review)) return;
        expect(
          Option.map(resumed.mutation.oauthReview, ({ revision, effect }) => ({ revision, effect }))
        ).toEqual(Option.some({ revision: review.value.revision, effect: review.value.effect }));
        expect(review.value.effect).toContain(statement.submissionId);
        expect(review.value.effect).toContain("evidencia original");
        expect(review.value.effect).not.toContain("unclear");
        yield* fromTestPromise(() => runtime.db.batch([...review.value.guards]));
        const skipped = yield* fromTestPromise(() =>
          reviewDecision(runtime, { id: sibling, action: "skip" })
        );
        expect(skipped.status).toBe(200);
        const commit = yield* Effect.exit(
          fromTestPromise(() =>
            runtime.db.batch([...review.value.guards, ...first.mutation.statements])
          )
        );
        expect(commit._tag).toBe("Failure");
        expect(
          (yield* fromTestPromise(() =>
            runtime.db.prepare("SELECT review_id FROM statement_review_decisions").all()
          )).results
        ).toEqual([{ review_id: sibling }]);
        expect(
          (yield* fromTestPromise(() => runtime.db.prepare("SELECT id FROM transactions").all()))
            .results
        ).toHaveLength(0);
        expect(
          (yield* fromTestPromise(() =>
            runtime.db
              .prepare("SELECT id FROM pat_audit WHERE oauth_connection_id=?")
              .bind(subject.oauthConnectionId)
              .all()
          )).results
        ).toHaveLength(0);
        yield* commitFreshClarification(operation, work, review.value.revision);
      })
    ),
  30_000
);

it.each(["resolve", "skip", "abandon"] as const)(
  "refuses OAuth %s for hosted-origin submissions without borrowed conversation authority",
  (operation) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const statement = yield* fromTestPromise(() =>
          clarifyStatement(runtime, "date,amount,description\nunclear,unknown,Cafe\n")
        );
        const id = statement.reviewIds[0];
        if (id === undefined) return yield* Effect.die("Missing review fixture");
        const current = yield* Clock.currentTimeMillis;
        const subject = yield* oauthClarificationSubject(runtime.db, current);
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              `INSERT INTO statement_hosted_origins (submission_id,user_id,session_id,turn_id,expires_at_ms) VALUES (?,?,?,?,?)`
            )
            .bind(
              statement.submissionId,
              userA,
              "hosted-session",
              "hosted-turn",
              current + dayMilliseconds
            )
            .run()
        );
        const prepared = yield* prepareOAuthClarification(operation, {
          db: runtime.db,
          subject,
          current,
          bucket: Option.some(runtime.bucket),
          input: {
            params: { id: operation === "abandon" ? statement.submissionId : id },
            ...(operation === "resolve"
              ? {
                  payload: {
                    extraction: {
                      money: { amount: "13000.00", currency: "COP" },
                      direction: "outflow",
                      occurredAt: "2026-08-02T12:00:00.000Z",
                    },
                  },
                }
              : {}),
          },
        });
        expect(prepared._tag).toBe("Refused");
        expect(
          (yield* fromTestPromise(() =>
            runtime.db.prepare("SELECT review_id FROM statement_review_decisions").all()
          )).results
        ).toHaveLength(0);
        expect(
          (yield* fromTestPromise(() => runtime.db.prepare("SELECT id FROM transactions").all()))
            .results
        ).toHaveLength(0);
        expect(
          yield* fromTestPromise(() =>
            runtime.db.prepare("SELECT state FROM statement_clarifications").first()
          )
        ).toEqual({ state: "awaiting" });
      })
    ),
  30_000
);

const reviewDecision = (
  runtime: Runtime,
  input: Readonly<{ id: string; action: "resolve" | "skip" }>,
  index = 0
): Promise<Response> =>
  send(
    runtime,
    new Request(`https://api.fidyapp.com/ingestion/needs-review/${input.id}/${input.action}`, {
      method: "POST",
      headers: { ...sessionHeaders(index), "content-type": "application/json" },
      ...(input.action === "resolve"
        ? {
            body: JSON.stringify({
              extraction: {
                money: { amount: "13000.00", currency: "COP" },
                counterparty: "Tienda",
                direction: "outflow",
                occurredAt: "2026-08-02T12:00:00.000Z",
              },
            }),
          }
        : {}),
    })
  );

it("publishes a staged statement under held WhatsApp authority and atomically binds its upload session", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const { staged } = yield* fromTestPromise(() => stageOne(runtime));
      const current = yield* Clock.currentTimeMillis;
      const sessionId = "40000000-0000-4000-8000-000000000991";
      const turnId = TranscriptTurnId.make("40000000-0000-4000-8000-000000000992");
      const subject = WhatsAppHostedSubject.make({
        userId: UserId.make(userA),
        portfolioId: WhatsAppBusinessPortfolioId.make("portfolio-1"),
        bsuid: WhatsAppBusinessScopedUserId.make("CO.13491208655302741918"),
      });
      yield* fromTestPromise(() =>
        runtime.db.batch([
          runtime.db
            .prepare(
              "INSERT INTO onboarding_consent_records (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES ('30000000-0000-4000-8000-000000000199',?,'{}','fixture','fixture',1,1)"
            )
            .bind(userA),
          runtime.db
            .prepare(
              "INSERT INTO whatsapp_identities (user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
            )
            .bind(userA, subject.portfolioId, subject.bsuid, current),
          runtime.db
            .prepare(
              "INSERT INTO hosted_agent_sessions (id,user_id,consent_basis_json,started_at_ms,status) VALUES (?,?,'{}',?,'active')"
            )
            .bind(sessionId, userA, current),
          runtime.db
            .prepare(
              "INSERT INTO hosted_turns (id,user_id,hosted_session_id,started_at_ms,status) VALUES (?,?,?,?,'pending')"
            )
            .bind(turnId, userA, sessionId, current),
          runtime.db
            .prepare(
              "INSERT INTO hosted_whatsapp_inbound (turn_id,user_id,portfolio_id,bsuid,message_id,business_phone_number_id,occurred_at_ms,received_at_ms) VALUES (?,?,?,?,?,?,?,?)"
            )
            .bind(
              turnId,
              userA,
              subject.portfolioId,
              subject.bsuid,
              "wamid.direct-upload",
              "123456789",
              current,
              current
            ),
          runtime.db
            .prepare("UPDATE web_sessions SET revoked_at_ms=? WHERE user_id=?")
            .bind(current, userA),
        ])
      );
      const caller = yield* mintHostedStatementCaller({
        db: runtime.db,
        subject,
        turnId,
        current,
        approval: Option.none(),
        live: protectConsentStatement({
          statement: whatsAppIdentityQuery(subject),
          subject: { _tag: "User", userId: userA },
          requirement: "active",
        }),
      });
      if (Option.isNone(caller)) return yield* Effect.die("Missing held caller");
      const missingAttachment = yield* executeHostedStatementCall({
        db: runtime.db,
        bucket: Option.some(runtime.bucket),
        caller: caller.value,
        current,
        operation: "ingestion.submitForExtraction",
        input: {
          payload: { idempotencyKey: "20000000-0000-4000-8000-000000000798", reference: staged },
        },
        fence: { turnId, toolCallId: ToolCallId.make("not-direct-upload") },
      });
      expect(missingAttachment.ok).toBe(false);
      expect(
        (yield* fromTestPromise(() =>
          runtime.db
            .prepare("SELECT id FROM statement_submissions WHERE user_id=?")
            .bind(userA)
            .all()
        )).results
      ).toHaveLength(0);
      yield* fromTestPromise(() =>
        runtime.db
          .prepare(
            "INSERT INTO statement_whatsapp_documents (turn_id,user_id,media_id,staging_id,reference_json,created_at_ms) VALUES (?,?,?,?,?,?)"
          )
          .bind(turnId, userA, "direct-document", staged.stagingId, JSON.stringify(staged), current)
          .run()
      );
      const response = yield* executeHostedStatementCall({
        db: runtime.db,
        bucket: Option.some(runtime.bucket),
        caller: caller.value,
        current,
        operation: "ingestion.submitForExtraction",
        input: {
          payload: { idempotencyKey: "20000000-0000-4000-8000-000000000799", reference: staged },
        },
        fence: { turnId, toolCallId: ToolCallId.make("direct-upload") },
      });
      expect(response.status).toBe(202);
      const submission = yield* Schema.decodeUnknownEffect(SubmissionResponse)(
        yield* fromTestPromise(() => response.json())
      );
      expect(
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              "SELECT session_id,turn_id FROM statement_hosted_origins WHERE submission_id=? AND user_id=?"
            )
            .bind(submission.data.id, userA)
            .first()
        )
      ).toEqual({ session_id: sessionId, turn_id: turnId });
    })
  ));

it("captures a same-session exact-confirmed hosted row without a browser credential or duplicate capture", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const statement = yield* fromTestPromise(() =>
        clarifyStatement(runtime, "date,amount,description\nunclear,unknown,Cafe\n")
      );
      const id = statement.reviewIds[0];
      if (id === undefined) return yield* Effect.die("Missing review");
      const current = yield* Clock.currentTimeMillis;
      const sessionId = "40000000-0000-4000-8000-000000000981";
      const priorId = "40000000-0000-4000-8000-000000000982";
      const turnId = TranscriptTurnId.make("40000000-0000-4000-8000-000000000983");
      const subject = yield* Schema.decodeEffect(WhatsAppHostedSubject)({
        _tag: "WhatsAppHosted",
        userId: userA,
        portfolioId: "portfolio-1",
        bsuid: "CO.13491208655302741918",
      });
      const operation = "ingestion.resolveNeedsReviewItem";
      const input = yield* Schema.decodeEffect(CanonicalToolEvidence)({
        params: { id },
        payload: {
          extraction: {
            money: { amount: "13000.00", currency: "COP" },
            counterparty: "Tienda",
            direction: "outflow",
            occurredAt: "2026-08-02T12:00:00.000Z",
          },
        },
      });
      const inputJson = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalToolEvidence))(
        input
      );
      const idleMs = 900_000;
      yield* fromTestPromise(() =>
        runtime.db.batch([
          runtime.db
            .prepare(
              "INSERT INTO whatsapp_identities (user_id,portfolio_id,bsuid,verified_at_ms) VALUES (?,?,?,?)"
            )
            .bind(userA, subject.portfolioId, subject.bsuid, current),
          runtime.db
            .prepare(
              "INSERT INTO hosted_agent_sessions (id,user_id,consent_basis_json,started_at_ms,status) VALUES (?,?,'{}',?,'active')"
            )
            .bind(sessionId, userA, current),
          runtime.db
            .prepare(
              "INSERT INTO hosted_turns (id,user_id,hosted_session_id,started_at_ms,status) VALUES (?,?,?,?,'pending')"
            )
            .bind(priorId, userA, sessionId, current),
          runtime.db
            .prepare(
              "INSERT INTO transcript_entries (id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,text) VALUES (?,?,?,?,'assistant',?,'Responde exactamente: CONFIRMAR fixture')"
            )
            .bind("40000000-0000-4000-8000-000000000985", userA, sessionId, priorId, current),
          runtime.db
            .prepare(
              "INSERT INTO hosted_whatsapp_inbound (turn_id,user_id,portfolio_id,bsuid,message_id,business_phone_number_id,occurred_at_ms,received_at_ms) VALUES (?,?,?,?,?,?,?,?)"
            )
            .bind(
              priorId,
              userA,
              subject.portfolioId,
              subject.bsuid,
              "wamid.upload-statement",
              "123456789",
              current,
              current
            ),
          runtime.db
            .prepare(
              "INSERT INTO hosted_whatsapp_delivery (turn_id,user_id,text,correlation_token,business_phone_number_id,proposed_at_ms,state,provider_message_id,delivered_at_ms) VALUES (?,?,'Responde exactamente: CONFIRMAR fixture','statement-challenge','123456789',?,'delivered','wamid.challenge-delivered',?)"
            )
            .bind(priorId, userA, current, current),
          runtime.db
            .prepare("UPDATE hosted_turns SET status='completed',terminal_at_ms=? WHERE id=?")
            .bind(current, priorId),
          runtime.db
            .prepare(
              "INSERT INTO hosted_turns (id,user_id,hosted_session_id,started_at_ms,status) VALUES (?,?,?,?,'pending')"
            )
            .bind(turnId, userA, sessionId, current),
          runtime.db
            .prepare(
              "INSERT INTO hosted_whatsapp_inbound (turn_id,user_id,portfolio_id,bsuid,message_id,business_phone_number_id,occurred_at_ms,received_at_ms) VALUES (?,?,?,?,?,?,?,?)"
            )
            .bind(
              turnId,
              userA,
              subject.portfolioId,
              subject.bsuid,
              "wamid.confirm-statement",
              "123456789",
              current,
              current
            ),
          runtime.db
            .prepare(
              "INSERT INTO statement_hosted_origins (submission_id,user_id,session_id,turn_id,expires_at_ms) VALUES (?,?,?,?,?)"
            )
            .bind(statement.submissionId, userA, sessionId, priorId, current + idleMs),
          runtime.db
            .prepare(
              "INSERT INTO hosted_confirmations (id,user_id,issued_turn_id,operation,input_json,command,issued_at_ms,expires_at_ms,consumed_turn_id,consumed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?)"
            )
            .bind(
              "40000000-0000-4000-8000-000000000984",
              userA,
              priorId,
              operation,
              inputJson,
              "CONFIRMAR fixture",
              current,
              current + idleMs,
              turnId,
              current
            ),
        ])
      );
      const live = protectConsentStatement({
        statement: whatsAppIdentityQuery(subject),
        subject: { _tag: "User", userId: userA },
        requirement: "active",
      });
      const unapproved = yield* mintHostedStatementCaller({
        db: runtime.db,
        subject,
        turnId,
        current,
        live,
        approval: Option.none(),
      });
      if (Option.isNone(unapproved)) return yield* Effect.die("Missing live hosted caller");
      const query = (): Effect.Effect<Response> =>
        executeHostedStatementQuery({
          db: runtime.db,
          bucket: Option.some(runtime.bucket),
          caller: unapproved.value,
          current,
          operation: "ingestion.listNeedsReviewItems",
          input: { query: { status: "pending", limit: "1" } },
        });
      const firstPage = yield* query();
      const responseText = yield* fromTestPromise(() => firstPage.clone().text());
      expect(responseText).not.toContain('"originalEvidence"');
      expect(responseText).not.toContain('"knownMoney"');
      expect(responseText).not.toContain('"message"');
      expect(yield* fromTestPromise(() => firstPage.json())).toMatchObject({
        data: [{ id, status: "pending" }],
      });
      const browserAttempt = yield* fromTestPromise(() =>
        reviewDecision(runtime, { id, action: "resolve" })
      );
      expect(browserAttempt.ok).toBe(false);
      const token = agentToken("H");
      yield* fromTestPromise(() =>
        issuePat({
          current,
          db: runtime.db,
          label: "Hosted-resumption-negative",
          scopes: '["write"]',
          seed: 1984,
          token,
        })
      );
      const patAttempt = yield* fromTestPromise(() =>
        send(
          runtime,
          new Request(`https://api.fidyapp.com/ingestion/needs-review/${id}/resolve`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              origin: browserOrigin,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              extraction: {
                money: { amount: "13000.00", currency: "COP" },
                counterparty: "Tienda",
                direction: "outflow",
                occurredAt: "2026-08-02T12:00:00.000Z",
              },
            }),
          })
        )
      );
      expect(patAttempt.ok).toBe(false);
      expect(
        (yield* fromTestPromise(() =>
          runtime.db
            .prepare("SELECT review_id FROM statement_review_decisions WHERE review_id=?")
            .bind(id)
            .all()
        )).results
      ).toHaveLength(0);
      yield* fromTestPromise(() =>
        runtime.db
          .prepare("UPDATE web_sessions SET revoked_at_ms=? WHERE user_id=?")
          .bind(current, userA)
          .run()
      );
      const fence = { turnId, toolCallId: ToolCallId.make("statement-resolution") };
      expect(
        (yield* executeHostedStatementCall({
          db: runtime.db,
          bucket: Option.some(runtime.bucket),
          caller: unapproved.value,
          current,
          operation,
          input,
          fence,
        })).status
      ).toBe(503);
      const approved = yield* mintHostedStatementCaller({
        db: runtime.db,
        subject,
        turnId,
        current,
        live,
        approval: Option.some({ operation, input }),
      });
      if (Option.isNone(approved)) return yield* Effect.die("Missing approved caller");
      const decoded = yield* Schema.decodeEffect(getCanonicalOperationInput(operation))(input);
      const prepared = yield* prepareHeldStatementReviewDecision({
        operation,
        work: {
          db: runtime.db,
          bucket: Option.some(runtime.bucket),
          userId: userA,
          authority: approved.value.authority,
          originSessionId: Option.some(sessionId),
          originTurns: Option.some(approved.value.originTurns),
          publicationOrigin: Option.some(approved.value.publicationOrigin),
          requiredScope: Option.none(),
          current,
          input: decoded,
        },
      });
      expect(prepared._tag).toBe("Prepared");
      if (prepared._tag !== "Prepared") return yield* Effect.die("Missing prepared decision");
      yield* fromTestPromise(() =>
        expect(
          runtime.db.batch([
            ...prepared.mutation.statements,
            runtime.db.prepare(
              "INSERT INTO canonical_child_guard (child_index,operation,accepted) VALUES (1,'rollback',0)"
            ),
          ])
        ).rejects.toThrow("canonical_child_guard_1")
      );
      expect(
        (yield* executeHostedStatementCall({
          db: runtime.db,
          bucket: Option.some(runtime.bucket),
          caller: approved.value,
          current,
          operation,
          input,
          fence,
        })).status
      ).toBe(200);
      expect(
        (yield* executeHostedStatementCall({
          db: runtime.db,
          bucket: Option.some(runtime.bucket),
          caller: approved.value,
          current,
          operation,
          input,
          fence,
        })).status
      ).toBe(404);
      const completedPage = yield* query();
      expect(yield* fromTestPromise(() => completedPage.json())).toMatchObject({ data: [] });
      expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(1);
      expect(yield* fromTestPromise(() => count(runtime.db, "source_attestations"))).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          runtime.db
            .prepare("SELECT count(*) AS count FROM hosted_mutation_commits WHERE turn_id=?")
            .bind(turnId)
            .first()
        )
      ).toEqual({ count: 1 });
    })
  ));

it("clarifies a mixed statement through canonical capture and erases evidence without losing clean Transactions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const statement = yield* fromTestPromise(() =>
        clarifyStatement(
          runtime,
          "fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n2026-08-02,uncertain,COP,Tienda\n"
        )
      );
      expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(1);
      expect(statement.reviewIds).toHaveLength(1);
      const id = statement.reviewIds[0];
      if (id === undefined) return yield* Effect.die("Missing review");
      const foreign = yield* fromTestPromise(() =>
        reviewDecision(runtime, { id, action: "resolve" }, 1)
      );
      expect(foreign.status).toBe(404);
      const resolved = yield* fromTestPromise(() =>
        reviewDecision(runtime, { id, action: "resolve" })
      );
      expect(resolved.status).toBe(200);
      expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(2);
      expect(yield* fromTestPromise(() => count(runtime.db, "source_attestations"))).toBe(2);
      const retained = yield* fromTestPromise(() =>
        runtime.db
          .prepare(
            "SELECT status, original_evidence, known_money FROM statement_needs_review WHERE id = ?"
          )
          .bind(id)
          .first()
      );
      expect(retained).toEqual({ status: "resolved", original_evidence: null, known_money: null });
      const replay = yield* fromTestPromise(() =>
        reviewDecision(runtime, { id, action: "resolve" })
      );
      expect(replay.status).toBe(404);
      expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(2);
      const read = yield* fromTestPromise(() =>
        send(
          runtime,
          new Request(`https://api.fidyapp.com/ingestion/statements/${statement.submissionId}`, {
            headers: sessionHeaders(0),
          })
        )
      );
      expect(yield* fromTestPromise(() => read.json())).toMatchObject({
        data: {
          status: "completed",
          accounting: { inputRows: 2, acceptedRows: 2, needsReviewRows: 0 },
        },
      });
    })
  ));

it("all-skipped clarification completes without consuming the Free grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const statement = yield* fromTestPromise(() =>
        clarifyStatement(
          runtime,
          "fecha,valor,descripcion\n2026-08-01,-45000,Cafe\n2026-08-02,-13000,Tienda\n"
        )
      );
      const grantBefore = yield* fromTestPromise(() =>
        runtime.db
          .prepare(
            "SELECT submission_id, consumed_at_ms FROM statement_backfill_entitlements WHERE user_id = ?"
          )
          .bind(userA)
          .first()
      );
      expect(grantBefore).toEqual({ submission_id: statement.submissionId, consumed_at_ms: null });
      for (const id of statement.reviewIds) {
        const result = yield* fromTestPromise(() =>
          reviewDecision(runtime, { id, action: "skip" })
        );
        expect(result.status).toBe(200);
      }
      expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(0);
      const grantAfter = yield* fromTestPromise(() =>
        runtime.db
          .prepare(
            "SELECT submission_id, consumed_at_ms FROM statement_backfill_entitlements WHERE user_id = ?"
          )
          .bind(userA)
          .first()
      );
      expect(grantAfter).toEqual({ submission_id: null, consumed_at_ms: null });
      const read = yield* fromTestPromise(() =>
        send(
          runtime,
          new Request(`https://api.fidyapp.com/ingestion/statements/${statement.submissionId}`, {
            headers: sessionHeaders(0),
          })
        )
      );
      expect(yield* fromTestPromise(() => read.json())).toMatchObject({
        data: {
          status: "completed",
          accounting: { inputRows: 2, acceptedRows: 0, needsReviewRows: 0, skippedRows: 2 },
        },
      });
    })
  ));

it("explicit abandonment is permanent and retains captured Transactions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const statement = yield* fromTestPromise(() =>
        clarifyStatement(
          runtime,
          "fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n2026-08-02,uncertain,COP,Tienda\n"
        )
      );
      const abandoned = yield* fromTestPromise(() =>
        send(
          runtime,
          new Request(
            `https://api.fidyapp.com/ingestion/statements/${statement.submissionId}/abandon`,
            { method: "POST", headers: sessionHeaders(0) }
          )
        )
      );
      expect(abandoned.status).toBe(200);
      expect(yield* fromTestPromise(() => abandoned.json())).toMatchObject({
        data: {
          status: "abandoned",
          accounting: { acceptedRows: 1, abandonedRows: 1, needsReviewRows: 0 },
        },
      });
      const id = statement.reviewIds[0];
      if (id === undefined) return yield* Effect.die("Missing review");
      expect(
        (yield* fromTestPromise(() => reviewDecision(runtime, { id, action: "resolve" }))).status
      ).toBe(404);
      expect(yield* fromTestPromise(() => count(runtime.db, "transactions"))).toBe(1);
      const retained = yield* fromTestPromise(() =>
        runtime.db
          .prepare("SELECT original_evidence, known_money FROM statement_needs_review WHERE id = ?")
          .bind(id)
          .first()
      );
      expect(retained).toEqual({ original_evidence: null, known_money: null });
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
        publishFixture(runtime, {
          index: 0,
          idempotencyKey: "20000000-0000-4000-8000-000000000699",
          reference: staged,
        })
      );
      expect(accepted.status).toBe(202);
      const submission = yield* fromTestPromise(() => submissionOf(accepted));
      const coordinator = new UserTransactionCoordinator(
        { id: { name: userA }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
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
      expect(ownBody.data[0]?.originalEvidence).toBeUndefined();
      expect(
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              "SELECT count(*) AS count FROM statement_needs_review WHERE user_id=? AND status='pending' AND original_evidence IS NOT NULL"
            )
            .bind(userA)
            .first()
        )
      ).toEqual({ count: 1 });
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
        executeStatementExtraction({
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
        executeStatementExtraction({
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
        executeStatementExtraction({
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
        publishFixture(runtime, {
          index: 0,
          idempotencyKey: "20000000-0000-4000-8000-000000000682",
          reference: staged,
        })
      );
      expect(accepted.status).toBe(202);
      const submission = yield* fromTestPromise(() => submissionOf(accepted));
      const coordinator = new UserTransactionCoordinator(
        { id: { name: userA }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
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
        publishFixture(runtime, {
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
        { id: { name: userA }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
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
          stageFixture(runtime, { body: oversized, index: 0 })
        );
        expect(tooLarge.status).toBe(413);

        // A PDF claim is refused because of its actual signature, not a declared media type.
        const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
        const unsupported = yield* fromTestPromise(() =>
          stageFixture(runtime, { body: pdf, index: 0 })
        );
        expect(unsupported.status).toBe(400);
        expect(yield* fromTestPromise(() => failureCode(unsupported))).toBe("validation_failed");

        // Password-protected Office files are OLE containers, not supported XLSX ZIPs. Refuse
        // them before staging: this path never accepts or persists a decryption password.
        const protectedOffice = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        const protectedResult = yield* fromTestPromise(() =>
          stageFixture(runtime, { body: protectedOffice, index: 0 })
        );
        expect(protectedResult.status).toBe(400);
        expect(yield* fromTestPromise(() => failureCode(protectedResult))).toBe(
          "validation_failed"
        );

        const empty = yield* fromTestPromise(() =>
          stageFixture(runtime, { body: new Uint8Array(), index: 0 })
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
  "refuses public byte uploads from anonymous, PAT and unknown browser callers",
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
        // Byte staging is private to verified WhatsApp document admission.
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

        expect(anonymous.status).toBe(403);
        expect(withBearer.status).toBe(403);
        expect(unknownSession.status).toBe(403);
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
          stageFixture(runtime, { body: statementBytes(), index: 0 })
            .then(stagedBodyOf)
            .then(stagedWithBody)
        );
        const { body: uploadBody, staged } = uploaded;
        const submitResponse = yield* fromTestPromise(() =>
          publishFixture(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000902",
            index: 0,
            reference: staged,
          })
        );
        const mismatched = yield* fromTestPromise(() =>
          publishFixture(runtime, {
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
          publishFixture(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000904",
            index: 1,
            reference: staged,
          })
        );
        expect(foreign.status).toBe(400);
        const tampered = yield* fromTestPromise(() =>
          publishFixture(runtime, {
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
          publishFixture(runtime, {
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
          publishFixture(runtime, {
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
          publishFixture(runtime, {
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

it("removes expired upload attempt and work claims without clearing live admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const before = yield* Clock.currentTimeMillis;
      const uploaded = yield* fromTestPromise(() =>
        stageFixture(runtime, { body: statementBytes(), index: 0 })
      );
      expect(uploaded.status).toBe(201);
      yield* sweepExpiredUploadAdmission({ db: runtime.db, now: before + 1_000 });
      const live = yield* fromTestPromise(() =>
        scalar<{ total: number }>(
          runtime.db,
          "SELECT count(*) AS total FROM resource_admission_grants WHERE id LIKE 'ingestion-upload-%'"
        )
      );
      expect(live.total).toBe(2);
      yield* sweepExpiredUploadAdmission({ db: runtime.db, now: before + 3_610_000 });
      const expired = yield* fromTestPromise(() =>
        scalar<{ total: number }>(
          runtime.db,
          "SELECT count(*) AS total FROM resource_admission_grants WHERE id LIKE 'ingestion-upload-%'"
        )
      );
      expect(expired.total).toBe(0);
    })
  ));

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
          return stageFixture(runtime, { body: stream, index: 0 });
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
          stageFixture(runtime, { body: statementBytes(), index: 0 })
        );
        expect(refused.status).toBe(429);
        expect(yield* fromTestPromise(() => failureCode(refused))).toBe("rate_limited");

        // A flood of refused uploads consumes attempt pressure, not R2 work capacity.
        for (let attempted = 3; attempted < 40; attempted += 1) {
          const denied = yield* fromTestPromise(() =>
            stageFixture(runtime, { body: statementBytes(), index: 0 })
          );
          expect(denied.status).toBe(429);
        }
        const exhausted = yield* fromTestPromise(() =>
          stageFixture(runtime, { body: statementBytes(), index: 0 })
        );
        expect(exhausted.status).toBe(429);
        expect(yield* fromTestPromise(() => failureCode(exhausted))).toBe("rate_limited");
        for (const release of held) release.resolve();
        const settled = yield* fromTestPromise(() => Promise.all([first, second]));
        expect(settled.map(({ status }) => status)).toEqual([201, 201]);
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_staging_objects"))).toBe(
          2
        );
        // The refused request is durable pressure, but has no R2 work grant or staged bytes.
        const pressure = yield* fromTestPromise(() =>
          scalar<{ total: number }>(
            runtime.db,
            `SELECT count(*) AS total FROM resource_admission_events
             WHERE policy_key = 'ingestion.upload.attempt.user.v1' AND scope_key = ?`,
            userA
          )
        );
        expect(pressure.total).toBe(40);
        const work = yield* fromTestPromise(() =>
          scalar<{ total: number }>(
            runtime.db,
            `SELECT count(*) AS total FROM resource_admission_events
             WHERE policy_key = 'ingestion.upload.user.v1' AND scope_key = ?`,
            userA
          )
        );
        expect(work.total).toBe(2);
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
          publishFixture(runtime, {
            idempotencyKey: "20000000-0000-4000-8000-000000000907",
            index: 0,
            reference: first.staged,
          })
        );
        expect(queued.status).toBe(202);

        const second = yield* fromTestPromise(() => stageOne(runtime));
        const paywalled = yield* fromTestPromise(() =>
          publishFixture(runtime, {
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
          publishFixture(runtime, {
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
          publishFixture(runtime, {
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
          publishFixture(runtime, {
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
  "refuses PAT publication even with read and write scopes",
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
        const owned = yield* fromTestPromise(() => stageOne(runtime));
        const foreign = yield* fromTestPromise(() => stageOne(runtime, 1));
        for (const reference of [owned.staged, foreign.staged]) {
          const refused = yield* fromTestPromise(() =>
            submitWithBearer(runtime, {
              idempotencyKey: "20000000-0000-4000-8000-000000000912",
              reference,
              token,
            })
          );
          expect(refused.status).toBe(403);
        }
        yield* expectCanonicalState(runtime.db, {
          statement_submissions: 0,
          statement_ingestion_outbox: 0,
          statement_submission_audit: 0,
          statement_backfill_entitlements: 0,
          transactions: 0,
          transaction_audit: 0,
        });
        expect(yield* fromTestPromise(() => stagedObjectKeys(runtime))).toHaveLength(2);
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
          publishFixture(runtime, {
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
          publishFixture(runtime, { index: 0, idempotencyKey, reference: winner }).then(
            (response) => response.text()
          )
        );
        const refused = yield* fromTestPromise(() =>
          publishFixture(
            { ...runtime, db: database },
            { index: 0, idempotencyKey, reference: loser }
          )
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
  "refuses browser publication before parsing hostile staged references",
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
        expect(malformed.status).toBe(403);
        expect(yield* fromTestPromise(() => failureCode(malformed))).toBe("user_action_required");
        expect(yield* fromTestPromise(() => count(runtime.db, "statement_submissions"))).toBe(0);
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
        // child, so no failedCallIndex is fabricated and no child is admitted.
        expect(failure.error.message).toBe("Invalid atomic batch input.");
        yield* Effect.tryPromise(() => expect(batchRejectionOf(refused)).rejects.toThrow());
        yield* expectCanonicalState(runtime.db, {
          transactions: 0,
          transaction_audit: 1,
          statement_submission_audit: 0,
        });
        const audit = yield* fromTestPromise(() =>
          runtime.db.prepare("SELECT operation, outcome FROM transaction_audit").all()
        );
        expect(audit.results).toEqual([
          { operation: "operations.executeAtomicBatch", outcome: "validation_failed" },
        ]);
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
          publishFixture(
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
        expect(rejection.error).toMatchObject({
          code: "validation_failed",
          failedCallIndex: 0,
          message:
            "This child's input exceeds the size an individual call of this operation accepts.",
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

it("reclaims expired statement material even when an unrelated email dispatcher fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const expired = yield* fromTestPromise(() => stageOne(runtime));
      yield* fromTestPromise(() =>
        runtime.db
          .prepare("UPDATE statement_staging_objects SET created_at_ms = 0, expires_at_ms = 1")
          .run()
      );
      const current = yield* fromTestPromise(() => stageOne(runtime, 1));
      const rejectExpired = (): Promise<Response> =>
        publishFixture(runtime, {
          index: 0,
          idempotencyKey: "20000000-0000-4000-8000-000000000614",
          reference: expired.staged,
        });
      expect(yield* fromTestPromise(() => stagedObjectKeys(runtime))).toHaveLength(2);
      const beforeSweep = yield* fromTestPromise(rejectExpired);
      expect(beforeSweep.status).toBe(400);
      expect(yield* fromTestPromise(() => failureCode(beforeSweep))).toBe("validation_failed");
      yield* expectCanonicalState(runtime.db, {
        statement_submissions: 0,
        statement_ingestion_outbox: 0,
        transactions: 0,
        statement_backfill_entitlements: 0,
      });
      const failedEmailDatabase: D1Database = {
        prepare: (query) => {
          if (query.includes("browser_pairing_email_outbox")) {
            throw new Error("private database failure detail");
          }
          return runtime.db.prepare(query);
        },
        batch: (statements) => runtime.db.batch(statements),
        exec: (query) => runtime.db.exec(query),
        dump: () => runtime.db.dump(),
        withSession: (bookmark) => runtime.db.withSession(bookmark),
      };
      const result = yield* fromTestPromise(() =>
        coreWorker
          .scheduled(
            { cron: "* * * * *", noRetry: () => undefined, scheduledTime: 0 },
            {
              ...coreEnvironment(runtime),
              DB: failedEmailDatabase,
              BROWSER_PAIRING_EMAIL_QUEUE: {
                send: () => Promise.reject(new Error("unused queue")),
                sendBatch: () => Promise.reject(new Error("unused queue")),
                metrics: () => Promise.reject(new Error("unused queue")),
              },
            }
          )
          .then(
            () => "succeeded",
            () => "failed"
          )
      );
      expect(result).toBe("failed");
      expect(yield* fromTestPromise(() => stagedObjectKeys(runtime))).toHaveLength(1);
      const afterSweep = yield* fromTestPromise(rejectExpired);
      expect(afterSweep.status).toBe(400);
      expect(yield* fromTestPromise(() => failureCode(afterSweep))).toBe("validation_failed");
      yield* expectCanonicalState(runtime.db, {
        statement_submissions: 0,
        statement_ingestion_outbox: 0,
        transactions: 0,
        statement_backfill_entitlements: 0,
      });
      const accepted = yield* fromTestPromise(() =>
        publishFixture(runtime, {
          index: 1,
          idempotencyKey: "20000000-0000-4000-8000-000000000615",
          reference: current.staged,
        })
      );
      expect(accepted.status).toBe(202);
      const published = yield* fromTestPromise(() => submissionOf(accepted));
      expect((yield* fromTestPromise(() => getSubmission(runtime, 0, published.id))).status).toBe(
        404
      );
      expect(
        (yield* fromTestPromise(() =>
          runtime.db
            .prepare("SELECT user_id FROM statement_submission_audit WHERE outcome = 'success'")
            .all()
        )).results
      ).toEqual([{ user_id: userB }]);
    })
  ));

it(
  "reports stalled work and dead letters without exporting identities or Workflow error bodies",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* fromTestPromise(() => setup());
        const staged = yield* fromTestPromise(() => stageOne(runtime));
        yield* fromTestPromise(() =>
          publishFixture(runtime, {
            index: 0,
            idempotencyKey: "20000000-0000-4000-8000-000000000998",
            reference: staged.staged,
          })
        );
        yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              "UPDATE statement_submissions SET submitted_at_ms = 0, retention_expires_at_ms = 1"
            )
            .run()
        );
        const signals = yield* observeOperationalHealth({
          DB: runtime.db,
          workflows: {
            statement: {
              get: () =>
                Promise.resolve({
                  status: () =>
                    Promise.resolve({
                      status: "errored",
                      error: { message: secretSentinel },
                      output: { userId: userA },
                    }),
                }),
            },
          },
          deadLetters: Option.some({
            metrics: () => Promise.resolve({ backlogCount: 3, backlogBytes: 300 }),
          }),
          workQueues: {},
        });
        expect(signals.find((signal) => signal.operation === "statement")).toMatchObject({
          state: "attention",
          sampledPending: 1,
          expiredUndelivered: 1,
          failedWorkflows: 1,
        });
        expect(signals.find((signal) => signal.operation === "deadLetters")).toMatchObject({
          state: "attention",
          backlogCount: 3,
        });
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(signals)
        ).not.toContain(secretSentinel);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(signals)
        ).not.toContain(userA);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(signals)
        ).not.toContain(staged.staged.stagingId);
        const unavailableSignals = yield* observeOperationalHealth({
          DB: runtime.db,
          workflows: { statement: { get: () => Promise.reject(new Error(secretSentinel)) } },
          deadLetters: Option.some({ metrics: () => Promise.reject(new Error(secretSentinel)) }),
          workQueues: {},
        });
        expect(unavailableSignals.find((signal) => signal.operation === "statement")).toMatchObject(
          { state: "attention", unavailableWorkflows: 1 }
        );
        expect(
          unavailableSignals.find((signal) => signal.operation === "deadLetters")
        ).toMatchObject({ state: "unavailable" });
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(unavailableSignals)
        ).not.toContain(secretSentinel);
      })
    ),
  30_000
);

it("Core scheduling expires only old terminal Agent content and preserves current Users and Turns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* fromTestPromise(() => setup());
      const current = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        runtime.db
          .prepare(
            "INSERT INTO onboarding_consent_records (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms) SELECT id, id, '{}', 'fixture', 'fixture', 1, 1 FROM users WHERE id IN (?, ?)"
          )
          .bind(userA, userB)
          .run()
      );
      const cases = [
        {
          userId: userA,
          sessionId: "a0000000-0000-4000-8000-000000000614",
          turnId: "b0000000-0000-4000-8000-000000000614",
          at: current - 31 * dayMilliseconds,
          terminal: true,
        },
        {
          userId: userB,
          sessionId: "a0000000-0000-4000-8000-000000000615",
          turnId: "b0000000-0000-4000-8000-000000000615",
          at: current - dayMilliseconds,
          terminal: true,
        },
        {
          userId: userB,
          sessionId: "a0000000-0000-4000-8000-000000000615",
          turnId: "b0000000-0000-4000-8000-000000000616",
          at: current,
          terminal: false,
        },
      ];
      for (const entry of cases) {
        yield* fromTestPromise(() =>
          runtime.db.batch([
            runtime.db
              .prepare(
                "INSERT OR IGNORE INTO hosted_agent_sessions (id, user_id, consent_basis_json, started_at_ms, status) VALUES (?, ?, '{}', ?, 'active')"
              )
              .bind(entry.sessionId, entry.userId, entry.at),
            runtime.db
              .prepare(
                "INSERT INTO hosted_turns (id, user_id, hosted_session_id, status, started_at_ms) VALUES (?, ?, ?, 'pending', ?)"
              )
              .bind(entry.turnId, entry.userId, entry.sessionId, entry.at),
            runtime.db
              .prepare(
                "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text) VALUES (?, ?, ?, ?, 'user', ?, 'Retained User content')"
              )
              .bind(entry.turnId, entry.userId, entry.sessionId, entry.turnId, entry.at),
          ])
        );
        if (entry.terminal) {
          yield* fromTestPromise(() =>
            runtime.db.batch([
              runtime.db
                .prepare(
                  "INSERT INTO transcript_entries (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, failure_reason) VALUES (?, ?, ?, ?, 'failed', ?, 'HostedInferenceFailed')"
                )
                .bind(entry.sessionId, entry.userId, entry.sessionId, entry.turnId, entry.at + 1),
              runtime.db
                .prepare(
                  "UPDATE hosted_turns SET status = 'failed', terminal_at_ms = ?, failure_reason = 'HostedInferenceFailed' WHERE id = ?"
                )
                .bind(entry.at + 1, entry.turnId),
            ])
          );
        }
      }
      for (const tick of [1, 2]) {
        yield* fromTestPromise(() =>
          coreWorker.scheduled(
            { cron: "* * * * *", noRetry: () => undefined, scheduledTime: tick },
            coreEnvironment(runtime)
          )
        );
        const retained = yield* fromTestPromise(() =>
          runtime.db
            .prepare(
              "SELECT t.user_id, t.status, COUNT(e.id) AS entries FROM hosted_turns t LEFT JOIN transcript_entries e ON e.turn_id = t.id AND e.user_id = t.user_id GROUP BY t.id ORDER BY t.id"
            )
            .all()
        );
        expect(retained.results).toEqual([
          { user_id: userA, status: "failed", entries: 0 },
          { user_id: userB, status: "failed", entries: 2 },
          { user_id: userB, status: "pending", entries: 1 },
        ]);
      }
    })
  ));
