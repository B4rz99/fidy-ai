import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import {
  CreateTransactionInput,
  RestoredTransactionPair,
  Transaction,
  TransactionPresentation,
  encodeMoneyAmount,
} from "@fidy/server/transactions-runtime";
import { UserTransactionCoordinator } from "./transaction-coordinator";
import { AtomicBatchCallId, AtomicBatchRejected, ErrorCode } from "@fidy/server/canonical-runtime";
import type { AtomicBatchCall } from "@fidy/server/canonical-runtime";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { DisclosureSnapshot } from "@fidy/server/agent-runtime";
import { currentDisclosureFor } from "@fidy/server/consent-ingress";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { transactionInput, transactionSession } from "./transactions";
import { browseTransactions } from "./transaction-history";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);
const users = ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000052"];
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
const category = "10000000-0000-4000-8000-000000000016";
let sequence = 0;
const instances: Array<Miniflare> = [];
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));
const replayResponse = (
  result: Readonly<{
    text: () => Promise<string>;
    status: number;
    headers: Iterable<readonly [string, string]>;
  }>
): Promise<Response> =>
  result
    .text()
    .then(
      (text) =>
        new Response(text, { status: result.status, headers: Object.fromEntries(result.headers) })
    );
const bearer = (index: number): string => String(index + 1).repeat(43);
const request = (index: number, path = "/transactions", body?: object): Request =>
  new Request(`https://core.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: `__Host-fidy_session=${bearer(index)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
/** The Transaction capture facts one test submits, with partial overrides for a single case. */
const TestTransactionPayload = Schema.Struct({
  money: Schema.Struct({ amount: Schema.String, currency: Schema.String }),
  direction: Schema.String,
  categoryId: Schema.String,
  occurredAt: Schema.String,
  counterparty: Schema.optionalKey(Schema.String),
  notes: Schema.optionalKey(Schema.String),
});
type TestTransactionPayload = typeof TestTransactionPayload.Type;
const input = (changes: Partial<TestTransactionPayload> = {}): TestTransactionPayload => ({
  money: { amount: "9007199254740993.15", currency: "USD" },
  direction: "outflow",
  categoryId: category,
  occurredAt: "2025-01-10T12:00:00.000Z",
  ...changes,
});
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

/** The coordination environment a test DO instance runs with: D1 plus the hosted-inference seam. */
type CoordinatorTestEnvironment = ConstructorParameters<typeof UserTransactionCoordinator>[1];
const coordinatorEnvironment = (db: D1Database): CoordinatorTestEnvironment => ({
  DB: db,
  AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
  HOSTED_AI_MODEL: approvedWorkersAiModel,
});

const platformModule = (platform: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const built = platform
        ? yield* fromTestPromise(() =>
            Bun.build({
              entrypoints: [new URL("./transaction-platform-fixture.ts", import.meta.url).pathname],
              target: "browser",
            })
          )
        : undefined;
      if (built !== undefined && !built.success) throw new Error("Fixture bundle failed");
      if (built === undefined) return "export default {fetch() {return new Response('ok')}}";
      const output = built.outputs[0];
      if (output === undefined) throw new Error("Fixture module missing");
      return yield* fromTestPromise(() => output.text());
    })
  );

const setup = (platform = false): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      // Every test starts its own deterministic PAT sequence instead of inheriting module order.
      seededPATSequence = 0;
      const fixtureModule = yield* fromTestPromise(() => platformModule(platform));
      const mf = new Miniflare({
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: { DB: { id: `transactions-${++sequence}`, type: "d1" } },
              ...(platform
                ? {
                    exports: {
                      UserTransactionCoordinator: {
                        type: "durable-object" as const,
                        storage: "sqlite" as const,
                      },
                    },
                    env: {
                      DB: { id: `transactions-${sequence}`, type: "d1" as const },
                      USER_TRANSACTION_COORDINATOR: {
                        type: "durable-object" as const,
                        worker: `transactions-${sequence}`,
                        exportName: "UserTransactionCoordinator",
                      },
                      AI: { type: "json" as const, value: { run: null } },
                      HOSTED_AI_MODEL: { type: "text" as const, value: approvedWorkersAiModel },
                    },
                  }
                : {}),
              manifest: {
                mainModule: "index.mjs",
                modules: {
                  "index.mjs": {
                    contents: fixtureModule,
                    type: "esm",
                  },
                },
              },
              name: `transactions-${sequence}`,
              type: "worker",
            },
          },
        ],
      });
      instances.push(mf);
      yield* fromTestPromise(() => mf.ready);
      const db = yield* fromTestPromise(() => mf.getD1Database("DB"));
      yield* fromTestPromise(() =>
        [
          "0001_categories",
          "0003_pending_consent",
          "0004_onboarding_email",
          "0005_verified_onboarding",
          "0006_browser_login",
          "0009_transactions",
          "0010_pat_lifecycle",
          "0011_transaction_corrections",
          "0012_statement_staging",
          "0012_transaction_search",
          "0013_category_keyword_rules",
          "0013_transaction_reconciliation",
          "0014_memory",
          "0015_statement_submission",
          "0016_budgets",
          "0016_hosted_turn",
        ].reduce<Promise<void>>(
          (previous, name) => previous.then(() => applyMigration(db, name)),
          Promise.resolve()
        )
      );
      const current = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        users,
        (user, index) =>
          Effect.gen(function* () {
            yield* fromTestPromise(() =>
              db
                .prepare(
                  "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
                )
                .bind(user, current)
                .run()
            );
            const verifierDigest = yield* fromTestPromise(() => digest(`verifier${index}`));
            yield* fromTestPromise(() =>
              db
                .prepare(
                  "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
                )
                .bind(
                  `10000000-0000-4000-8000-00000000007${index}`,
                  `ABCD-123${index}`,
                  verifierDigest,
                  user,
                  current,
                  current + 600000
                )
                .run()
            );
            const sessionDigest = yield* fromTestPromise(() => digest(bearer(index)));
            yield* fromTestPromise(() =>
              db
                .prepare(
                  "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                )
                .bind(
                  sessions[index],
                  `10000000-0000-4000-8000-00000000007${index}`,
                  user,
                  sessionDigest,
                  current,
                  current + 600000,
                  current + 3600000,
                  current + 7776000000
                )
                .run()
            );
          }),
        { concurrency: "unbounded" }
      );
      return db;
    })
  );

afterEach(() =>
  Effect.runPromise(
    fromTestPromise(() => Promise.all(instances.splice(0).map((mf) => mf.dispose())))
  )
);
const Created = Schema.Struct({
  data: Schema.toCodecJson(Transaction),
  next: Schema.Array(Schema.Unknown),
});
const BatchResult = Schema.Struct({
  data: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        operation: Schema.String,
        output: Schema.Struct({
          data: Schema.toCodecJson(Transaction),
          next: Schema.Array(Schema.Unknown),
        }),
      })
    ),
  }),
  next: Schema.Array(Schema.Unknown),
});
/** One committed batch envelope before any child output is decoded against its own schema. */
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
const CallerFailure = Schema.Struct({ error: Schema.Struct({ code: ErrorCode }) });
const BatchRejection = AtomicBatchRejected;
const batchCallId = (suffix: number): AtomicBatchCallId =>
  Schema.decodeSync(AtomicBatchCallId)(
    `20000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`
  );
/** The selected correction facts one test submits, with only the changed facts supplied. */
const TestCorrectionPayload = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  changes: Schema.Struct({
    notes: Schema.optionalKey(Schema.String),
    categoryId: Schema.optionalKey(Schema.String),
    counterparty: Schema.optionalKey(Schema.String),
    money: Schema.optionalKey(Schema.Struct({ amount: Schema.String, currency: Schema.String })),
    direction: Schema.optionalKey(Schema.String),
    occurredAt: Schema.optionalKey(Schema.String),
  }),
});
type TestCorrectionPayload = typeof TestCorrectionPayload.Type;
const transactionCall = (suffix: number, payload: TestTransactionPayload): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "transactions.createTransaction",
  input: { payload },
});
const correctionCall = (
  suffix: number,
  id: string,
  payload: TestCorrectionPayload
): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "transactions.updateTransaction",
  input: { params: { id }, payload },
});
const linkCall = (suffix: number, first: string, second: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "transactions.linkTransactions",
  input: { payload: { firstTransactionId: first, secondTransactionId: second } },
});
const unlinkCall = (suffix: number, first: string, second: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "transactions.unlinkTransactions",
  input: { payload: { firstTransactionId: first, secondTransactionId: second } },
});
const memoryCall = (suffix: number, text: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "memory.remember",
  input: { payload: { text } },
});
const reviseMemoryCall = (suffix: number, id: string, text: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "memory.revise",
  input: { params: { id }, payload: { text } },
});
const keywordRuleCall = (suffix: number, keyword: string, categoryId: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "categories.createKeywordRule",
  input: { payload: { keyword, categoryId } },
});
const updateKeywordRuleCall = (
  suffix: number,
  id: string,
  payload: Readonly<{ keyword: string; categoryId: string }>
): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "categories.updateKeywordRule",
  input: { params: { id }, payload },
});
const deleteKeywordRuleCall = (suffix: number, id: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "categories.deleteKeywordRule",
  input: { params: { id } },
});
const forgetMemoryCall = (suffix: number, id: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "memory.forget",
  input: { params: { id } },
});
const batchRequest = (index: number, calls: ReadonlyArray<AtomicBatchCall>): Request =>
  new Request("https://api.fidyapp.com/operations/atomic-batch", {
    method: "POST",
    headers: {
      origin: "https://app.fidyapp.com",
      cookie: `__Host-fidy_session=${bearer(index)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ calls }),
  });
const bearerRequest = (
  index: number,
  token: string,
  calls: ReadonlyArray<AtomicBatchCall>
): Request =>
  new Request("https://api.fidyapp.com/operations/atomic-batch", {
    method: "POST",
    headers: {
      origin: "https://app.fidyapp.com",
      authorization: `Bearer ${token}`,
      "x-provider-id": users[index] ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({ calls }),
  });
const countRows = (
  db: D1Database,
  sql: string,
  ...bindings: ReadonlyArray<string>
): Promise<number> =>
  db
    .prepare(sql)
    .bind(...bindings)
    .first<{ count: number }>()
    .then((row) => row?.count ?? -1);

/** The metadata-only Transaction audit rows one User recorded, in occurrence order. */
const auditedOperations = (
  db: D1Database,
  userId: string
): Promise<ReadonlyArray<{ operation: string; outcome: string }>> =>
  db
    .prepare(
      "SELECT operation, outcome FROM transaction_audit WHERE user_id = ? ORDER BY occurred_at_ms"
    )
    .bind(userId)
    .all<{ operation: string; outcome: string }>()
    .then((rows) => rows.results);

/** The metadata-only PAT audit rows one User recorded, in insertion order. */
const auditedPATOperations = (
  db: D1Database,
  userId: string
): Promise<ReadonlyArray<{ operation: string; outcome: string }>> =>
  db
    .prepare("SELECT operation, outcome FROM pat_audit WHERE user_id = ?")
    .bind(userId)
    .all<{ operation: string; outcome: string }>()
    .then((rows) => rows.results);
const seedDailyTransactions = (db: D1Database, count: number): Promise<unknown> => {
  const today = DateTime.formatIso(DateTime.nowUnsafe());
  return db
    .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
    INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    SELECT 'seed-' || n, ?, '1', 'COP', 'outflow', ?, ?, ? FROM seq`)
    .bind(count, users[0], category, today, today)
    .run();
};
const seedTransaction = ({
  db,
  userId,
  id,
  categoryId,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: string;
  categoryId: string;
}>): Promise<unknown> =>
  db
    .prepare(`INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, notes, occurred_at, created_at)
      VALUES (?, ?, '10.00', 'COP', 'outflow', ?, 'seed', '2025-01-05T12:00:00.000Z', '2025-01-05T12:00:00.000Z')`)
    .bind(id, userId, categoryId)
    .run();

type RetainedTransactionFacts = Readonly<{
  db: D1Database;
  userId: string;
  id: string;
  categoryId: string;
}> &
  Partial<{
    amount: string;
    currency: string;
    direction: "inflow" | "outflow";
    counterparty: string;
    notes: string;
    occurredAt: string;
    createdAt: string;
    userDecisions: string;
  }>;

const retainedTransactionDefaults = {
  amount: "45000",
  currency: "COP",
  direction: "outflow",
  occurredAt: "2025-01-05T12:00:00.000Z",
  createdAt: "2025-01-05T12:00:00.000Z",
  userDecisions: "{}",
} as const;

/** Insert one retained Transaction directly, so a test controls exactly what the pair policy reads. */
const seedRetainedTransaction = ({
  db,
  userId,
  id,
  categoryId,
  counterparty,
  notes,
  ...overrides
}: RetainedTransactionFacts): Promise<unknown> => {
  const facts = { ...retainedTransactionDefaults, ...overrides };
  return db
    .prepare(`INSERT INTO transactions
      (id, user_id, amount, currency, direction, counterparty, category_id, notes, occurred_at, created_at, user_decisions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      userId,
      facts.amount,
      facts.currency,
      facts.direction,
      counterparty ?? null,
      categoryId,
      notes ?? null,
      facts.occurredAt,
      facts.createdAt,
      facts.userDecisions
    )
    .run();
};

/** Insert the immutable capture provenance one manual Transaction would have retained. */
const seedManualAttestation = ({
  db,
  userId,
  transactionId,
  id,
}: Readonly<{
  db: D1Database;
  userId: string;
  transactionId: string;
  id: string;
}>): Promise<unknown> =>
  db
    .prepare(`INSERT INTO source_attestations
      (id, user_id, transaction_id, kind, service_market, locale, time_zone, interpretation_revision, created_at)
      VALUES (?, ?, ?, 'manual', 'CO', 'es-CO', 'America/Bogota', 'manual-v1', '2025-01-05T12:00:00.000Z')`)
    .bind(id, userId, transactionId)
    .run();

const DecisionStateRow = Schema.Struct({
  first: Schema.String,
  second: Schema.String,
  state: Schema.String,
  visible: Schema.OptionFromNullOr(Schema.String),
});
const MemberRow = Schema.Struct({ id: Schema.String });

/** The Reconciliation facts one link or unlink outcome left in D1. */
const reconciliationState = (
  db: D1Database,
  userId: string
): Promise<
  Readonly<{
    decisions: ReadonlyArray<{
      first: string;
      second: string;
      state: string;
      visible: Option.Option<string>;
    }>;
    members: ReadonlyArray<{ transaction: string }>;
  }>
> =>
  Promise.all([
    db
      .prepare(
        `SELECT first_transaction_id AS first, second_transaction_id AS second, state, visible_transaction_id AS visible
          FROM transaction_reconciliation_decisions WHERE user_id = ? ORDER BY first_transaction_id`
      )
      .bind(userId)
      .all(),
    db
      .prepare(
        `SELECT transaction_id AS id FROM transaction_reconciliation_members
          WHERE user_id = ? ORDER BY transaction_id`
      )
      .bind(userId)
      .all(),
  ]).then(([decisions, members]) => ({
    decisions: Schema.decodeUnknownSync(Schema.Array(DecisionStateRow))(decisions.results),
    members: Schema.decodeUnknownSync(Schema.Array(MemberRow))(members.results).map((row) => ({
      transaction: row.id,
    })),
  }));

/** Insert the decision and both member rows one committed link leaves behind. */
const seedLinkedPair = ({
  db,
  userId,
  first,
  second,
  visible,
}: Readonly<{
  db: D1Database;
  userId: string;
  first: string;
  second: string;
  visible: string;
}>): Promise<unknown> =>
  db.batch([
    db
      .prepare(`INSERT INTO transaction_reconciliation_decisions
        (user_id, first_transaction_id, second_transaction_id, state, visible_transaction_id, decided_at)
        VALUES (?, ?, ?, 'linked', ?, '2025-01-05T12:00:00.000Z')`)
      .bind(userId, first, second, visible),
    db
      .prepare(`INSERT INTO transaction_reconciliation_members
        (user_id, transaction_id, first_transaction_id, second_transaction_id)
        VALUES (?, ?, ?, ?)`)
      .bind(userId, first, first, second),
    db
      .prepare(`INSERT INTO transaction_reconciliation_members
        (user_id, transaction_id, first_transaction_id, second_transaction_id)
        VALUES (?, ?, ?, ?)`)
      .bind(userId, second, first, second),
  ]);

let seededPATSequence = 0;
const seedPAT = ({
  db,
  userId,
  token,
  scopes,
  current,
}: Readonly<{
  db: D1Database;
  userId: string;
  token: string;
  scopes: ReadonlyArray<string>;
  current: number;
}>): Effect.Effect<void> =>
  Effect.gen(function* () {
    seededPATSequence += 1;
    const suffix = String(seededPATSequence).padStart(12, "0");
    const bearerDigest = yield* fromTestPromise(() => digest(token));
    yield* fromTestPromise(() =>
      db
        .prepare(`INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json, lifetime_days,
          created_at_ms, issued_at_ms, expires_at_ms, request_id) VALUES (?, ?, ?, ?, 'Atomic batch agent', ?, 7, ?, ?, ?, ?)`)
        .bind(
          `40000000-0000-4000-8000-${suffix}`,
          userId,
          token.slice("fin_".length, "fin_".length + 8),
          bearerDigest,
          JSON.stringify(scopes),
          current,
          current,
          current + 7 * 86_400_000,
          `40000000-0000-4000-9000-${suffix}`
        )
        .run()
    );
  });
const countingDb = (db: D1Database): Readonly<{ db: D1Database; batches: () => number }> => {
  let batches = 0;
  return {
    db: {
      prepare: (sql) => db.prepare(sql),
      batch: (statements) => {
        batches += 1;
        return db.batch(statements);
      },
      exec: (sql) => db.exec(sql),
      withSession: (constraint) => db.withSession(constraint),
      dump: () => db.dump(),
    },
    batches: () => batches,
  };
};
const racingBatch = (db: D1Database, before: () => Promise<unknown>): D1Database => ({
  prepare: (sql) => db.prepare(sql),
  batch: (statements) => before().then(() => db.batch(statements)),
  exec: (sql) => db.exec(sql),
  withSession: (constraint) => db.withSession(constraint),
  dump: () => db.dump(),
});
const concurrentCorrection = ({
  db,
  userId,
  transactionId,
  evidenceId,
}: Readonly<{
  db: D1Database;
  userId: string;
  transactionId: string;
  evidenceId: string;
}>): Promise<unknown> =>
  db
    .prepare(`INSERT INTO transaction_corrections (id, user_id, transaction_id, previous_revision, changed_fields, before_facts, after_facts, corrected_at)
      VALUES (?, ?, ?, 0, '["notes"]', '{"notes":"seed"}', '{"notes":"concurrent"}', '2025-01-06T12:00:00.000Z')`)
    .bind(evidenceId, userId, transactionId)
    .run()
    .then(() =>
      db
        .prepare(
          "UPDATE transactions SET notes = 'concurrent', revision = 1 WHERE user_id = ? AND id = ? AND revision = 0"
        )
        .bind(userId, transactionId)
        .run()
    );
const concurrentMoneyCorrection = ({
  db,
  userId,
  transactionId,
  evidenceId,
  amount,
}: Readonly<{
  db: D1Database;
  userId: string;
  transactionId: string;
  evidenceId: string;
  amount: string;
}>): Promise<unknown> =>
  db
    .prepare(`INSERT INTO transaction_corrections (id, user_id, transaction_id, previous_revision, changed_fields, before_facts, after_facts, corrected_at)
      VALUES (?, ?, ?, 0, '["money"]', '{"amount":"45000"}', ?, '2025-01-06T12:00:00.000Z')`)
    .bind(evidenceId, userId, transactionId, JSON.stringify({ amount }))
    .run()
    .then(() =>
      db
        .prepare(
          "UPDATE transactions SET amount = ?, revision = 1 WHERE user_id = ? AND id = ? AND revision = 0"
        )
        .bind(amount, userId, transactionId)
        .run()
    );
const sendPublicRequest = (
  db: D1Database,
  request: Request,
  coordinator?: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>
): Promise<Response> =>
  publicWorker.fetch(request, {
    BROWSER_ORIGIN: "https://app.fidyapp.com",
    LOCAL_CANONICAL_READ_BEARER: "",
    PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CORE: {
      fetch: (internal) =>
        coreWorker.fetch(new Request(internal), {
          DB: db,
          AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
          CONTRACT_DIGEST: "a".repeat(64),
          RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
          HOSTED_AI_MODEL: approvedWorkersAiModel,
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          WOMPI_ENVIRONMENT: "",
          WOMPI_PUBLIC_KEY: "",
          WOMPI_PRIVATE_KEY: "",
          WOMPI_INTEGRITY_SECRET: "",
          USER_TRANSACTION_COORDINATOR: coordinator ?? {
            getByName: (name) => ({
              fetch: (command) =>
                new UserTransactionCoordinator({ id: { name } }, coordinatorEnvironment(db)).fetch(
                  new Request(command)
                ),
            }),
          },
          KAPSO_API_KEY: "",
          KAPSO_WEBHOOK_SECRET: "",
          WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
          CLOUDFLARE_ACCESS_ISSUER: "",
          CLOUDFLARE_ACCESS_AUDIENCE: "",
        }),
    },
  });
effectIt.effect(
  "routes a browser Turn through public ingress, Core and the per-User coordinator to Workers AI",
  () =>
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const now = yield* Clock.currentTimeMillis;
      const disclosure = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
      )(currentDisclosureFor());
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO onboarding_consent_records
      (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms)
      VALUES (?, ?, ?, 'disclosed', 'accepted', ?, ?)`)
          .bind("10000000-0000-4000-8000-000000000091", users[0], disclosure, now, now)
          .run()
      );
      const coordinator = new UserTransactionCoordinator(
        { id: { name: users[0] ?? "" } },
        {
          ...coordinatorEnvironment(db),
          AI: {
            run: (): Promise<Response> =>
              Promise.resolve(
                Response.json({
                  choices: [
                    {
                      message: { role: "assistant", content: "Respuesta visible" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
                })
              ),
          },
        }
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/web/hosted-turns", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: '{"text":"Hola"}',
          }),
          {
            getByName: (): Pick<Fetcher, "fetch"> => ({
              fetch: (request) => coordinator.fetch(new Request(request)),
            }),
          }
        )
      );
      expect(response.status).toBe(200);
      expect(yield* fromTestPromise(() => response.json())).toEqual({ text: "Respuesta visible" });
      const rows = yield* fromTestPromise(() =>
        db.prepare(`SELECT status FROM hosted_turns WHERE user_id = ?`).bind(users[0]).all()
      );
      expect(rows.results).toEqual([{ status: "completed" }]);
    })
);
/** One manual capture submitted through the public ingress exactly as a client sends it. */
const postTransaction = (index: number, body: object): Request =>
  new Request("https://api.fidyapp.com/transactions", {
    method: "POST",
    headers: {
      origin: "https://app.fidyapp.com",
      cookie: `__Host-fidy_session=${bearer(index)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const Listed = Schema.Struct({
  data: Schema.Array(Schema.toCodecJson(Transaction)),
  next: Schema.Array(Schema.Unknown),
});
const EffectiveTransaction = Schema.Struct({
  data: Schema.toCodecJson(TransactionPresentation),
  next: Schema.Array(Schema.Unknown),
});
const RestoredPair = Schema.Struct({
  data: Schema.toCodecJson(RestoredTransactionPair),
  next: Schema.Array(Schema.Unknown),
});
const ListedMemories = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  next: Schema.Array(Schema.Unknown),
});
const ListedKeywordRules = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, keyword: Schema.String, categoryId: Schema.String })
  ),
  next: Schema.Array(Schema.Unknown),
});

it("searches only the caller's FinancialRecord with bounded literal terms", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const send = (index: number, path: string, body?: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
      const own = yield* fromTestPromise(() =>
        send(0, "/transactions", input({ counterparty: "Café 100%", notes: "Almuerzo" }))
      );
      const foreign = yield* fromTestPromise(() =>
        send(1, "/transactions", input({ counterparty: "Café 100%" }))
      );
      expect(own.status).toBe(201);
      expect(foreign.status).toBe(201);
      const ownId = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => own.json())
      )).data.id;
      const foreignId = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => foreign.json())
      )).data.id;
      const found = yield* fromTestPromise(() =>
        send(0, "/transactions/search?q=%20%20Caf%C3%A9%20100%25%20")
      );
      expect(found.status).toBe(200);
      const result = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => found.json())
      );
      expect(result.data.map((item) => item.id)).toEqual([ownId]);
      expect(result.next).toEqual([]);
      for (const [index, term] of [
        [1, ownId],
        [0, foreignId],
        [0, "100_"],
      ] as const) {
        const response = yield* fromTestPromise(() =>
          send(index, `/transactions/search?q=${encodeURIComponent(term)}`)
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Listed)(yield* fromTestPromise(() => response.json())))
            .data
        ).toEqual([]);
      }
      const unicodeTerm = encodeURIComponent("é".repeat(80));
      expect(
        (yield* fromTestPromise(() => send(0, `/transactions/search?q=${unicodeTerm}`))).status
      ).toBe(200);
      for (const path of [
        `/transactions/search?q=${"a".repeat(3000)}`,
        "/transactions/search?q=%25",
        "/transactions/search?q=a",
        `/transactions/search?q=${"x".repeat(100)}`,
        "/transactions/search?q=valid&q=valid",
        "/transactions/search?q=valid&cursor=bad",
        "/transactions/search?q=%ZZ",
        "/transactions/search?q=%FF%FF",
      ]) {
        const rejected = yield* fromTestPromise(() => send(0, path));
        expect(rejected.status).toBe(400);
        expect(rejected.headers.get("cache-control")).toBe("no-store");
      }
    })
  ));

it("links one exact pair into one effective Transaction while retaining both originals and provenance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const visible = "30000000-0000-4000-8000-000000000101";
      const suppressed = "30000000-0000-4000-8000-000000000102";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({
            db,
            userId: owner,
            id: visible,
            categoryId: category,
            counterparty: "Cafe Uno",
            notes: "notificacion",
          }),
          seedRetainedTransaction({
            db,
            userId: owner,
            id: suppressed,
            categoryId: category,
            counterparty: "Cafe Dos",
            notes: "extracto",
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
          seedManualAttestation({
            db,
            userId: owner,
            transactionId: visible,
            id: "30000000-0000-4000-8000-000000000201",
          }),
          seedManualAttestation({
            db,
            userId: owner,
            transactionId: suppressed,
            id: "30000000-0000-4000-8000-000000000202",
          }),
        ])
      );
      const send = (path: string, body?: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
      const linked = yield* fromTestPromise(() =>
        send("/transactions/link", {
          firstTransactionId: suppressed,
          secondTransactionId: visible,
        })
      );
      expect(linked.status).toBe(200);
      const effectiveTransaction = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() => linked.json())
      ).pipe(Effect.orDie)).data;
      expect(effectiveTransaction.id).toBe(visible);
      expect(effectiveTransaction.presentation).toEqual({ kind: "visible-member" });
      expect(yield* fromTestPromise(() => auditedOperations(db, owner))).toEqual([
        { operation: "transactions.linkTransactions", outcome: "success" },
      ]);

      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => send("/transactions").then((response) => response.json()))
      ).pipe(Effect.orDie)).data;
      expect(listed.map((transaction) => transaction.id)).toEqual([visible]);
      const requestedSuppressed = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() =>
          send(`/transactions/${suppressed}`).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      expect(requestedSuppressed.id).toBe(visible);
      expect(requestedSuppressed.presentation).toEqual({
        kind: "suppressed-member",
        requestedId: suppressed,
      });
      const requestedVisible = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() =>
          send(`/transactions/${visible}`).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      expect(requestedVisible.presentation).toEqual({ kind: "visible-member" });
      const searched = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          send(`/transactions/search?q=${encodeURIComponent("Cafe Uno")}`).then((response) =>
            response.json()
          )
        )
      ).pipe(Effect.orDie)).data;
      expect(searched.map((transaction) => transaction.id)).toEqual([visible]);

      const retained = yield* fromTestPromise(() =>
        db
          .prepare("SELECT id, counterparty, notes FROM transactions WHERE user_id = ? ORDER BY id")
          .bind(owner)
          .all<{ id: string; counterparty: string; notes: string }>()
      );
      expect(retained.results).toEqual([
        { id: visible, counterparty: "Cafe Uno", notes: "notificacion" },
        { id: suppressed, counterparty: "Cafe Dos", notes: "extracto" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id = ?",
            owner
          )
        )
      ).toBe(2);
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [
          { first: visible, second: suppressed, state: "linked", visible: Option.some(visible) },
        ],
        members: [{ transaction: visible }, { transaction: suppressed }],
      });
    })
  ));

it("refuses ineligible pairs without writing any relation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const base = "30000000-0000-4000-8000-00000000015";
      const pairs = [
        { first: `${base}1`, second: `${base}2`, secondFacts: { currency: "USD" } },
        { first: `${base}3`, second: `${base}4`, secondFacts: { amount: "45000.01" } },
        { first: `${base}5`, second: `${base}6`, secondFacts: { direction: "inflow" as const } },
      ];
      yield* fromTestPromise(() =>
        Promise.all(
          pairs.flatMap((pair) => [
            seedRetainedTransaction({ db, userId: owner, id: pair.first, categoryId: category }),
            seedRetainedTransaction({
              db,
              userId: owner,
              id: pair.second,
              categoryId: category,
              ...pair.secondFacts,
            }),
          ])
        )
      );
      const send = (body: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions/link", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          })
        );
      for (const pair of pairs) {
        const refused = yield* fromTestPromise(() =>
          send({ firstTransactionId: pair.first, secondTransactionId: pair.second })
        );
        expect(refused.status).toBe(400);
        expect(refused.headers.get("cache-control")).toBe("no-store");
      }
      const repeated = yield* fromTestPromise(() =>
        send({ firstTransactionId: `${base}1`, secondTransactionId: `${base}1` })
      );
      expect(repeated.status).toBe(400);
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [],
        members: [],
      });
      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request("https://api.fidyapp.com/transactions", {
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: `__Host-fidy_session=${bearer(0)}`,
              },
            })
          ).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      expect(listed.map((transaction) => transaction.id).sort()).toEqual(
        pairs.flatMap((pair) => [pair.first, pair.second]).sort()
      );
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ? AND operation = 'transactions.linkTransactions' AND outcome = 'validation_failed'",
            owner
          )
        )
      ).toBe(4);
    })
  ));

it("unlinks the exact pair, restores both originals, and remembers keep-separate", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const visible = "30000000-0000-4000-8000-000000000301";
      const suppressed = "30000000-0000-4000-8000-000000000302";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({ db, userId: owner, id: visible, categoryId: category }),
          seedRetainedTransaction({
            db,
            userId: owner,
            id: suppressed,
            categoryId: category,
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
          seedManualAttestation({
            db,
            userId: owner,
            transactionId: suppressed,
            id: "30000000-0000-4000-8000-000000000402",
          }),
        ])
      );
      const send = (path: string, body: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          })
        );
      const link = (): Promise<Response> =>
        send("/transactions/link", {
          firstTransactionId: visible,
          secondTransactionId: suppressed,
        });
      expect((yield* fromTestPromise(link)).status).toBe(200);
      const unlinked = yield* fromTestPromise(() =>
        send("/transactions/unlink", {
          firstTransactionId: suppressed,
          secondTransactionId: visible,
        })
      );
      expect(unlinked.status).toBe(200);
      const restored = (yield* Schema.decodeUnknownEffect(RestoredPair)(
        yield* fromTestPromise(() => unlinked.json())
      ).pipe(Effect.orDie)).data;
      expect(restored.firstTransaction.id).toBe(visible);
      expect(restored.secondTransaction.id).toBe(suppressed);
      expect(restored.firstTransaction.presentation).toEqual({ kind: "independent" });
      expect(restored.secondTransaction.presentation).toEqual({ kind: "independent" });
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [
          {
            first: visible,
            second: suppressed,
            state: "keep-separate",
            visible: Option.none(),
          },
        ],
        members: [],
      });
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id = ?",
            owner
          )
        )
      ).toBe(1);
      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request("https://api.fidyapp.com/transactions", {
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: `__Host-fidy_session=${bearer(0)}`,
              },
            })
          ).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      expect(listed.map((transaction) => transaction.id)).toEqual([suppressed, visible]);
      expect(
        (yield* fromTestPromise(() =>
          send("/transactions/unlink", {
            firstTransactionId: visible,
            secondTransactionId: suppressed,
          })
        )).status
      ).toBe(400);
      expect((yield* fromTestPromise(link)).status).toBe(200);
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [
          { first: visible, second: suppressed, state: "linked", visible: Option.some(visible) },
        ],
        members: [{ transaction: visible }, { transaction: suppressed }],
      });
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ? AND operation IN ('transactions.linkTransactions', 'transactions.unlinkTransactions') AND outcome = 'success'",
            owner
          )
        )
      ).toBe(3);
    })
  ));

it("refuses duplicate, chained, and cross-User links without partial relation state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const neighbor = users[1] ?? "";
      const firstId = "30000000-0000-4000-8000-000000000501";
      const secondId = "30000000-0000-4000-8000-000000000502";
      const thirdId = "30000000-0000-4000-8000-000000000503";
      const foreign = "30000000-0000-4000-8000-000000000504";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({
            db,
            userId: owner,
            id: firstId,
            categoryId: category,
            counterparty: "Cafe Central",
          }),
          seedRetainedTransaction({
            db,
            userId: owner,
            id: secondId,
            categoryId: category,
            counterparty: "Cafe Central",
          }),
          seedRetainedTransaction({
            db,
            userId: owner,
            id: thirdId,
            categoryId: category,
            counterparty: "Cafe Central",
          }),
          seedRetainedTransaction({ db, userId: neighbor, id: foreign, categoryId: category }),
        ])
      );
      const send = (index: number, path: string, body?: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
      expect(
        (yield* fromTestPromise(() =>
          send(0, "/transactions/link", {
            firstTransactionId: firstId,
            secondTransactionId: secondId,
          })
        )).status
      ).toBe(200);
      for (const pair of [
        { firstTransactionId: firstId, secondTransactionId: secondId },
        { firstTransactionId: firstId, secondTransactionId: thirdId },
        { firstTransactionId: secondId, secondTransactionId: thirdId },
      ]) {
        expect((yield* fromTestPromise(() => send(0, "/transactions/link", pair))).status).toBe(
          400
        );
      }
      expect(
        (yield* fromTestPromise(() =>
          send(0, "/transactions/link", {
            firstTransactionId: firstId,
            secondTransactionId: foreign,
          })
        )).status
      ).toBe(404);
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [
          { first: firstId, second: secondId, state: "linked", visible: Option.some(firstId) },
        ],
        members: [{ transaction: firstId }, { transaction: secondId }],
      });
      const neighborList = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => send(1, "/transactions").then((response) => response.json()))
      ).pipe(Effect.orDie)).data;
      expect(neighborList.map((transaction) => transaction.id)).toEqual([foreign]);
      expect((yield* fromTestPromise(() => send(1, `/transactions/${firstId}`))).status).toBe(404);
      expect((yield* fromTestPromise(() => send(1, `/transactions/${secondId}`))).status).toBe(404);
      const neighborSearch = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          send(1, "/transactions/search?q=Cafe").then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      expect(neighborSearch).toEqual([]);
      const ownerSearch = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          send(0, "/transactions/search?q=Cafe").then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      expect(ownerSearch.map((transaction) => transaction.id).sort()).toEqual(
        [firstId, thirdId].sort()
      );
    })
  ));

it("serializes concurrent links through the User coordinator so only one pair commits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup(true));
      const instance = instances.at(-1);
      if (instance === undefined) throw new Error("Missing Miniflare runtime");
      const namespace = yield* fromTestPromise(() =>
        instance.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR")
      );
      const coordinator = {
        getByName: (
          name: string
        ): Readonly<{ fetch: (command: Request) => Promise<Response> }> => ({
          fetch: (command: Request): Promise<Response> =>
            command.text().then((body) =>
              namespace
                .getByName(name)
                .fetch(command.url, {
                  method: command.method,
                  headers: Object.fromEntries(command.headers),
                  body,
                })
                .then(replayResponse)
            ),
        }),
      };
      const owner = users[0] ?? "";
      const firstId = "30000000-0000-4000-8000-000000000601";
      const secondId = "30000000-0000-4000-8000-000000000602";
      const thirdId = "30000000-0000-4000-8000-000000000603";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({ db, userId: owner, id: firstId, categoryId: category }),
          seedRetainedTransaction({ db, userId: owner, id: secondId, categoryId: category }),
          seedRetainedTransaction({ db, userId: owner, id: thirdId, categoryId: category }),
        ])
      );
      const link = (firstId: string, secondId: string): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions/link", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ firstTransactionId: firstId, secondTransactionId: secondId }),
          }),
          coordinator
        );
      const results = yield* fromTestPromise(() =>
        Promise.all([link(firstId, secondId), link(secondId, thirdId), link(firstId, secondId)])
      );
      expect(results.map(({ status }) => status).sort((left, right) => left - right)).toEqual([
        200, 400, 400,
      ]);
      const state = yield* fromTestPromise(() => reconciliationState(db, owner));
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]?.state).toBe("linked");
      expect(state.members).toHaveLength(2);
    })
  ));

it("keeps the effective Transaction consistent after corrections to either member", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const correctedCategory = "10000000-0000-4000-8000-000000000012";
      const visible = "30000000-0000-4000-8000-000000000701";
      const suppressed = "30000000-0000-4000-8000-000000000702";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({
            db,
            userId: owner,
            id: visible,
            categoryId: category,
            counterparty: "Original",
            occurredAt: "2025-01-05T12:00:00.000Z",
            createdAt: "2025-01-05T12:00:00.000Z",
          }),
          seedRetainedTransaction({
            db,
            userId: owner,
            id: suppressed,
            categoryId: category,
            counterparty: "Extracto",
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
          seedManualAttestation({
            db,
            userId: owner,
            transactionId: visible,
            id: "30000000-0000-4000-8000-000000000801",
          }),
        ])
      );
      const send = (path: string, method: string, body: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method,
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          })
        );
      expect(
        (yield* fromTestPromise(() =>
          send("/transactions/link", "POST", {
            firstTransactionId: visible,
            secondTransactionId: suppressed,
          })
        )).status
      ).toBe(200);
      const read = (id: string): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com/transactions/${id}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
            },
          })
        );
      const beforeSuppressed = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() => read(suppressed).then((response) => response.json()))
      ).pipe(Effect.orDie)).data;
      expect(beforeSuppressed.revision).toBe(0);
      expect(
        (yield* fromTestPromise(() =>
          send(`/transactions/${suppressed}`, "PUT", {
            expectedRevision: beforeSuppressed.revision,
            changes: { categoryId: correctedCategory, counterparty: "Corregido" },
          })
        )).status
      ).toBe(200);
      const corrected = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() => read(suppressed).then((response) => response.json()))
      ).pipe(Effect.orDie)).data;
      expect(corrected.id).toBe(visible);
      expect(corrected.revision).toBe(1);
      expect(corrected.categoryId).toBe(correctedCategory);
      expect(Option.getOrNull(corrected.counterparty)).toBe("Corregido");
      expect(DateTime.formatIso(corrected.occurredAt)).toBe("2025-01-06T12:00:00.000Z");
      const visiblePresentation = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() => read(visible).then((response) => response.json()))
      ).pipe(Effect.orDie)).data;
      expect(visiblePresentation.revision).toBe(0);
      expect(
        (yield* fromTestPromise(() =>
          send(`/transactions/${suppressed}`, "PUT", {
            expectedRevision: 0,
            changes: { notes: "late" },
          })
        )).status
      ).toBe(400);
      expect(
        (yield* fromTestPromise(() =>
          send(`/transactions/${visible}`, "PUT", {
            expectedRevision: visiblePresentation.revision,
            changes: { notes: "Nota visible" },
          })
        )).status
      ).toBe(200);
      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request("https://api.fidyapp.com/transactions", {
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: `__Host-fidy_session=${bearer(0)}`,
              },
            })
          ).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(visible);
      expect(listed[0]?.categoryId).toBe(correctedCategory);
      expect(Option.getOrNull(listed[0]?.counterparty ?? Option.none())).toBe("Corregido");
      expect(Option.getOrNull(listed[0]?.notes ?? Option.none())).toBe("Nota visible");
      const RetainedFacts = Schema.Struct({
        id: Schema.String,
        counterparty: Schema.OptionFromNullOr(Schema.String),
        notes: Schema.OptionFromNullOr(Schema.String),
      });
      const retained = yield* fromTestPromise(() =>
        db
          .prepare("SELECT id, counterparty, notes FROM transactions WHERE user_id = ? ORDER BY id")
          .bind(owner)
          .all()
          .then((rows) => Schema.decodeUnknownSync(Schema.Array(RetainedFacts))(rows.results))
      );
      expect(retained).toEqual([
        { id: visible, counterparty: Option.some("Original"), notes: Option.some("Nota visible") },
        { id: suppressed, counterparty: Option.some("Corregido"), notes: Option.none() },
      ]);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_corrections WHERE user_id = ?",
            owner
          )
        )
      ).toBe(2);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id = ?",
            owner
          )
        )
      ).toBe(1);
    })
  ));

it("derives each effective fact group from the member the Transaction policy selects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const visible = "30000000-0000-4000-8000-000000000a01";
      const suppressed = "30000000-0000-4000-8000-000000000a02";
      const suppressedCategory = "10000000-0000-4000-8000-000000000012";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({
            db,
            userId: owner,
            id: visible,
            categoryId: category,
            counterparty: "Uno",
            notes: "visible",
          }),
          seedRetainedTransaction({
            db,
            userId: owner,
            id: suppressed,
            categoryId: suppressedCategory,
            counterparty: "Dos",
            notes: "suppressed",
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
            userDecisions: JSON.stringify({ categoryId: true, counterparty: true }),
          }),
        ])
      );
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request("https://api.fidyapp.com/transactions/link", {
              method: "POST",
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: `__Host-fidy_session=${bearer(0)}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                firstTransactionId: visible,
                secondTransactionId: suppressed,
              }),
            })
          )
        )).status
      ).toBe(200);
      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request("https://api.fidyapp.com/transactions", {
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: `__Host-fidy_session=${bearer(0)}`,
              },
            })
          ).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      const effective = listed[0];
      if (effective === undefined) throw new Error("Missing effective Transaction");
      expect(listed).toHaveLength(1);
      // The later-created member explicitly decided Category and Counterparty, so those groups come
      // from it; notes and occurrence were never decided, so they stay with the visible member.
      expect(effective.categoryId).toBe(suppressedCategory);
      expect(Option.getOrNull(effective.counterparty)).toBe("Dos");
      expect(Option.getOrNull(effective.notes)).toBe("visible");
      expect(DateTime.formatIso(effective.occurredAt)).toBe("2025-01-05T12:00:00.000Z");
      // Correcting both members at the same instant leaves the greater id authoritative for Money.
      yield* fromTestPromise(() =>
        Promise.all(
          [visible, suppressed].map((transactionId, index) =>
            db
              .prepare(`INSERT INTO transaction_corrections
                (id, user_id, transaction_id, previous_revision, changed_fields, before_facts, after_facts, corrected_at)
                VALUES (?, ?, ?, 0, '[]', '{}', '{}', '2025-02-01T00:00:00.000Z')`)
              .bind(`40000000-0000-4000-8000-00000000010${index}`, owner, transactionId)
              .run()
          )
        )
      );
      const corrected = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request("https://api.fidyapp.com/transactions", {
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: `__Host-fidy_session=${bearer(0)}`,
              },
            })
          ).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      const afterTie = corrected[0];
      if (afterTie === undefined) throw new Error("Missing effective Transaction");
      expect(DateTime.formatIso(afterTie.occurredAt)).toBe("2025-01-06T12:00:00.000Z");
    })
  ));

it("links and unlinks under the caller's live credential scope and records only metadata for an agent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const firstId = "30000000-0000-4000-8000-000000000901";
      const secondId = "30000000-0000-4000-8000-000000000902";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({
            db,
            userId: owner,
            id: firstId,
            categoryId: category,
            counterparty: "Agente",
          }),
          seedRetainedTransaction({
            db,
            userId: owner,
            id: secondId,
            categoryId: category,
            counterparty: "Agente",
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
        ])
      );
      const current = yield* Clock.currentTimeMillis;
      const readToken = `fin_${"r".repeat(8)}_${"thirdId".repeat(43)}`;
      const writeToken = `fin_${"w".repeat(8)}_${"d".repeat(43)}`;
      yield* seedPAT({ db, userId: owner, token: readToken, scopes: ["read"], current });
      yield* seedPAT({ db, userId: owner, token: writeToken, scopes: ["write"], current });
      const bearerRequest = (token: string, path: string, body?: object): Request =>
        new Request(`https://api.fidyapp.com${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            authorization: `Bearer ${token}`,
            "x-provider-id": owner,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const pair = { firstTransactionId: firstId, secondTransactionId: secondId };
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(db, bearerRequest(readToken, "/transactions/link", pair))
        )).status
      ).toBe(403);
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [],
        members: [],
      });
      const linked = yield* fromTestPromise(() =>
        sendPublicRequest(db, bearerRequest(writeToken, "/transactions/link", pair))
      );
      expect(linked.status).toBe(200);
      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          sendPublicRequest(db, bearerRequest(readToken, "/transactions")).then((response) =>
            response.json()
          )
        )
      ).pipe(Effect.orDie)).data;
      expect(listed.map((transaction) => transaction.id)).toEqual([firstId]);
      const searched = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            bearerRequest(readToken, `/transactions/search?q=${encodeURIComponent("Agente")}`)
          ).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      expect(searched.map((transaction) => transaction.id)).toEqual([firstId]);
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(db, bearerRequest(writeToken, "/transactions/unlink", pair))
        )).status
      ).toBe(200);
      const audits = yield* fromTestPromise(() =>
        db
          .prepare(
            `SELECT operation, outcome FROM pat_audit WHERE user_id = ?
              AND operation IN ('transactions.linkTransactions', 'transactions.unlinkTransactions')
              ORDER BY operation`
          )
          .bind(owner)
          .all<{ operation: string; outcome: string }>()
      );
      expect(audits.results).toEqual([
        { operation: "transactions.linkTransactions", outcome: "accepted" },
        { operation: "transactions.unlinkTransactions", outcome: "accepted" },
      ]);
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE pats SET revoked_at_ms = ? WHERE short_id = ?")
          .bind(current, writeToken.slice(4, 12))
          .run()
      );
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(db, bearerRequest(writeToken, "/transactions/link", pair))
        )).status
      ).toBe(401);
      const expiredToken = `fin_${"x".repeat(8)}_${"g".repeat(43)}`;
      yield* seedPAT({ db, userId: owner, token: expiredToken, scopes: ["write"], current });
      yield* fromTestPromise(() =>
        db
          .prepare(
            "UPDATE pats SET created_at_ms = ?, issued_at_ms = ?, expires_at_ms = ? WHERE short_id = ?"
          )
          .bind(current - 2000, current - 2000, current - 1, expiredToken.slice(4, 12))
          .run()
      );
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(db, bearerRequest(expiredToken, "/transactions/link", pair))
        )).status
      ).toBe(401);
      const withdrawnGrant = "50000000-0000-4000-8000-000000000011";
      const consentToken = `fin_${"c".repeat(8)}_${"e".repeat(43)}`;
      yield* seedPAT({ db, userId: owner, token: consentToken, scopes: ["write"], current });
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO onboarding_consent_records
            (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
            VALUES (?,?,'{}','disclosure','decision',?,?)`)
          .bind(withdrawnGrant, owner, current, current)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO consent_user_revocations (id,user_id,grant_record_id,session_id,occurred_at_ms)
            VALUES (?,?,?,?,?)`)
          .bind("50000000-0000-4000-8000-000000000012", owner, withdrawnGrant, sessions[0], current)
          .run()
      );
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(db, bearerRequest(consentToken, "/transactions/link", pair))
        )).status
      ).toBe(403);
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(current, sessions[0])
          .run()
      );
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request("https://api.fidyapp.com/transactions/unlink", {
              method: "POST",
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: `__Host-fidy_session=${bearer(0)}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(pair),
            })
          )
        )).status
      ).toBe(401);
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [
          {
            first: firstId,
            second: secondId,
            state: "keep-separate",
            visible: Option.none(),
          },
        ],
        members: [],
      });
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            `SELECT COUNT(*) AS count FROM pat_audit WHERE user_id = ?
              AND operation IN ('transactions.linkTransactions', 'transactions.unlinkTransactions')
              AND outcome = 'accepted'`,
            owner
          )
        )
      ).toBe(2);
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request("https://api.fidyapp.com/transactions/link", {
              method: "POST",
              headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
              body: JSON.stringify(pair),
            })
          )
        )).status
      ).toBe(401);
    })
  ));

it("corrects selected facts once, retains decisions and evidence, and rejects stale or foreign corrections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const methodFor = (path: string, body?: object): string => {
        if (body === undefined) return "GET";
        return path === "/transactions" ? "POST" : "PUT";
      };
      const send = (index: number, path: string, body?: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method: methodFor(path, body),
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
      const createdResponse = yield* fromTestPromise(() =>
        send(0, "/transactions", input({ counterparty: "Acme" }))
      );
      expect(createdResponse.status).toBe(201);
      const created = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => createdResponse.json())
      ).pipe(Effect.orDie)).data;
      const path = `/transactions/${created.id}`;
      const correction = {
        expectedRevision: 0,
        changes: { categoryId: "10000000-0000-4000-8000-000000000001", counterparty: null },
      };
      expect((yield* fromTestPromise(() => send(1, path, correction))).status).toBe(404);
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request(`https://api.fidyapp.com${path}`, {
              method: "PUT",
              headers: {
                origin: "https://app.fidyapp.com",
                authorization: `Bearer ${bearer(0)}`,
                "x-provider-id": users[0] ?? "",
                "content-type": "application/json",
              },
              body: JSON.stringify(correction),
            })
          )
        )).status
      ).toBe(401);
      expect(
        (yield* fromTestPromise(() => send(0, path, { expectedRevision: 0, changes: {} }))).status
      ).toBe(400);
      expect(
        (yield* fromTestPromise(() => send(0, "/transactions/not-a-transaction-id", correction)))
          .status
      ).toBe(404);
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ? AND operation = 'transactions.updateTransaction' AND outcome = 'not_found'"
            )
            .bind(users[0] ?? "")
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
      const changed = yield* fromTestPromise(() => send(0, path, correction));
      expect(changed.status).toBe(200);
      const result = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => changed.json())
      ).pipe(Effect.orDie)).data;
      expect(result.id).toBe(created.id);
      expect(result.revision).toBe(1);
      expect(result.money).toEqual(created.money);
      expect(Option.isNone(result.counterparty)).toBe(true);
      expect(result.categoryId).toBe(correction.changes.categoryId);
      expect((yield* fromTestPromise(() => send(0, path, correction))).status).toBe(400);
      const fetched = yield* fromTestPromise(() => send(0, path));
      expect(fetched.status).toBe(200);
      const stored = yield* fromTestPromise(() =>
        db
          .prepare("SELECT revision, user_decisions FROM transactions WHERE id = ?")
          .bind(created.id)
          .first<{ revision: number; user_decisions: string }>()
      );
      expect(stored?.revision).toBe(1);
      expect(
        yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean))
        )(stored?.user_decisions).pipe(Effect.orDie)
      ).toEqual({
        money: true,
        direction: true,
        occurredAt: true,
        categoryId: true,
        counterparty: true,
      });
      const evidence = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT before_facts, after_facts FROM transaction_corrections WHERE transaction_id = ?"
          )
          .bind(created.id)
          .first<{ before_facts: string; after_facts: string }>()
      );
      expect(evidence?.before_facts).toContain("Acme");
      expect(evidence?.after_facts).not.toContain("Acme");
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM source_attestations WHERE transaction_id = ?")
            .bind(created.id)
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
      yield* fromTestPromise(() =>
        expect(
          db.prepare("UPDATE transaction_corrections SET changed_fields = '[]'").run()
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(
          db
            .prepare("UPDATE transactions SET user_decisions = '{}' WHERE id = ?")
            .bind(created.id)
            .run()
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(
          db
            .prepare("UPDATE transactions SET category_id = ? WHERE id = ?")
            .bind(category, created.id)
            .run()
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(
          db
            .prepare(
              "UPDATE transactions SET category_id = ?, revision = revision + 1 WHERE id = ?"
            )
            .bind(category, created.id)
            .run()
        ).rejects.toThrow()
      );
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare("SELECT revision FROM transactions WHERE id = ?")
            .bind(created.id)
            .first<{ revision: number }>()
        ))?.revision
      ).toBe(1);
    })
  ));

it("serializes competing corrections and rolls back evidence when the correction audit refuses a write", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const send = (path: string, method: string, body?: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method,
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
      const created = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() =>
          send("/transactions", "POST", input()).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      const path = `/transactions/${created.id}`;
      const first = { expectedRevision: 0, changes: { notes: "first" } };
      yield* fromTestPromise(() =>
        db
          .prepare(`CREATE TRIGGER refuse_correction_audit BEFORE INSERT ON transaction_audit
      WHEN NEW.operation = 'transactions.updateTransaction' BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      expect((yield* fromTestPromise(() => send(path, "PUT", first))).status).not.toBe(200);
      const empty = yield* fromTestPromise(() =>
        db
          .prepare("SELECT revision FROM transactions WHERE id = ?")
          .bind(created.id)
          .first<{ revision: number }>()
      );
      expect(empty?.revision).toBe(0);
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM transaction_corrections")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
      yield* fromTestPromise(() => db.prepare("DROP TRIGGER refuse_correction_audit").run());
      const results = yield* fromTestPromise(() =>
        Promise.all([
          send(path, "PUT", first),
          send(path, "PUT", { expectedRevision: 0, changes: { notes: "second" } }),
        ])
      );
      expect(results.map(({ status }) => status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM transaction_corrections")
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
  ));

it("rolls back public Transaction capture when its audit silently refuses a write, then permits retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise({ try: () => setup(), catch: () => undefined });
      const post = (): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input()),
          })
        );
      yield* Effect.tryPromise({
        try: () =>
          db
            .prepare(`CREATE TRIGGER refuse_capture_audit BEFORE INSERT ON transaction_audit
    WHEN NEW.operation = 'transactions.createTransaction' BEGIN SELECT RAISE(IGNORE); END`)
            .run(),
        catch: () => undefined,
      });
      expect((yield* Effect.tryPromise({ try: post, catch: () => undefined })).status).not.toBe(
        201
      );
      const count = (
        table: "transactions" | "source_attestations"
      ): Effect.Effect<Option.Option<{ total: number }>, void> =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(`SELECT count(*) AS total FROM ${table} WHERE user_id = ?`)
              .bind(users[0])
              .first<{ total: number }>(),
          catch: () => undefined,
        }).pipe(Effect.map(Option.fromNullishOr));
      expect(Option.getOrUndefined(yield* count("transactions"))?.total).toBe(0);
      expect(Option.getOrUndefined(yield* count("source_attestations"))?.total).toBe(0);
      yield* Effect.tryPromise({
        try: () => db.prepare("DROP TRIGGER refuse_capture_audit").run(),
        catch: () => undefined,
      });
      expect((yield* Effect.tryPromise({ try: post, catch: () => undefined })).status).toBe(201);
      expect(Option.getOrUndefined(yield* count("transactions"))?.total).toBe(1);
    })
  ));

it("coordinates concurrent public mutations through a real per-User Durable Object binding", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup(true));
      const instance = instances.at(-1);
      if (instance === undefined) throw new Error("Missing Miniflare runtime");
      const namespace = yield* fromTestPromise(() =>
        instance.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR")
      );
      const coordinator = {
        getByName: (
          name: string
        ): Readonly<{ fetch: (command: Request) => Promise<Response> }> => ({
          fetch: (command: Request): Promise<Response> =>
            command.text().then((body) =>
              namespace
                .getByName(name)
                .fetch(command.url, {
                  method: command.method,
                  headers: Object.fromEntries(command.headers),
                  body,
                })
                .then(replayResponse)
            ),
        }),
      };
      const post = (index: number): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input()),
          }),
          coordinator
        );
      const results = yield* fromTestPromise(() => Promise.all([post(0), post(0), post(1)]));
      expect(results.map(({ status }) => status)).toEqual([201, 201, 201]);
      const transactions = results.map((response) => response.json());
      const [first, second, other] = yield* fromTestPromise(() => Promise.all(transactions));
      const created = [first, second, other].map(
        (value) => Schema.decodeUnknownSync(Created)(value).data
      );
      expect(new Set(created.map(({ id }) => id)).size).toBe(3);
      const browse = (index: number, path = "/transactions"): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              authorization: `Bearer ${bearer(index)}`,
              "x-provider-id": users[1 - index] ?? "untrusted",
            },
          }),
          coordinator
        );
      const ownerListResponse = yield* fromTestPromise(() => browse(0));
      const owner = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => ownerListResponse.json())
      ).pipe(Effect.orDie)).data;
      const neighborListResponse = yield* fromTestPromise(() => browse(1));
      const neighbor = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => neighborListResponse.json())
      ).pipe(Effect.orDie)).data;
      expect(new Set(owner.map(({ id }) => id))).toEqual(
        new Set(created.slice(0, 2).map(({ id }) => id))
      );
      expect(neighbor).toEqual([created[2]]);
      const protectedTransaction = created[0];
      if (protectedTransaction === undefined) throw new Error("Missing owner capture");
      expect(
        (yield* fromTestPromise(() => browse(1, `/transactions/${protectedTransaction.id}`))).status
      ).toBe(404);
      const attemptedDeletion = sendPublicRequest(
        db,
        new Request(`https://api.fidyapp.com/transactions/${protectedTransaction.id}`, {
          method: "DELETE",
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: `__Host-fidy_session=${bearer(1)}`,
            authorization: `Bearer ${bearer(1)}`,
            "x-provider-id": users[0] ?? "",
          },
        }),
        coordinator
      );
      const [createdAgain, deleted] = yield* fromTestPromise(() =>
        Promise.all([post(0), attemptedDeletion])
      );
      expect(createdAgain.status).toBe(201);
      expect(deleted.status).not.toBe(200);
      const preservedListResponse = yield* fromTestPromise(() => browse(0));
      const preserved = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => preservedListResponse.json())
      ).pipe(Effect.orDie)).data;
      expect(preserved).toContainEqual(protectedTransaction);
      const evidence = yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM source_attestations WHERE transaction_id = ?")
          .bind(protectedTransaction.id)
          .first<{ count: number }>()
      );
      expect(evidence?.count).toBe(1);
    })
  ));

it("enforces the stable-User daily write budget atomically and preserves append-only evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      yield* fromTestPromise(() => seedDailyTransactions(db, 100));
      expect(
        (yield* fromTestPromise(() => sendPublicRequest(db, postTransaction(0, input())))).status
      ).toBe(429);
      const rows = yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?")
          .bind(users[0])
          .first<{ count: number }>()
      );
      expect(rows?.count).toBe(100);
      expect(
        (yield* fromTestPromise(() => sendPublicRequest(db, postTransaction(1, input())))).status
      ).toBe(201);
      const evidence = yield* fromTestPromise(() =>
        db.prepare("SELECT id FROM transaction_audit").first<{ id: string }>()
      );
      if (evidence === null) throw new Error("Missing audit");
      yield* fromTestPromise(() =>
        expect(
          db.prepare("DELETE FROM transaction_audit WHERE id = ?").bind(evidence.id).run()
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(db.prepare("DELETE FROM source_attestations").run()).rejects.toThrow()
      );
    })
  ));

it("bounds authenticated audit growth atomically per stable User at the public boundary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const current = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 256)
    INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT 'budget-seed-' || n, ?, ?, 'transactions.listTransactions', 'success', ? FROM seq`)
          .bind(users[0], sessions[0], current)
          .run()
      );
      const call = (index: number, path = "/transactions", body?: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
      expect((yield* fromTestPromise(() => call(0))).status).toBe(429);
      // The expensive history batch must not run once this User is admitted no further reads.
      const cheapDb: D1Database = {
        prepare: (sql) => db.prepare(sql),
        batch: () => Promise.reject(new Error("History batch must not run")),
        exec: (sql) => db.exec(sql),
        withSession: (constraint) => db.withSession(constraint),
        dump: () => db.dump(),
      };
      const cheapRefusal = yield* fromTestPromise(() =>
        sendPublicRequest(
          cheapDb,
          new Request("https://api.fidyapp.com/transactions", {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
            },
          })
        )
      );
      expect(cheapRefusal.status).toBe(429);
      expect((yield* fromTestPromise(() => call(0, "/transactions?unknown=1"))).status).toBe(429);
      expect((yield* fromTestPromise(() => call(0, "/transactions", input()))).status).toBe(429);
      expect((yield* fromTestPromise(() => call(1))).status).toBe(200);
      const audit = yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ?")
          .bind(users[0])
          .first<{ count: number }>()
      );
      const transactions = yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?")
          .bind(users[0])
          .first<{ count: number }>()
      );
      expect(audit?.count).toBe(256);
      expect(transactions?.count).toBe(0);
    })
  ));

it("rejects forged browser origins and malformed Money before any public mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const post = (origin: string, data: object): Request =>
        new Request("https://api.fidyapp.com/transactions", {
          method: "POST",
          headers: {
            origin,
            cookie: `__Host-fidy_session=${bearer(0)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(data),
        });
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(db, post("https://attacker.test", input()))
        )).status
      ).toBe(403);
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            post("https://app.fidyapp.com", input({ money: { amount: "1e4", currency: "COP" } }))
          )
        )).status
      ).toBe(400);
      const counts = yield* fromTestPromise(() =>
        Promise.all(
          ["transactions", "source_attestations", "transaction_audit"].map((table) =>
            db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
          )
        )
      );
      expect(counts.map((result) => result?.count)).toEqual([0, 0, 1]);
      const created = yield* fromTestPromise(() =>
        sendPublicRequest(db, post("https://app.fidyapp.com", input()))
      );
      expect(created.status).toBe(201);
      const transaction = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => created.json())
      ).pipe(Effect.orDie)).data;
      const browse = (index: number, path = "/transactions"): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
            },
          })
        );
      const ownerBrowseResponse = yield* fromTestPromise(() => browse(0));
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => ownerBrowseResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([transaction]);
      const neighborBrowseResponse = yield* fromTestPromise(() => browse(1));
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => neighborBrowseResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() => browse(1, `/transactions/${transaction.id}`))).status
      ).toBe(404);
      const tokenOnly = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com/transactions/${transaction.id}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              authorization: `Bearer ${bearer(0)}`,
              "x-provider-id": users[0] ?? "",
            },
          })
        )
      );
      expect(tokenOnly.status).toBe(401);
      const foreignWithBearer = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com/transactions/${transaction.id}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(1)}`,
              authorization: `Bearer ${bearer(0)}`,
              "x-provider-id": users[0] ?? "",
            },
          })
        )
      );
      expect(foreignWithBearer.status).toBe(404);
      expect((yield* fromTestPromise(() => browse(1, "/transactions/not-an-id"))).status).toBe(404);
      expect((yield* fromTestPromise(() => browse(0, "/transactions?unknown=1"))).status).toBe(400);
      const outcomes = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT outcome FROM transaction_audit WHERE user_id = ? AND operation = 'transactions.getTransaction'"
          )
          .bind(users[1])
          .all<{ outcome: string }>()
      );
      expect(outcomes.results.map(({ outcome }) => outcome)).toEqual([
        "not_found",
        "not_found",
        "not_found",
      ]);
      const invalidAudit = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT outcome FROM transaction_audit WHERE user_id = ? AND outcome = 'validation_failed'"
          )
          .bind(users[0])
          .first<{ outcome: string }>()
      );
      expect(invalidAudit?.outcome).toBe("validation_failed");
    })
  ));

it("continues the canonical history beyond its first bounded page without losing tied movements", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
      const previous = "2025-01-09T12:00:00.000Z";
      yield* fromTestPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 101)
    INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, notes, occurred_at, created_at)
    SELECT printf('00000000-0000-4000-8000-%012d', n), ?, '1', 'COP', 'outflow', ?, 'Pago literal', ?,
      CASE WHEN n = 101 THEN ? ELSE ? END FROM seq`)
          .bind(users[0], category, previous, previous, createdAt)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    VALUES (?, ?, '1', 'COP', 'inflow', ?, '2024-01-09T12:00:00.000Z', ?)`)
          .bind("00000000-0000-4000-8000-000000000999", users[0], category, previous)
          .run()
      );
      const subject = Option.getOrThrow(
        yield* fromTestPromise(() => transactionSession({ request: request(0), db }))
      );
      const first = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(0, "/transactions?direction=outflow"),
            subject,
            search: false,
            id: Option.none(),
          },
        })
      );
      const Page = Schema.Struct({
        data: Schema.Array(Schema.toCodecJson(Transaction)),
        next: Schema.Array(
          Schema.Struct({
            tool: Schema.String,
            hint: Schema.String,
            args: Schema.Struct({
              query: Schema.Struct({ cursor: Schema.String, direction: Schema.String }),
            }),
          })
        ),
      });
      const page = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => first.json())
      ).pipe(Effect.orDie);
      expect(page.data).toHaveLength(100);
      expect(page.next).toHaveLength(1);
      expect(page.next[0]?.tool).toBe("transactions.listTransactions");
      const cursor = page.next[0]?.args.query.cursor;
      if (cursor === undefined) throw new Error("Missing continuation");
      expect(page.next[0]?.args.query.direction).toBe("outflow");
      const second = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(
              0,
              `/transactions?direction=outflow&cursor=${encodeURIComponent(cursor)}`
            ),
            subject,
            search: false,
            id: Option.none(),
          },
        })
      );
      const remainder = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => second.json())
      ).pipe(Effect.orDie);
      expect(remainder.data).toHaveLength(1);
      expect(remainder.next).toEqual([]);
      expect(new Set([...page.data, ...remainder.data].map(({ id }) => id)).size).toBe(101);

      const search = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(0, "/transactions/search?q=Pago%20literal"),
            subject,
            id: Option.none(),
            search: true,
          },
        })
      );
      const SearchPage = Schema.Struct({
        data: Schema.Array(Schema.toCodecJson(Transaction)),
        next: Schema.Array(
          Schema.Struct({
            tool: Schema.String,
            args: Schema.Struct({
              query: Schema.Struct({ cursor: Schema.String, q: Schema.String }),
            }),
          })
        ),
      });
      const matches = yield* Schema.decodeUnknownEffect(SearchPage)(
        yield* fromTestPromise(() => search.json())
      );
      expect(matches.data).toHaveLength(100);
      expect(matches.next[0]?.tool).toBe("transactions.searchTransactions");
      expect(matches.next[0]?.args.query.q).toBe("Pago literal");
      const searchCursor = Option.getOrThrow(
        Option.fromUndefinedOr(matches.next[0]?.args.query.cursor)
      );
      const nextSearch = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(
              0,
              `/transactions/search?q=Pago%20literal&cursor=${encodeURIComponent(searchCursor)}`
            ),
            subject,
            id: Option.none(),
            search: true,
          },
        })
      );
      const lastPage = yield* Schema.decodeUnknownEffect(SearchPage)(
        yield* fromTestPromise(() => nextSearch.json())
      );
      expect(lastPage.data).toHaveLength(1);
      expect(lastPage.next).toEqual([]);
      expect(new Set([...matches.data, ...lastPage.data].map(({ id }) => id)).size).toBe(101);
    })
  ));

it("commits exact manual Money, immutable capture context, and audit before canonical browsing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input({ counterparty: "Acme" })))
      );
      if (Option.isNone(owner) || Option.isNone(parsed)) throw new Error("fixture invalid");
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(db, postTransaction(0, input({ counterparty: "Acme" })))
      );
      expect(response.status).toBe(201);
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(encodeMoneyAmount(created.data.money.amount)).toBe("9007199254740993.15");
      expect(Option.getOrNull(created.data.counterparty)).toBe("Acme");
      const listed = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(0),
            subject: owner.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => listed.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([created.data]);
      const evidence = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT kind, service_market, locale, time_zone, interpretation_revision FROM source_attestations WHERE user_id = ?"
          )
          .bind(users[0])
          .all()
      );
      expect(evidence.results).toEqual([
        {
          kind: "manual",
          service_market: "CO",
          locale: "es-CO",
          time_zone: "America/Bogota",
          interpretation_revision: "manual-v1",
        },
      ]);
      const audit = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation FROM transaction_audit WHERE user_id = ? ORDER BY occurred_at_ms"
          )
          .bind(users[0])
          .all()
      );
      expect(
        audit.results
          .map((row) => row.operation)
          .sort((first, second) => String(first).localeCompare(String(second)))
      ).toEqual(["transactions.createTransaction", "transactions.listTransactions"]);
    })
  ));

it("neither a foreign opaque id nor another session can observe a Transaction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const other = yield* fromTestPromise(() => transactionSession({ request: request(1), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input()))
      );
      const tokenOnly = new Request("https://core.internal/transactions", {
        headers: { authorization: `Bearer ${bearer(0)}`, "x-provider-id": users[0] ?? "" },
      });
      expect(
        Option.isNone(yield* fromTestPromise(() => transactionSession({ request: tokenOnly, db })))
      ).toBe(true);
      if (Option.isNone(owner) || Option.isNone(other) || Option.isNone(parsed)) {
        throw new Error("fixture invalid");
      }
      const ownerLookupResponse = yield* fromTestPromise(() =>
        sendPublicRequest(db, postTransaction(0, input()))
      );
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => ownerLookupResponse.json())
      ).pipe(Effect.orDie);

      const foreignLookupResponse = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(1),
            subject: other.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => foreignLookupResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() =>
          browseTransactions({
            db,
            selection: {
              request: request(1, `/transactions/${created.data.id}`),
              subject: other.value,
              search: false,
              id: Option.some(created.data.id),
            },
          })
        )).status
      ).toBe(404);
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(1, sessions[0])
          .run()
      );
      expect(
        Option.isNone(yield* fromTestPromise(() => transactionSession({ request: request(0), db })))
      ).toBe(true);
      expect(
        (yield* fromTestPromise(() => sendPublicRequest(db, postTransaction(0, input())))).status
      ).toBe(401);
      expect(
        (yield* fromTestPromise(() =>
          browseTransactions({
            db,
            selection: {
              request: request(0),
              subject: owner.value,
              search: false,
              id: Option.none(),
            },
          })
        )).status
      ).toBe(401);
      const otherSessionLookupResponse = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(1),
            subject: other.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => otherSessionLookupResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() =>
          db.prepare("SELECT COUNT(*) AS count FROM transactions").first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
  ));

it("serializes concurrent mutations for one User without mixing another User's records", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const first = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const second = yield* fromTestPromise(() => transactionSession({ request: request(1), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input()))
      );
      if (Option.isNone(first) || Option.isNone(second) || Option.isNone(parsed)) {
        throw new Error("fixture invalid");
      }
      const coordinatorA = new UserTransactionCoordinator(
        { id: { name: first.value.userId } },
        coordinatorEnvironment(db)
      );
      const coordinatorB = new UserTransactionCoordinator(
        { id: { name: second.value.userId } },
        coordinatorEnvironment(db)
      );
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(CreateTransactionInput))(
        parsed.value
      ).pipe(Effect.orDie);
      const command = (session: typeof first.value): Request =>
        new Request("https://coordinator.internal/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            _tag: "WebSessionWork",
            sessionId: session.id,
            userId: session.userId,
            digest: Array.from(session.digest),
            work: {
              _tag: "Call",
              operation: "transactions.createTransaction",
              input: { payload: encoded },
            },
          }),
        });
      const responses = yield* fromTestPromise(() =>
        Promise.all([
          coordinatorA.fetch(command(first.value)),
          coordinatorA.fetch(command(first.value)),
          coordinatorB.fetch(command(second.value)),
        ])
      );
      expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
      expect(
        (yield* fromTestPromise(() => coordinatorB.fetch(command(first.value)))).status
      ).not.toBe(201);
      const firstList = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(0),
            subject: first.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      const secondList = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(1),
            subject: second.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => firstList.json())
        ).pipe(Effect.orDie)).data
      ).toHaveLength(2);
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => secondList.json())
        ).pipe(Effect.orDie)).data
      ).toHaveLength(1);
    })
  ));

it("executes non-Memory work when hosted inference is unusable and refuses Memory work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const session = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input()))
      );
      if (Option.isNone(session) || Option.isNone(parsed)) throw new Error("fixture invalid");
      // The hosted-inference configuration cannot build a service; only Memory work may miss it.
      const coordinator = new UserTransactionCoordinator(
        { id: { name: session.value.userId } },
        {
          DB: db,
          AI: {
            run: (): Promise<Response> =>
              Promise.reject(new Error("the model check must fail first")),
          },
          HOSTED_AI_MODEL: "unsupported-model",
        }
      );
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(CreateTransactionInput))(
        parsed.value
      ).pipe(Effect.orDie);
      const command = (
        work: Readonly<{ _tag: "Call"; operation: string; input: unknown }>
      ): Request =>
        new Request("https://coordinator.internal/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            _tag: "WebSessionWork",
            sessionId: session.value.id,
            userId: session.value.userId,
            digest: Array.from(session.value.digest),
            work,
          }),
        });
      const captured = yield* fromTestPromise(() =>
        coordinator.fetch(
          command({
            _tag: "Call",
            operation: "transactions.createTransaction",
            input: { payload: encoded },
          })
        )
      );
      expect(captured.status).toBe(201);
      const remembered = yield* fromTestPromise(() =>
        coordinator.fetch(
          command({
            _tag: "Call",
            operation: "memory.remember",
            input: { payload: { text: "Sin inferencia" } },
          })
        )
      );
      expect(remembered.status).toBe(503);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?", users[0] ?? "")
        )
      ).toBe(0);
    })
  ));

it("records one rejected audit when an atomic capture hits its resource limit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input()))
      );
      if (Option.isNone(owner) || Option.isNone(parsed)) throw new Error("fixture invalid");
      const limitedDb: D1Database = {
        prepare: (sql) => db.prepare(sql),
        batch: () => Promise.reject(new Error("transaction_resource_limit")),
        exec: (sql) => db.exec(sql),
        withSession: (constraint) => db.withSession(constraint),
        dump: () => db.dump(),
      };
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(limitedDb, postTransaction(0, input()))
      );
      expect(response.status).toBe(429);
      const audit = yield* fromTestPromise(() =>
        db.prepare("SELECT outcome FROM transaction_audit WHERE user_id = ?").bind(users[0]).all()
      );
      expect(audit.results).toEqual([{ outcome: "resource_limit" }]);
      const transactions = yield* fromTestPromise(() =>
        db.prepare("SELECT COUNT(*) AS count FROM transactions").first<{ count: number }>()
      );
      expect(transactions?.count).toBe(0);
    })
  ));

it("rejects an unknown Category without retaining partial Transaction, attestation, or audit state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(
          request(0, "/transactions", input({ categoryId: "10000000-0000-4000-8000-000000009999" }))
        )
      );
      if (Option.isNone(owner) || Option.isNone(parsed)) {
        throw new Error("fixture invalid");
      }
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            postTransaction(0, input({ categoryId: "10000000-0000-4000-8000-000000009999" }))
          )
        )).status
      ).not.toBe(201);
      const counts = yield* fromTestPromise(() =>
        Promise.all(
          ["transactions", "source_attestations", "transaction_audit"].map((table) =>
            db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
          )
        )
      );
      expect(counts.map((result) => result?.count)).toEqual([0, 0, 1]);
    })
  ));

it("commits an ordered two-child batch in one D1 unit and agrees with immediate canonical reads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const counted = countingDb(db);
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          counted.db,
          batchRequest(0, [
            transactionCall(1, input({ counterparty: "Acme" })),
            transactionCall(
              2,
              input({
                counterparty: "Bravo",
                categoryId: "10000000-0000-4000-8000-000000000001",
              })
            ),
          ])
        )
      );
      expect(response.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(BatchResult)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(body.data.results.map(({ callId }) => callId)).toEqual([
        batchCallId(1),
        batchCallId(2),
      ]);
      expect(body.data.results.map(({ operation }) => operation)).toEqual([
        "transactions.createTransaction",
        "transactions.createTransaction",
      ]);
      const [first, second] = body.data.results.map(({ output }) => output.data);
      if (first === undefined || second === undefined) throw new Error("Missing results");
      expect(Option.getOrNull(first.counterparty)).toBe("Acme");
      expect(Option.getOrNull(second.counterparty)).toBe("Bravo");
      expect([first.revision, second.revision]).toEqual([0, 0]);
      expect(counted.batches()).toBe(1);

      const session = Option.getOrThrow(
        yield* fromTestPromise(() => transactionSession({ request: request(0), db }))
      );
      const listed = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: { request: request(0), subject: session, search: false, id: Option.none() },
        })
      );
      const page = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => listed.json())
      ).pipe(Effect.orDie);
      expect(new Set(page.data.map(({ id }) => id))).toEqual(new Set([first.id, second.id]));
      expect(page.data.find(({ id }) => id === first.id)).toEqual(first);
      expect(page.data.find(({ id }) => id === second.id)).toEqual(second);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(2);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ? AND outcome = 'success' AND operation = 'transactions.createTransaction'",
            users[0] ?? ""
          )
        )
      ).toBe(2);
    })
  ));

it("rolls back an earlier child when a later child's revision is stale", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000001";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, seededId, {
              expectedRevision: 1,
              changes: { notes: "late" },
            }),
          ])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM source_attestations")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_corrections")
        )
      ).toBe(0);
      const audits = yield* fromTestPromise(() => auditedOperations(db, users[0] ?? ""));
      expect(audits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
      ]);
    })
  ));

it("aborts the D1 unit and attributes the child when a guarded correction changes no row", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000002";
      const evidenceId = "30000000-0000-4000-8000-000000000012";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          racingBatch(db, () =>
            concurrentCorrection({
              db,
              userId: users[0] ?? "",
              transactionId: seededId,
              evidenceId,
            })
          ),
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, seededId, {
              expectedRevision: 0,
              changes: { notes: "batch" },
            }),
          ])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      // The earlier capture must not survive a guard that aborts at commit time, not after it.
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM source_attestations")
        )
      ).toBe(0);
      const evidence = yield* fromTestPromise(() =>
        db.prepare("SELECT id FROM transaction_corrections").all<{ id: string }>()
      );
      expect(evidence.results).toEqual([{ id: evidenceId }]);
      const audits = yield* fromTestPromise(() => auditedOperations(db, users[0] ?? ""));
      expect(audits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
      ]);
    })
  ));

it("rolls back earlier children and every success Audit when a child audit is silently refused", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000003";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`CREATE TRIGGER refuse_batch_correction_audit BEFORE INSERT ON transaction_audit
            WHEN NEW.operation = 'transactions.updateTransaction' BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, seededId, {
              expectedRevision: 0,
              changes: { notes: "refused audit" },
            }),
          ])
        )
      );
      expect(response.status).toBe(503);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM source_attestations")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_corrections")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("rejects a duplicate call identity before any child commits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const duplicate = transactionCall(1, input());
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [duplicate, transactionCall(1, input({ counterparty: "Dup" }))])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("fails closed on a canonical mutation without a batch adapter", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            {
              callId: batchCallId(2),
              operation: "transactions.deleteTransaction",
              input: { params: { id: "30000000-0000-4000-8000-000000000009" } },
            },
          ])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("unavailable");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.deleteTransaction");
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("links and unlinks pair children inside one atomic batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const visible = "30000000-0000-4000-8000-000000000901";
      const suppressed = "30000000-0000-4000-8000-000000000902";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({ db, userId: owner, id: visible, categoryId: category }),
          seedRetainedTransaction({
            db,
            userId: owner,
            id: suppressed,
            categoryId: category,
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
          seedManualAttestation({
            db,
            userId: owner,
            transactionId: suppressed,
            id: "30000000-0000-4000-8000-000000000903",
          }),
        ])
      );
      const linked = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [transactionCall(1, input()), linkCall(2, suppressed, visible)])
        )
      );
      expect(linked.status).toBe(200);
      const linkBody = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => linked.json())
      ).pipe(Effect.orDie);
      expect(linkBody.data.results.map(({ operation }) => operation)).toEqual([
        "transactions.createTransaction",
        "transactions.linkTransactions",
      ]);
      const effectiveTransaction = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        linkBody.data.results[1]?.output
      ).pipe(Effect.orDie)).data;
      expect(effectiveTransaction.id).toBe(visible);
      expect(effectiveTransaction.presentation).toEqual({ kind: "visible-member" });
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [
          { first: visible, second: suppressed, state: "linked", visible: Option.some(visible) },
        ],
        members: [{ transaction: visible }, { transaction: suppressed }],
      });

      const unlinked = yield* fromTestPromise(() =>
        sendPublicRequest(db, batchRequest(0, [unlinkCall(3, suppressed, visible)]))
      );
      expect(unlinked.status).toBe(200);
      const unlinkBody = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => unlinked.json())
      ).pipe(Effect.orDie);
      expect(unlinkBody.data.results.map(({ operation }) => operation)).toEqual([
        "transactions.unlinkTransactions",
      ]);
      const restored = (yield* Schema.decodeUnknownEffect(RestoredPair)(
        unlinkBody.data.results[0]?.output
      ).pipe(Effect.orDie)).data;
      expect(restored.firstTransaction.id).toBe(visible);
      expect(restored.secondTransaction.id).toBe(suppressed);
      expect(restored.firstTransaction.presentation).toEqual({ kind: "independent" });
      expect(restored.secondTransaction.presentation).toEqual({ kind: "independent" });
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [
          {
            first: visible,
            second: suppressed,
            state: "keep-separate",
            visible: Option.none(),
          },
        ],
        members: [],
      });
      expect(
        (yield* fromTestPromise(() => auditedOperations(db, owner)))
          .map(({ operation, outcome }) => `${operation}:${outcome}`)
          .sort()
      ).toEqual([
        "transactions.createTransaction:success",
        "transactions.linkTransactions:success",
        "transactions.unlinkTransactions:success",
      ]);
    })
  ));

it("aborts a batch link when a competing link commits before the unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000911";
      const second = "30000000-0000-4000-8000-000000000912";
      const third = "30000000-0000-4000-8000-000000000913";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({ db, userId: owner, id: first, categoryId: category }),
          seedRetainedTransaction({ db, userId: owner, id: second, categoryId: category }),
          seedRetainedTransaction({ db, userId: owner, id: third, categoryId: category }),
        ])
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          racingBatch(db, () =>
            seedLinkedPair({ db, userId: owner, first, second: third, visible: first })
          ),
          batchRequest(0, [linkCall(1, first, second)])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(rejection.error.operation).toBe("transactions.linkTransactions");
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [{ first, second: third, state: "linked", visible: Option.some(first) }],
        members: [{ transaction: first }, { transaction: third }],
      });
      expect(yield* fromTestPromise(() => auditedOperations(db, owner))).toEqual([
        { operation: "transactions.linkTransactions", outcome: "validation_failed" },
      ]);
    })
  ));

it("aborts a batch link when a correction changes a member's Money before the unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000914";
      const second = "30000000-0000-4000-8000-000000000915";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({ db, userId: owner, id: first, categoryId: category }),
          seedRetainedTransaction({ db, userId: owner, id: second, categoryId: category }),
        ])
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          racingBatch(db, () =>
            concurrentMoneyCorrection({
              db,
              userId: owner,
              transactionId: second,
              evidenceId: "30000000-0000-4000-8000-000000000916",
              amount: "45000.01",
            })
          ),
          batchRequest(0, [linkCall(1, first, second)])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(rejection.error.operation).toBe("transactions.linkTransactions");
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [],
        members: [],
      });
      expect(yield* fromTestPromise(() => auditedOperations(db, owner))).toEqual([
        { operation: "transactions.linkTransactions", outcome: "validation_failed" },
      ]);
    })
  ));

it("attributes the earliest provable child when a pair premise and a revision both move", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000931";
      const second = "30000000-0000-4000-8000-000000000932";
      const third = "30000000-0000-4000-8000-000000000933";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({ db, userId: owner, id: first, categoryId: category }),
          seedRetainedTransaction({ db, userId: owner, id: second, categoryId: category }),
          seedRetainedTransaction({ db, userId: owner, id: third, categoryId: category }),
        ])
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          racingBatch(db, () =>
            Promise.all([
              seedLinkedPair({ db, userId: owner, first, second, visible: first }),
              concurrentCorrection({
                db,
                userId: owner,
                transactionId: third,
                evidenceId: "30000000-0000-4000-8000-000000000934",
              }),
            ])
          ),
          batchRequest(0, [
            linkCall(1, first, second),
            correctionCall(2, third, { expectedRevision: 0, changes: { notes: "late" } }),
          ])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(rejection.error.operation).toBe("transactions.linkTransactions");
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [{ first, second, state: "linked", visible: Option.some(first) }],
        members: [{ transaction: first }, { transaction: second }],
      });
      expect(yield* fromTestPromise(() => auditedOperations(db, owner))).toEqual([
        { operation: "transactions.linkTransactions", outcome: "validation_failed" },
      ]);
    })
  ));

it("aborts a batch unlink when a competing unlink commits before the unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000921";
      const second = "30000000-0000-4000-8000-000000000922";
      yield* fromTestPromise(() =>
        Promise.all([
          seedRetainedTransaction({ db, userId: owner, id: first, categoryId: category }),
          seedRetainedTransaction({
            db,
            userId: owner,
            id: second,
            categoryId: category,
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
          seedLinkedPair({ db, userId: owner, first, second, visible: first }),
        ])
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          racingBatch(db, () =>
            db.batch([
              db
                .prepare(`UPDATE transaction_reconciliation_decisions
                  SET state = 'keep-separate', visible_transaction_id = NULL
                  WHERE user_id = ? AND first_transaction_id = ? AND second_transaction_id = ?`)
                .bind(owner, first, second),
              db
                .prepare(`DELETE FROM transaction_reconciliation_members
                  WHERE user_id = ? AND first_transaction_id = ? AND second_transaction_id = ?`)
                .bind(owner, first, second),
            ])
          ),
          batchRequest(0, [unlinkCall(1, second, first)])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(rejection.error.operation).toBe("transactions.unlinkTransactions");
      expect(yield* fromTestPromise(() => reconciliationState(db, owner))).toEqual({
        decisions: [{ first, second, state: "keep-separate", visible: Option.none() }],
        members: [],
      });
      expect(yield* fromTestPromise(() => auditedOperations(db, owner))).toEqual([
        { operation: "transactions.unlinkTransactions", outcome: "validation_failed" },
      ]);
    })
  ));

it("gives a stale correction the same refusal Audit alone and inside a batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const firstId = "30000000-0000-4000-8000-000000000004";
      const secondId = "30000000-0000-4000-8000-000000000005";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: firstId, categoryId: category })
      );
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: secondId, categoryId: category })
      );
      const individual = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com/transactions/${firstId}`, {
            method: "PUT",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ expectedRevision: 1, changes: { notes: "alone" } }),
          })
        )
      );
      expect(individual.status).toBe(400);
      const batch = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, secondId, { expectedRevision: 1, changes: { notes: "batched" } }),
          ])
        )
      );
      expect(batch.status).toBe(400);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(2);
      const audits = yield* fromTestPromise(() => auditedOperations(db, users[0] ?? ""));
      expect(audits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
      ]);
    })
  ));

it("enforces each child's live PAT scope and commits a mixed two-child batch under one PAT unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000006";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const current = yield* Clock.currentTimeMillis;
      const writeToken = `fin_${"w".repeat(8)}_${"a".repeat(43)}`;
      const readToken = `fin_${"r".repeat(8)}_${"b".repeat(43)}`;
      yield* seedPAT({ db, userId: users[0] ?? "", token: writeToken, scopes: ["write"], current });
      yield* seedPAT({ db, userId: users[0] ?? "", token: readToken, scopes: ["read"], current });
      const refused = yield* fromTestPromise(() =>
        sendPublicRequest(db, bearerRequest(0, readToken, [transactionCall(1, input())]))
      );
      expect(refused.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => refused.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("scope_missing");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM pat_audit WHERE outcome = 'accepted'")
        )
      ).toBe(0);

      const committed = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          bearerRequest(0, writeToken, [
            transactionCall(1, input({ counterparty: "Agent capture" })),
            correctionCall(2, seededId, { expectedRevision: 0, changes: { notes: "agent" } }),
          ])
        )
      );
      expect(committed.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(BatchResult)(
        yield* fromTestPromise(() => committed.json())
      ).pipe(Effect.orDie);
      expect(body.data.results).toHaveLength(2);
      const audits = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM pat_audit WHERE operation LIKE 'transactions.%' ORDER BY operation"
          )
          .all<{ operation: string; outcome: string }>()
      );
      expect(audits.results).toEqual([
        { operation: "transactions.createTransaction", outcome: "accepted" },
        { operation: "transactions.updateTransaction", outcome: "accepted" },
      ]);
      const activity = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ last_used_at_ms: Schema.Int })
      )(
        yield* fromTestPromise(() =>
          db
            .prepare("SELECT last_used_at_ms FROM pats WHERE short_id = ?")
            .bind(writeToken.slice(4, 12))
            .first()
        )
      ).pipe(Effect.orDie);
      expect(activity.last_used_at_ms).toBeGreaterThan(0);
    })
  ));

it("commits a mixed-owner canonical batch once with ordered correlated results and immediate reads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input({ counterparty: "Mixed owner" })),
            memoryCall(2, "Prefiere pagar en efectivo"),
            keywordRuleCall(3, "Panadería", category),
          ])
        )
      );
      expect(response.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(body.data.results.map(({ callId, operation }) => [callId, operation])).toEqual([
        [batchCallId(1), "transactions.createTransaction"],
        [batchCallId(2), "memory.remember"],
        [batchCallId(3), "categories.createKeywordRule"],
      ]);
      const send = (index: number, path: string): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
            },
          })
        );
      const transactions = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => send(0, "/transactions").then((value) => value.json()))
      ).pipe(Effect.orDie);
      expect(transactions.data).toHaveLength(1);
      expect(Option.getOrNull(transactions.data[0]?.counterparty ?? Option.none())).toBe(
        "Mixed owner"
      );
      const memories = yield* Schema.decodeUnknownEffect(ListedMemories)(
        yield* fromTestPromise(() => send(0, "/memories").then((value) => value.json()))
      ).pipe(Effect.orDie);
      expect(memories.data.map(({ text }) => text)).toEqual(["Prefiere pagar en efectivo"]);
      const rules = yield* Schema.decodeUnknownEffect(ListedKeywordRules)(
        yield* fromTestPromise(() =>
          send(0, "/category-keyword-rules").then((value) => value.json())
        )
      ).pipe(Effect.orDie);
      expect(rules.data.map(({ keyword }) => keyword)).toEqual(["Panadería"]);
      // Every owner's success AuditLogEntry committed once, together with its owner write.
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ? AND operation = 'transactions.createTransaction' AND outcome = 'success'",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM memory_audit WHERE user_id = ? AND operation = 'memory.remember' AND outcome = 'success'",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM category_audit WHERE user_id = ? AND operation = 'categories.createKeywordRule'",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      // No child state leaked to another User.
      const neighborTransactions = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => send(1, "/transactions").then((value) => value.json()))
      ).pipe(Effect.orDie);
      expect(neighborTransactions.data).toEqual([]);
      const neighborMemories = yield* Schema.decodeUnknownEffect(ListedMemories)(
        yield* fromTestPromise(() => send(1, "/memories").then((value) => value.json()))
      ).pipe(Effect.orDie);
      expect(neighborMemories.data).toEqual([]);
      const neighborRules = yield* Schema.decodeUnknownEffect(ListedKeywordRules)(
        yield* fromTestPromise(() =>
          send(1, "/category-keyword-rules").then((value) => value.json())
        )
      ).pipe(Effect.orDie);
      expect(neighborRules.data).toEqual([]);
    })
  ));

it("rolls back every owner when a later mixed-owner keyword-rule child exceeds capacity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const current = DateTime.formatIso(DateTime.nowUnsafe());
      yield* fromTestPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 99)
            INSERT INTO keyword_rules (id, user_id, keyword, normalized_keyword, category_id, created_at, updated_at)
            SELECT printf('90000000-0000-4000-8000-%012d', n), ?, 'seed ' || n, 'seed ' || n, ?, ?, ? FROM seq`)
          .bind(users[0] ?? "", category, current, current)
          .run()
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            memoryCall(2, "Sobrevive al rollback"),
            keywordRuleCall(3, "Panadería", category),
            keywordRuleCall(4, "Cafetería", category),
          ])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(3);
      expect(rejection.error.operation).toBe("categories.createKeywordRule");
      // The late trigger rolls back every earlier owner write and every owner success Audit.
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?", users[0] ?? "")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(99);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM memory_audit"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM category_audit"))
      ).toBe(0);
    })
  ));

it("attributes a cross-owner Memory conflict at commit time and keeps no earlier child state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const memoryId = "50000000-0000-4000-8000-000000000001";
      const current = DateTime.formatIso(DateTime.nowUnsafe());
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO memories (id, user_id, text, created_at, updated_at) VALUES (?, ?, 'Original', ?, ?)"
          )
          .bind(memoryId, users[0] ?? "", current, current)
          .run()
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          racingBatch(db, () =>
            db
              .prepare("DELETE FROM memories WHERE user_id = ? AND id = ?")
              .bind(users[0] ?? "", memoryId)
              .run()
          ),
          batchRequest(0, [transactionCall(1, input()), reviseMemoryCall(2, memoryId, "Revisado")])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("not_found");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("memory.revise");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?", users[0] ?? "")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
      const audits = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM memory_audit WHERE user_id = ? ORDER BY operation"
          )
          .bind(users[0] ?? "")
          .all<{ operation: string; outcome: string }>()
      );
      expect(audits.results).toEqual([{ operation: "memory.revise", outcome: "not_found" }]);
    })
  ));

it("executes a mixed-owner batch under one write PAT and refuses a read PAT without writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const current = yield* Clock.currentTimeMillis;
      const writeToken = `fin_${"m".repeat(8)}_${"c".repeat(43)}`;
      const readToken = `fin_${"n".repeat(8)}_${"d".repeat(43)}`;
      yield* seedPAT({
        db,
        userId: users[0] ?? "",
        token: writeToken,
        scopes: ["write"],
        current,
      });
      yield* seedPAT({ db, userId: users[0] ?? "", token: readToken, scopes: ["read"], current });
      const refused = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          bearerRequest(0, readToken, [
            memoryCall(1, "Memoria"),
            keywordRuleCall(2, "Panadería", category),
          ])
        )
      );
      expect(refused.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => refused.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("scope_missing");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?", users[0] ?? "")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM pat_audit WHERE outcome = 'accepted'")
        )
      ).toBe(0);

      const committed = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          bearerRequest(0, writeToken, [
            transactionCall(1, input({ counterparty: "Mixed agent" })),
            memoryCall(2, "Prefiere pagar en efectivo"),
            keywordRuleCall(3, "Panadería", category),
          ])
        )
      );
      expect(committed.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => committed.json())
      ).pipe(Effect.orDie);
      expect(body.data.results.map(({ operation }) => operation)).toEqual([
        "transactions.createTransaction",
        "memory.remember",
        "categories.createKeywordRule",
      ]);
      const audits = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM pat_audit WHERE outcome = 'accepted' ORDER BY operation"
          )
          .all<{ operation: string; outcome: string }>()
      );
      expect(audits.results).toEqual([
        { operation: "categories.createKeywordRule", outcome: "accepted" },
        { operation: "memory.remember", outcome: "accepted" },
        { operation: "transactions.createTransaction", outcome: "accepted" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?", users[0] ?? "")
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
    })
  ));

it("rejects a duplicate call identity named across owners before any child commits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [transactionCall(6, input()), memoryCall(6, "Identidad repetida")])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("memory.remember");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?", users[0] ?? "")
        )
      ).toBe(0);
    })
  ));

it("refuses two children addressing one retained rule or Memory before any child commits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const current = DateTime.formatIso(DateTime.nowUnsafe());
      const ruleId = "70000000-0000-4000-8000-000000000001";
      const memoryId = "70000000-0000-4000-8000-000000000002";
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO keyword_rules (id, user_id, keyword, normalized_keyword, category_id, created_at, updated_at)
            VALUES (?, ?, 'Original', 'original', ?, ?, ?)`)
          .bind(ruleId, users[0] ?? "", category, current, current)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO memories (id, user_id, text, created_at, updated_at) VALUES (?, ?, 'Repetida', ?, ?)"
          )
          .bind(memoryId, users[0] ?? "", current, current)
          .run()
      );
      const repeatedRule = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            updateKeywordRuleCall(1, ruleId, { keyword: "Una", categoryId: category }),
            deleteKeywordRuleCall(2, ruleId),
          ])
        )
      );
      expect(repeatedRule.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => repeatedRule.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("categories.deleteKeywordRule");
      const repeatedMemory = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            reviseMemoryCall(1, memoryId, "Corregida"),
            forgetMemoryCall(2, memoryId),
          ])
        )
      );
      expect(repeatedMemory.status).toBe(400);
      const rule = yield* fromTestPromise(() =>
        db
          .prepare("SELECT keyword FROM keyword_rules WHERE id = ?")
          .bind(ruleId)
          .first<{ keyword: string }>()
      );
      expect(rule).toEqual({ keyword: "Original" });
      const memory = yield* fromTestPromise(() =>
        db
          .prepare("SELECT text FROM memories WHERE id = ?")
          .bind(memoryId)
          .first<{ text: string }>()
      );
      expect(memory).toEqual({ text: "Repetida" });
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM category_audit"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM memory_audit"))
      ).toBe(0);
    })
  ));

it("commits retained keyword-rule updates and deletes and Memory forgets in one mixed-owner batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const current = DateTime.formatIso(DateTime.nowUnsafe());
      const updatedRuleId = "60000000-0000-4000-8000-000000000001";
      const deletedRuleId = "60000000-0000-4000-8000-000000000002";
      const forgottenMemoryId = "60000000-0000-4000-8000-000000000003";
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO keyword_rules (id, user_id, keyword, normalized_keyword, category_id, created_at, updated_at)
            VALUES (?, ?, 'Antes', 'antes', ?, ?, ?), (?, ?, 'Borrar', 'borrar', ?, ?, ?)`)
          .bind(
            updatedRuleId,
            users[0] ?? "",
            category,
            current,
            current,
            deletedRuleId,
            users[0] ?? "",
            category,
            current,
            current
          )
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO memories (id, user_id, text, created_at, updated_at) VALUES (?, ?, 'Olvidar', ?, ?)"
          )
          .bind(forgottenMemoryId, users[0] ?? "", current, current)
          .run()
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            updateKeywordRuleCall(1, updatedRuleId, { keyword: "Después", categoryId: category }),
            deleteKeywordRuleCall(2, deletedRuleId),
            forgetMemoryCall(3, forgottenMemoryId),
            transactionCall(4, input({ counterparty: "Mixed retained" })),
          ])
        )
      );
      expect(response.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(body.data.results.map(({ operation }) => operation)).toEqual([
        "categories.updateKeywordRule",
        "categories.deleteKeywordRule",
        "memory.forget",
        "transactions.createTransaction",
      ]);
      const rules = yield* fromTestPromise(() =>
        db
          .prepare("SELECT id, keyword FROM keyword_rules WHERE user_id = ? ORDER BY id")
          .bind(users[0] ?? "")
          .all<{ id: string; keyword: string }>()
      );
      expect(rules.results).toEqual([{ id: updatedRuleId, keyword: "Después" }]);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?", users[0] ?? "")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      const categoryAudits = yield* fromTestPromise(() =>
        db
          .prepare("SELECT operation FROM category_audit WHERE user_id = ? ORDER BY operation")
          .bind(users[0] ?? "")
          .all<{ operation: string }>()
      );
      expect(categoryAudits.results).toEqual([
        { operation: "categories.deleteKeywordRule" },
        { operation: "categories.updateKeywordRule" },
      ]);
      const memoryAudits = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM memory_audit WHERE user_id = ? ORDER BY operation"
          )
          .bind(users[0] ?? "")
          .all<{ operation: string; outcome: string }>()
      );
      expect(memoryAudits.results).toEqual([{ operation: "memory.forget", outcome: "success" }]);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ? AND operation = 'transactions.createTransaction' AND outcome = 'success'",
            users[0] ?? ""
          )
        )
      ).toBe(1);
    })
  ));

it("fails closed on a cross-owner dependency defect without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const keywordDb = yield* fromTestPromise(() => setup());
      const current = DateTime.formatIso(DateTime.nowUnsafe());
      yield* fromTestPromise(() =>
        keywordDb
          .prepare(`INSERT INTO keyword_rules (id, user_id, keyword, normalized_keyword, category_id, created_at, updated_at)
            VALUES ('corrupt-rule', ?, 'corrupt', 'corrupt', ?, ?, ?)`)
          .bind(users[0] ?? "", category, current, current)
          .run()
      );
      const keywordResponse = yield* fromTestPromise(() =>
        sendPublicRequest(
          keywordDb,
          batchRequest(0, [transactionCall(1, input()), keywordRuleCall(2, "Panadería", category)])
        )
      );
      expect(keywordResponse.status).toBe(503);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            keywordDb,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(keywordDb, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            keywordDb,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);

      const memoryDb = yield* fromTestPromise(() => setup());
      yield* fromTestPromise(() =>
        memoryDb
          .prepare(
            "INSERT INTO memories (id, user_id, text, created_at, updated_at) VALUES ('corrupt-memory', ?, 'Corrupt', ?, ?)"
          )
          .bind(users[0] ?? "", current, current)
          .run()
      );
      const memoryResponse = yield* fromTestPromise(() =>
        sendPublicRequest(
          memoryDb,
          batchRequest(0, [transactionCall(1, input()), memoryCall(2, "Nueva")])
        )
      );
      expect(memoryResponse.status).toBe(503);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            memoryDb,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(memoryDb, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            memoryDb,
            "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
    })
  ));

it("serializes concurrent batches and individual mutations through one User coordination turn", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup(true));
      const instance = instances.at(-1);
      if (instance === undefined) throw new Error("Missing Miniflare runtime");
      const namespace = yield* fromTestPromise(() =>
        instance.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR")
      );
      const coordinator = {
        getByName: (
          name: string
        ): Readonly<{ fetch: (command: Request) => Promise<Response> }> => ({
          fetch: (command: Request): Promise<Response> =>
            command.text().then((body) =>
              namespace
                .getByName(name)
                .fetch(command.url, {
                  method: command.method,
                  headers: Object.fromEntries(command.headers),
                  body,
                })
                .then(replayResponse)
            ),
        }),
      };
      const individual = (index: number): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input({ counterparty: "Single" })),
          }),
          coordinator
        );
      const batch = (index: number, suffix: number): Promise<Response> =>
        sendPublicRequest(
          db,
          batchRequest(index, [
            transactionCall(suffix, input({ counterparty: `Batch ${suffix}` })),
            transactionCall(suffix + 1, input({ counterparty: `Batch ${suffix + 1}` })),
          ]),
          coordinator
        );
      const responses = yield* fromTestPromise(() =>
        Promise.all([individual(0), batch(0, 10), batch(0, 20), individual(1)])
      );
      expect(responses.map(({ status }) => status)).toEqual([201, 200, 200, 201]);
      const ownerList = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions", {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
            },
          }),
          coordinator
        )
      );
      const owner = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => ownerList.json())
      ).pipe(Effect.orDie);
      expect(owner.data).toHaveLength(5);
      expect(new Set(owner.data.map(({ id }) => id)).size).toBe(5);
      const neighborList = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions", {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(1)}`,
            },
          }),
          coordinator
        )
      );
      const neighbor = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => neighborList.json())
      ).pipe(Effect.orDie);
      expect(neighbor.data).toHaveLength(1);
    })
  ));

it("attributes the movement budget but leaves an ambiguous audit budget abort unattributed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const movementDb = yield* fromTestPromise(() => setup());
      yield* fromTestPromise(() => seedDailyTransactions(movementDb, 99));
      const limited = yield* fromTestPromise(() =>
        sendPublicRequest(
          movementDb,
          batchRequest(0, [transactionCall(1, input()), transactionCall(2, input())])
        )
      );
      expect(limited.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => limited.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("rate_limited");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.createTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            movementDb,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(99);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            movementDb,
            "SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ? AND outcome = 'resource_limit'",
            users[0] ?? ""
          )
        )
      ).toBe(1);

      const auditDb = yield* fromTestPromise(() => setup());
      const current = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        auditDb
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 254)
    INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT 'budget-seed-' || n, ?, ?, 'transactions.listTransactions', 'success', ? FROM seq`)
          .bind(users[0], sessions[0], current)
          .run()
      );
      const exhausted = yield* fromTestPromise(() =>
        sendPublicRequest(
          auditDb,
          batchRequest(0, [transactionCall(1, input()), transactionCall(2, input())])
        )
      );
      // Another unit can commit an audit row between the aborted batch and any recount, so
      // neither of the two children can safely be named as the refused audit writer.
      expect(exhausted.status).toBe(503);
      expect(
        yield* fromTestPromise(() =>
          countRows(auditDb, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(auditDb, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(255);
    })
  ));

it("fails closed on a foreign Transaction or an unknown Category without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const neighborId = "30000000-0000-4000-8000-000000000007";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[1] ?? "", id: neighborId, categoryId: category })
      );
      const foreign = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, neighborId, { expectedRevision: 0, changes: { notes: "foreign" } }),
          ])
        )
      );
      expect(foreign.status).toBe(400);
      const foreignRejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => foreign.json())
      ).pipe(Effect.orDie);
      expect(foreignRejection.error.code).toBe("not_found");
      expect(foreignRejection.error.failedCallIndex).toBe(1);
      expect(foreignRejection.error.operation).toBe("transactions.updateTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      const neighborRows = yield* fromTestPromise(() =>
        db
          .prepare("SELECT notes, revision FROM transactions WHERE user_id = ?")
          .bind(users[1])
          .all<{ notes: string; revision: number }>()
      );
      expect(neighborRows.results).toEqual([{ notes: "seed", revision: 0 }]);

      const unrecognized = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            transactionCall(2, input({ categoryId: "10000000-0000-4000-8000-000000009999" })),
          ])
        )
      );
      expect(unrecognized.status).toBe(400);
      const unrecognizedRejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => unrecognized.json())
      ).pipe(Effect.orDie);
      expect(unrecognizedRejection.error.code).toBe("not_found");
      expect(unrecognizedRejection.error.failedCallIndex).toBe(1);
      expect(unrecognizedRejection.error.operation).toBe("transactions.createTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      const refusals = yield* fromTestPromise(() => auditedOperations(db, users[0] ?? ""));
      expect(refusals.map(({ outcome }) => outcome)).toEqual(["not_found", "not_found"]);
      expect(new Set(refusals.map(({ operation }) => operation)).size).toBe(2);
    })
  ));

it("maps a batch dependency defect to the closed unavailable failure without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const brokenDb: D1Database = {
        prepare: (sql) => db.prepare(sql),
        batch: () => Promise.reject(new Error("database defect")),
        exec: (sql) => db.exec(sql),
        withSession: (constraint) => db.withSession(constraint),
        dump: () => db.dump(),
      };
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          brokenDb,
          batchRequest(0, [transactionCall(1, input()), transactionCall(2, input())])
        )
      );
      expect(response.status).toBe(503);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("records a PAT refusal Audit for a refused batch child and attributes a PAT budget abort", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000008";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const current = yield* Clock.currentTimeMillis;
      const writeToken = `fin_${"t".repeat(8)}_${"c".repeat(43)}`;
      yield* seedPAT({ db, userId: users[0] ?? "", token: writeToken, scopes: ["write"], current });
      const refused = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          bearerRequest(0, writeToken, [
            transactionCall(1, input()),
            correctionCall(2, seededId, { expectedRevision: 9, changes: { notes: "stale" } }),
          ])
        )
      );
      expect(refused.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => refused.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      const refusals = yield* fromTestPromise(() => auditedPATOperations(db, users[0] ?? ""));
      expect(refusals).toEqual([
        { operation: "transactions.updateTransaction", outcome: "rejected" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);

      const budgetDb = yield* fromTestPromise(() => setup());
      yield* fromTestPromise(() => seedDailyTransactions(budgetDb, 99));
      const budgetToken = `fin_${"u".repeat(8)}_${"d".repeat(43)}`;
      yield* seedPAT({
        db: budgetDb,
        userId: users[0] ?? "",
        token: budgetToken,
        scopes: ["write"],
        current,
      });
      const limited = yield* fromTestPromise(() =>
        sendPublicRequest(
          budgetDb,
          bearerRequest(0, budgetToken, [transactionCall(1, input()), transactionCall(2, input())])
        )
      );
      expect(limited.status).toBe(400);
      const limitedRejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => limited.json())
      ).pipe(Effect.orDie);
      expect(limitedRejection.error.code).toBe("rate_limited");
      expect(limitedRejection.error.failedCallIndex).toBe(1);
      expect(limitedRejection.error.operation).toBe("transactions.createTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            budgetDb,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(99);
      const budgetRefusals = yield* fromTestPromise(() =>
        auditedPATOperations(budgetDb, users[0] ?? "")
      );
      expect(budgetRefusals).toEqual([
        { operation: "transactions.createTransaction", outcome: "rejected" },
      ]);
    })
  ));

it("refuses a batch under a revoked session, revoked PAT, or withdrawn Consent without writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const current = yield* Clock.currentTimeMillis;
      const token = `fin_${"v".repeat(8)}_${"e".repeat(43)}`;
      yield* seedPAT({ db, userId: users[0] ?? "", token, scopes: ["write"], current });
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(current, sessions[0])
          .run()
      );
      const revokedSession = yield* fromTestPromise(() =>
        sendPublicRequest(db, batchRequest(0, [transactionCall(1, input())]))
      );
      expect(revokedSession.status).toBe(401);
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE pats SET revoked_at_ms = ? WHERE short_id = ?")
          .bind(current, token.slice(4, 12))
          .run()
      );
      const revokedPAT = yield* fromTestPromise(() =>
        sendPublicRequest(db, bearerRequest(0, token, [transactionCall(1, input())]))
      );
      expect(revokedPAT.status).toBe(401);

      const neighborToken = `fin_${"w".repeat(8)}_${"f".repeat(43)}`;
      yield* seedPAT({
        db,
        userId: users[1] ?? "",
        token: neighborToken,
        scopes: ["write"],
        current,
      });
      const grantId = "50000000-0000-4000-8000-000000000001";
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO onboarding_consent_records
            (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
            VALUES (?,?,'{}','disclosure','decision',?,?)`)
          .bind(grantId, users[1], current, current)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO consent_user_revocations (id,user_id,grant_record_id,session_id,occurred_at_ms)
            VALUES (?,?,?,?,?)`)
          .bind("50000000-0000-4000-8000-000000000002", users[1], grantId, sessions[1], current)
          .run()
      );
      const withdrawn = yield* fromTestPromise(() =>
        sendPublicRequest(db, bearerRequest(1, neighborToken, [transactionCall(1, input())]))
      );
      expect(withdrawn.status).toBe(403);
      const withdrawal = yield* Schema.decodeUnknownEffect(CallerFailure)(
        yield* fromTestPromise(() => withdrawn.json())
      ).pipe(Effect.orDie);
      expect(withdrawal.error.code).toBe("user_action_required");
      const neighborSession = yield* fromTestPromise(() =>
        sendPublicRequest(db, batchRequest(1, [transactionCall(1, input())]))
      );
      expect(neighborSession.status).toBe(401);

      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("attributes a malformed child to its index and Audit while an unshaped body stays unattributed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const malformed = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              calls: [
                {
                  callId: "not-a-uuid",
                  operation: "transactions.createTransaction",
                  input: { payload: {} },
                },
              ],
            }),
          })
        )
      );
      expect(malformed.status).toBe(400);
      const childFailure = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => malformed.json())
      ).pipe(Effect.orDie);
      expect(childFailure.error.code).toBe("validation_failed");
      expect(childFailure.error.failedCallIndex).toBe(0);
      expect(childFailure.error.operation).toBe("transactions.createTransaction");
      const refusals = yield* fromTestPromise(() => auditedOperations(db, users[0] ?? ""));
      expect(refusals).toEqual([
        { operation: "transactions.createTransaction", outcome: "validation_failed" },
      ]);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);

      const unshaped = yield* fromTestPromise(() => sendPublicRequest(db, batchRequest(0, [])));
      expect(unshaped.status).toBe(400);
      const unshapedFailure = yield* Schema.decodeUnknownEffect(CallerFailure)(
        yield* fromTestPromise(() => unshaped.json())
      ).pipe(Effect.orDie);
      expect(unshapedFailure.error.code).toBe("validation_failed");
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(1);
    })
  ));

it.each([
  {
    name: "malformed Transaction identity",
    path: "/transactions/not-a-transaction-id",
    payload: { expectedRevision: 0, changes: { notes: "correction" } },
    call: correctionCall(1, "not-a-transaction-id", {
      expectedRevision: 0,
      changes: { notes: "correction" },
    }),
  },
  {
    name: "missing Transaction identity",
    path: "/transactions/30000000-0000-4000-8000-000000000099",
    payload: { expectedRevision: 0, changes: { notes: "correction" } },
    call: correctionCall(1, "30000000-0000-4000-8000-000000000099", {
      expectedRevision: 0,
      changes: { notes: "correction" },
    }),
  },
])(
  "answers a $name with the same refusal and Audit in both public forms",
  ({ path, payload, call }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* fromTestPromise(() => setup());
        const individual = yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request(`https://api.fidyapp.com${path}`, {
              method: "PUT",
              headers: {
                origin: "https://app.fidyapp.com",
                cookie: `__Host-fidy_session=${bearer(0)}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(payload),
            })
          )
        );
        expect(individual.status).toBe(404);
        const individualFailure = yield* Schema.decodeUnknownEffect(CallerFailure)(
          yield* fromTestPromise(() => individual.json())
        ).pipe(Effect.orDie);
        expect(individualFailure.error.code).toBe("not_found");
        const individualAudit = yield* fromTestPromise(() => auditedOperations(db, users[0] ?? ""));
        expect(individualAudit).toEqual([{ operation: call.operation, outcome: "not_found" }]);

        const batch = yield* fromTestPromise(() => sendPublicRequest(db, batchRequest(0, [call])));
        expect(batch.status).toBe(400);
        const refusal = yield* Schema.decodeUnknownEffect(BatchRejection)(
          yield* fromTestPromise(() => batch.json())
        ).pipe(Effect.orDie);
        expect(refusal.error.code).toBe(individualFailure.error.code);
        expect(refusal.error.failedCallIndex).toBe(0);
        expect(refusal.error.operation).toBe(call.operation);
        expect(yield* fromTestPromise(() => auditedOperations(db, users[0] ?? ""))).toEqual([
          ...individualAudit,
          { operation: call.operation, outcome: individualFailure.error.code },
        ]);
      })
    )
);

it("answers an unstable retained id the same in a batch child as on its individual route", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input({ counterparty: "Acme" })),
            correctionCall(2, "not-a-transaction-id", {
              expectedRevision: 0,
              changes: { notes: "batch" },
            }),
          ])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("not_found");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      const refusedAudits = yield* fromTestPromise(() => auditedOperations(db, users[0] ?? ""));
      expect(refusedAudits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "not_found" },
      ]);
    })
  ));

it("attributes a repeated observed revision to the later correction without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000009";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const repeated = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            correctionCall(1, seededId, { expectedRevision: 0, changes: { notes: "first" } }),
            correctionCall(2, seededId, { expectedRevision: 0, changes: { notes: "second" } }),
          ])
        )
      );
      expect(repeated.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => repeated.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      const retained = yield* fromTestPromise(() =>
        db
          .prepare("SELECT notes, revision FROM transactions WHERE user_id = ? AND id = ?")
          .bind(users[0], seededId)
          .all<{ notes: string; revision: number }>()
      );
      expect(retained.results).toEqual([{ notes: "seed", revision: 0 }]);
      const refusedAudits = yield* fromTestPromise(() => auditedOperations(db, users[0] ?? ""));
      expect(refusedAudits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
      ]);
    })
  ));

it("refuses a cookie-admitted batch without the browser origin and writes nothing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const refused = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ calls: [transactionCall(1, input())] }),
          })
        )
      );
      expect(refused.status).toBe(403);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM pat_audit"))
      ).toBe(0);
    })
  ));
