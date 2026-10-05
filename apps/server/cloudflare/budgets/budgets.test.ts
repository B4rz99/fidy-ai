import {
  evaluateBudgetAlerts,
  readBudgetCaps,
  readBudgetCrossingGroups,
  readBudgetCrossings,
  readBudgetSpending,
} from "./operations";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  WhatsAppCallerReference,
} from "../../src/core/identity/contract";
import { type ConsentUnavailable } from "../consent/contract";
import { type InsightUnavailable } from "../insights/contract";
import {
  createProactivityConsentOffer,
  findProactivityConsentGrant,
  recordProactivityConsentDisclosure,
} from "../consent/operations";
import { recordProactivityDecision } from "../insights/operations";
import { type ConsentRecordId, DisclosureSnapshot } from "../../src/core/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { executeCanonicalWork } from "../canonical-operations/operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import {
  canonicalAdmissionMigrationNames,
  installTestSchema,
  isolatedTestDatabases,
  statementAuditTestMigrations,
} from "../d1-test-fixture";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Cause, DateTime, Effect, Array as EffectArray, Option, Schema } from "effect";
import { Budget, BudgetId, BudgetStatusReport } from "../../src/core/budgets/contract";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { deriveCurrentBudgetMonth } from "../../src/core/budgets/operations";
import { Transaction } from "../../src/core/transactions/contract";
import { encodeMoneyAmount } from "../../src/core/_shared/money";
import { AtomicBatchRejected } from "../../src/shell/operations/contract";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { UserTransactionCoordinator } from "../transactions/runtime";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";

const users = [
  "10000000-0000-4000-8000-000000000051",
  "10000000-0000-4000-8000-000000000052",
] as const;
const category = "10000000-0000-4000-8000-000000000016";
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
const databases = isolatedTestDatabases();
const bearer = (index: number): string => String(index + 1).repeat(43);
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));
// The Miniflare fixture owns foreign Promise APIs, not application workflow.

const seedUser = (
  db: D1Database,
  input: Readonly<{ user: string; index: number; current: number }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { user, index, current } = input;
    const verifierDigest = yield* Effect.tryPromise(() => digest(`verifier${index}`));
    const tokenDigest = yield* Effect.tryPromise(() => digest(bearer(index)));
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
          )
          .bind(user, current),
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
          ),
        db
          .prepare(
            "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(
            sessions[index],
            `10000000-0000-4000-8000-00000000007${index}`,
            user,
            tokenDigest,
            current,
            current + 600000,
            current + 3600000,
            current + 7776000000
          ),
      ])
    );
  });

const setup = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    const migrations = [
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
      "0037_budget_crossing_facts",
      "0038_proactivity_consent",
      "0042_budget_proactivity",
      "0016_statement_processing",
      "0017_forwarded_email",
      "0017_statement_dispatch",
      "0018_batch_envelope_audit",
      "0019_canonical_child_guards",
      "0020_dashboard_projection",
      "0009_email_replacement",
      "0018_dashboard",
      "0018_insight_events",
      ...statementAuditTestMigrations,
    ];
    yield* Effect.tryPromise(() =>
      installTestSchema({
        db,
        sources: canonicalAdmissionMigrationNames(migrations).map(
          (name) => new URL(`../migrations/${name}.sql`, import.meta.url)
        ),
      })
    );
    const current = DateTime.nowUnsafe().epochMilliseconds;
    yield* Effect.forEach(users, (user, index) => seedUser(db, { user, index, current }), {
      discard: true,
    });
    return db;
  });
afterAll(() => databases.dispose());
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());
const coordinatorByDatabase = new WeakMap<D1Database, Map<string, UserTransactionCoordinator>>();
const send = (db: D1Database, request: Request): Promise<Response> => {
  vi.setSystemTime(DateTime.nowUnsafe().epochMilliseconds + 1000);
  request.headers.set("cf-connecting-ip", "192.0.2.35");
  const coordinators =
    coordinatorByDatabase.get(db) ?? new Map<string, UserTransactionCoordinator>();
  coordinatorByDatabase.set(db, coordinators);
  return publicWorker.fetch(request, {
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
          USER_TRANSACTION_COORDINATOR: {
            getByName: (name) => ({
              fetch: (command) => {
                let coordinator = coordinators.get(name);
                if (coordinator === undefined) {
                  coordinator = new UserTransactionCoordinator(
                    { id: { name }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
                    {
                      DB: db,
                      AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
                      HOSTED_AI_MODEL: approvedWorkersAiModel,
                    }
                  );
                  coordinators.set(name, coordinator);
                }
                return coordinator.fetch(new Request(command));
              },
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
};
const request = (
  index: number,
  path: string,
  ...args: [method?: string, body?: object]
): Request => {
  const [method = "GET", body] = args;
  const init: RequestInit = {
    method,
    headers: {
      origin: "https://app.fidyapp.com",
      cookie: `__Host-fidy_session=${bearer(index)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  };
  return new Request(
    `https://api.fidyapp.com${path}`,
    body === undefined
      ? init
      : {
          ...init,
          body: JSON.stringify(body),
        }
  );
};

const seedPAT = (
  db: D1Database,
  input: Readonly<{ token: string; scope: "read" | "write"; id: string }>
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { token, scope, id } = input;
    const current = DateTime.nowUnsafe().epochMilliseconds;
    const credentialDigest3 = yield* Effect.tryPromise(() => digest(token));
    const scopesJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Schema.String))
    )([scope]);
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json, lifetime_days,
    created_at_ms, issued_at_ms, expires_at_ms, request_id)
    VALUES (?, ?, ?, ?, 'Budget security fixture', ?, 7, ?, ?, ?, ?)`)
        .bind(
          id,
          users[0],
          token.slice(4, 12),
          credentialDigest3,
          scopesJson,
          current,
          current,
          current + 7 * 86400000,
          id.replace("8000", "9000")
        )
        .run()
    );
  });

const seedMonthlyMovements = (
  db: D1Database,
  input: Readonly<{
    categoryId: string;
    currency: string;
    occurredAt: string;
    count: number;
    offset: number;
  }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.asVoid(
    Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    WITH RECURSIVE seq(n) AS (SELECT ? + 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
    SELECT printf('30000000-0000-4000-8000-%012d', n), ?, '0.01', ?, 'outflow', ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', date('2024-01-01', '+' || (n / 99) || ' days'))
    FROM seq`)
        .bind(
          input.offset,
          input.offset + input.count,
          users[0],
          input.currency,
          input.categoryId,
          input.occurredAt
        )
        .run()
    )
  );
const patRequest = (
  token: string,
  path: string,
  ...args: [method?: string, body?: object]
): Request => {
  const [method = "GET", body] = args;
  return new Request(`https://api.fidyapp.com${path}`, {
    method,
    headers: {
      origin: "https://app.fidyapp.com",
      authorization: `Bearer ${token}`,
      "x-provider-id": users[0],
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};
const payload = (cap = "100"): object => ({
  categoryId: category,
  cap: { amount: cap, currency: "COP" },
});
const budgetBatch = (calls: ReadonlyArray<object>): Request =>
  request(0, "/operations/atomic-batch", "POST", { calls });
const budgetCall = (index: number, operation: string, input: object): object => ({
  callId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  operation,
  input,
});
const Created = Schema.Struct({
  data: Schema.toCodecJson(Budget),
  next: Schema.Array(Schema.Unknown),
});
const Report = Schema.Struct({
  data: Schema.toCodecJson(BudgetStatusReport),
  next: Schema.Array(Schema.Unknown),
});
const Captured = Schema.Struct({
  data: Schema.toCodecJson(Transaction),
  next: Schema.Array(Schema.Unknown),
});

it("attributes a mixed-child Budget Audit limit before the owner's trigger and rolls back", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const createResponse4 = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budgets", "POST", payload()))
      );
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => createResponse4.json())
      );
      const current = DateTime.nowUnsafe().epochMilliseconds;
      yield* Effect.tryPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 253)
    INSERT INTO budget_audit (id, user_id, session_id, operation, occurred_at_ms)
    SELECT 'budget-audit-seed-' || n, ?, ?, 'budgets.listBudgets', ? FROM seq`)
          .bind(users[0], sessions[0], current)
          .run()
      );
      const limited = yield* Effect.tryPromise(() =>
        send(
          db,
          budgetBatch([
            budgetCall(1, "budgets.updateBudget", {
              params: { id: created.data.id },
              payload: payload("200"),
            }),
            budgetCall(2, "budgets.updateBudget", {
              params: { id: created.data.id },
              payload: payload("300"),
            }),
          ])
        )
      );
      expect(limited.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(AtomicBatchRejected)(
        yield* Effect.tryPromise(() => limited.json())
      );
      expect(rejection.error.code).toBe("rate_limited");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("budgets.updateBudget");
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM budget_audit").first<{ count: number }>()
        ))?.count
      ).toBe(255);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT cap FROM budgets WHERE id = ?")
            .bind(created.data.id)
            .first<{ cap: string }>()
        ))?.cap
      ).toBe("100");
    })
  ));

it("admits a browser Budget when only the separate shared Audit cap is exhausted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const current = DateTime.nowUnsafe().epochMilliseconds;
      yield* Effect.tryPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 255)
    INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT 'shared-audit-seed-' || n, ?, ?, 'transactions.listTransactions', 'success', ? FROM seq`)
          .bind(users[0], sessions[0], current)
          .run()
      );
      const response = yield* Effect.tryPromise(() =>
        send(db, budgetBatch([budgetCall(1, "budgets.createBudget", { payload: payload() })]))
      );
      expect(response.status).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM budgets WHERE user_id = ?")
            .bind(users[0])
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM budget_audit").first<{ count: number }>()
        ))?.count
      ).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM transaction_audit").first<{ count: number }>()
        ))?.count
      ).toBe(256);
    })
  ));

it("attributes the second Budget create when the first fills the owner capacity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 126)
    INSERT INTO categories (id, label, display_order)
    SELECT printf('10000000-0000-4000-8000-%012d', n + 1000), 'Fixture ' || n, n + 1000 FROM seq`)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 126)
    INSERT INTO budgets (id, user_id, category_id, currency, cap, created_at, updated_at)
    SELECT printf('40000000-0000-4000-8000-%012d', n), ?,
      printf('10000000-0000-4000-8000-%012d', n + 1000), 'COP', '100',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z' FROM seq`)
          .bind(users[0])
          .run()
      );
      yield* Effect.tryPromise(() =>
        db.prepare("DELETE FROM budget_reconciliation_work WHERE user_id = ?").bind(users[0]).run()
      );
      const limited = yield* Effect.tryPromise(() =>
        send(
          db,
          budgetBatch([
            budgetCall(1, "budgets.createBudget", { payload: payload() }),
            budgetCall(2, "budgets.createBudget", {
              payload: {
                categoryId: "10000000-0000-4000-8000-000000000001",
                cap: { amount: "200", currency: "COP" },
              },
            }),
          ])
        )
      );
      expect(limited.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(AtomicBatchRejected)(
        yield* Effect.tryPromise(() => limited.json())
      );
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("budgets.createBudget");
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM budgets WHERE user_id = ?")
            .bind(users[0])
            .first<{ count: number }>()
        ))?.count
      ).toBe(127);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM budget_audit").first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
  ));

it("classifies a skipped Budget update after an earlier deletion as not_found without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const createResponse5 = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budgets", "POST", payload()))
      );
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => createResponse5.json())
      );
      const refused = yield* Effect.tryPromise(() =>
        send(
          db,
          budgetBatch([
            budgetCall(1, "budgets.deleteBudget", { params: { id: created.data.id } }),
            budgetCall(2, "budgets.updateBudget", {
              params: { id: created.data.id },
              payload: payload("200"),
            }),
          ])
        )
      );
      expect(refused.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(AtomicBatchRejected)(
        yield* Effect.tryPromise(() => refused.json())
      );
      expect(rejection.error.code).toBe("not_found");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("budgets.updateBudget");
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT cap FROM budgets WHERE id = ?")
            .bind(created.data.id)
            .first<{ cap: string }>()
        ))?.cap
      ).toBe("100");
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM budget_audit WHERE outcome = 'accepted'")
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM budget_audit WHERE outcome = 'rejected'")
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
  ));

it("classifies a Budget deleted between preparation and its indexed D1 write as not_found", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const createResponse6 = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budgets", "POST", payload()))
      );
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => createResponse6.json())
      );
      let vanished = false;
      const racingDb: D1Database = {
        prepare: (sql) => db.prepare(sql),
        batch: (statements) => {
          if (vanished) return db.batch(statements);
          vanished = true;
          return db
            .prepare("DELETE FROM budgets WHERE id = ?")
            .bind(created.data.id)
            .run()
            .then(() => db.batch(statements));
        },
        exec: (sql) => db.exec(sql),
        withSession: (constraint) => db.withSession(constraint),
        dump: () => db.dump(),
      };
      const refused = yield* Effect.tryPromise(() =>
        send(racingDb, request(0, `/budgets/${created.data.id}`, "PUT", payload("200")))
      );
      expect(vanished).toBe(true);
      expect(refused.status).toBe(404);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM budgets WHERE id = ?")
            .bind(created.data.id)
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM budget_audit WHERE outcome = 'rejected'")
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
  ));

it("creates a positive User-owned Budget and never reveals it to another User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const created = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budgets", "POST", payload()))
      );
      expect(created.status).toBe(201);
      const body = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => created.json())
      );
      expect(encodeMoneyAmount(body.data.cap.amount)).toBe("100");
      const foreign = yield* Effect.tryPromise(() =>
        send(db, request(1, `/budgets/${body.data.id}`))
      );
      expect(foreign.status).toBe(404);
      const own = yield* Effect.tryPromise(() => send(db, request(0, `/budgets/${body.data.id}`)));
      expect(own.status).toBe(200);
    })
  ));

it("revises a Budget without changing Currency and deletes only its owner's Budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const createResponse7 = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budgets", "POST", payload()))
      );
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => createResponse7.json())
      );
      const id = created.data.id;
      const foreign = yield* Effect.tryPromise(() =>
        send(db, request(1, `/budgets/${id}`, "PUT", payload("200")))
      );
      expect(foreign.status).toBe(404);
      expect(
        (yield* Effect.tryPromise(() => send(db, request(1, `/budgets/${id}`, "DELETE")))).status
      ).toBe(404);
      const refused = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM budget_audit WHERE user_id = ? ORDER BY operation"
          )
          .bind(users[1])
          .all<{ operation: string; outcome: string }>()
      );
      expect(refused.results).toEqual([
        { operation: "budgets.deleteBudget", outcome: "rejected" },
        { operation: "budgets.updateBudget", outcome: "rejected" },
      ]);
      expect((yield* Effect.tryPromise(() => send(db, request(0, `/budgets/${id}`)))).status).toBe(
        200
      );
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/budgets/not-a-budget", "DELETE"))))
          .status
      ).toBe(404);
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/budgets", "POST", {
              categoryId: category,
              cap: { amount: "-1", currency: "COP" },
            })
          )
        )).status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/budget-status?timeZone=not-a-zone"))))
          .status
      ).toBe(400);
      const invalidAudits = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT operation FROM budget_audit
    WHERE user_id = ? AND outcome = 'rejected' ORDER BY operation`)
          .bind(users[0])
          .all<{ operation: string }>()
      );
      expect(invalidAudits.results.map((row) => row.operation)).toEqual([
        "budgets.createBudget",
        "budgets.deleteBudget",
        "budgets.getBudgetStatus",
      ]);
      const wrongCurrency = yield* Effect.tryPromise(() =>
        send(
          db,
          request(0, `/budgets/${id}`, "PUT", {
            categoryId: category,
            cap: { amount: "200", currency: "USD" },
          })
        )
      );
      expect(wrongCurrency.status).toBe(400);
      const duplicate = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budgets", "POST", payload("300")))
      );
      expect(duplicate.status).toBe(400);
      const updated = yield* Effect.tryPromise(() =>
        send(db, request(0, `/budgets/${id}`, "PUT", payload("250.25")))
      );
      expect(updated.status).toBe(200);
      const changed = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => updated.json())
      );
      expect(encodeMoneyAmount(changed.data.cap.amount)).toBe("250.25");
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, `/budgets/${id}`, "DELETE")))).status
      ).toBe(200);
      expect((yield* Effect.tryPromise(() => send(db, request(0, `/budgets/${id}`)))).status).toBe(
        404
      );
      expect(
        (yield* Effect.tryPromise(() => send(db, request(1, "/budgets", "POST", payload())))).status
      ).toBe(201);
    })
  ));

it(
  "reads back Budget creation, replacement and removal through the atomic batch without leaking a foreign Budget",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const call = (operation: string, input: object, index: number): object => ({
          callId: `30000000-0000-4000-8000-00000000000${index}`,
          operation,
          input,
        });
        const batch = (calls: ReadonlyArray<object>): Promise<Response> =>
          send(db, request(0, "/operations/atomic-batch", "POST", { calls }));
        const created = yield* Effect.tryPromise(() =>
          batch([call("budgets.createBudget", { payload: payload() }, 1)])
        );
        expect(created.status).toBe(200);
        const result = yield* Effect.tryPromise(() => created.json());
        const id = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              results: Schema.Array(
                Schema.Struct({
                  output: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
                })
              ),
            }),
          })
        )(result)).data.results[0]?.output.data.id;
        expect(id).toBeDefined();
        const changed = yield* Effect.tryPromise(() =>
          batch([
            call(
              "budgets.updateBudget",
              {
                params: { id },
                payload: payload("250.25"),
              },
              2
            ),
          ])
        );
        expect(changed.status).toBe(200);
        const updated = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              results: Schema.Array(
                Schema.Struct({
                  output: Schema.Struct({ data: Schema.toCodecJson(Budget) }),
                })
              ),
            }),
          })
        )(yield* Effect.tryPromise(() => changed.json()));
        const first = updated.data.results[0];
        if (first === undefined) throw new Error("Missing batch Budget result");
        expect(encodeMoneyAmount(first.output.data.cap.amount)).toBe("250.25");
        const foreign = yield* Effect.tryPromise(() => send(db, request(1, `/budgets/${id}`)));
        expect(foreign.status).toBe(404);
        const removed = yield* Effect.tryPromise(() =>
          batch([call("budgets.deleteBudget", { params: { id } }, 3)])
        );
        expect(removed.status).toBe(200);
        expect(yield* Effect.tryPromise(() => removed.json())).toMatchObject({
          data: { results: [{ output: { data: id } }] },
        });
        expect(
          (yield* Effect.tryPromise(() => send(db, request(0, `/budgets/${id}`)))).status
        ).toBe(404);
      })
    ),
  30_000
);

it("reports only this User's exact same-Currency outflows in the applied half-open month", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload())))).status
      ).toBe(201);
      const period = deriveCurrentBudgetMonth({
        now: DateTime.nowUnsafe(),
        timeZone: IanaTimeZone.make("America/Bogota"),
      });
      const capture = (
        index: number,
        amount: string,
        ...args: [currency: string, direction: string, occurredAt: string]
      ): Promise<Response> => {
        const [currency, direction, occurredAt] = args;
        return send(
          db,
          request(index, "/transactions", "POST", {
            money: { amount, currency },
            categoryId: category,
            direction,
            occurredAt,
          })
        );
      };
      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "80.01", "COP", "outflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "19.98", "COP", "outflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "5", "USD", "outflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "5", "COP", "inflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(1, "5", "COP", "outflow", DateTime.formatIso(period.from))
        )).status
      ).toBe(201);
      const before = DateTime.makeUnsafe(period.from.epochMilliseconds - 1);
      expect(
        (yield* Effect.tryPromise(() =>
          capture(0, "5", "COP", "outflow", DateTime.formatIso(before))
        )).status
      ).toBe(201);
      // Capture rejects future Transactions. Seed that boundary to exercise the canonical GET projection.
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    VALUES (?, ?, '900', 'COP', 'outflow', ?, ?, ?)`)
          .bind(
            "30000000-0000-4000-8000-000000000093",
            users[0],
            category,
            DateTime.formatIso(period.to),
            DateTime.formatIso(DateTime.nowUnsafe())
          )
          .run()
      );
      const response = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budget-status?timeZone=America%2FBogota"))
      );
      expect(response.status).toBe(200);
      const report = yield* Schema.decodeUnknownEffect(Report)(
        yield* Effect.tryPromise(() => response.json())
      );
      expect(report.data.statuses).toHaveLength(1);
      const [first] = report.data.statuses;
      if (first === undefined) throw new Error("Budget status missing");
      expect(encodeMoneyAmount(first.spent.amount)).toBe("99.99");
      const other = yield* Effect.tryPromise(() =>
        send(db, request(1, "/budget-status?timeZone=America%2FBogota"))
      );
      expect(other.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(Report)(yield* Effect.tryPromise(() => other.json())))
          .data.statuses
      ).toEqual([]);
    })
  ));

it(
  "ignores more than five thousand unrelated outflows without blocking a Budget mutation",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        expect(
          (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload()))))
            .status
        ).toBe(201);
        yield* seedMonthlyMovements(db, {
          categoryId: "10000000-0000-4000-8000-000000000001",
          count: 5001,
          offset: 0,
          currency: "COP",
          occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
        });
        const report = yield* Effect.tryPromise(() =>
          send(db, request(0, "/budget-status?timeZone=America%2FBogota"))
        );
        expect(report.status).toBe(200);
        const [status] = (yield* Schema.decodeUnknownEffect(Report)(
          yield* Effect.tryPromise(() => report.json())
        )).data.statuses;
        expect(status === undefined ? undefined : encodeMoneyAmount(status.spent.amount)).toBe("0");
        const capture = yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/transactions", "POST", {
              money: { amount: "1", currency: "COP" },
              categoryId: category,
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            })
          )
        );
        expect(capture.status).toBe(201);
      })
    ),
  90000
);

it(
  "pages past five thousand qualifying outflows without losing exact totals or blocking mutations",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        expect(
          (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload()))))
            .status
        ).toBe(201);
        yield* seedMonthlyMovements(db, {
          categoryId: category,
          currency: "COP",
          count: 5001,
          offset: 0,
          occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
        });
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, request(0, "/budget-status?timeZone=America%2FBogota"))
          )).status
        ).toBe(503);
        const report = yield* Effect.tryPromise(() =>
          send(db, request(0, "/budget-status?timeZone=America%2FBogota"))
        );
        expect(report.status).toBe(200);
        const [status] = (yield* Schema.decodeUnknownEffect(Report)(
          yield* Effect.tryPromise(() => report.json())
        )).data.statuses;
        expect(status === undefined ? undefined : encodeMoneyAmount(status.spent.amount)).toBe(
          "50.01"
        );
        expect((yield* Effect.tryPromise(() => send(db, request(0, "/budgets")))).status).toBe(200);
        const capture = yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/transactions", "POST", {
              money: { amount: "30", currency: "COP" },
              categoryId: category,
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            })
          )
        );
        expect(capture.status).toBe(201);
        const updated = yield* Effect.tryPromise(() =>
          send(db, request(0, "/budget-status?timeZone=America%2FBogota"))
        );
        expect(updated.status).toBe(200);
        const [next] = (yield* Schema.decodeUnknownEffect(Report)(
          yield* Effect.tryPromise(() => updated.json())
        )).data.statuses;
        expect(next === undefined ? undefined : encodeMoneyAmount(next.spent.amount)).toBe("80.01");
      })
    ),
  90000
);

it(
  "shares a bounded page quota across Budgets rather than applying it per Budget",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const otherCategory = "10000000-0000-4000-8000-000000000001";
        expect(
          (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload()))))
            .status
        ).toBe(201);
        expect(
          (yield* Effect.tryPromise(() =>
            send(
              db,
              request(0, "/budgets", "POST", {
                categoryId: otherCategory,
                cap: { amount: "100", currency: "COP" },
              })
            )
          )).status
        ).toBe(201);
        const occurredAt = DateTime.formatIso(DateTime.nowUnsafe());
        yield* seedMonthlyMovements(db, {
          categoryId: category,
          currency: "COP",
          count: 2500,
          offset: 0,
          occurredAt,
        });
        yield* seedMonthlyMovements(db, {
          categoryId: otherCategory,
          currency: "COP",
          count: 2500,
          offset: 2500,
          occurredAt,
        });
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, request(0, "/budget-status?timeZone=America%2FBogota"))
          )).status
        ).toBe(503);
        const checkpoint = yield* Effect.tryPromise(() =>
          db
            .prepare(`SELECT COUNT(*) AS count FROM budget_report_progress
    WHERE user_id = ? AND complete = 0`)
            .bind(users[0])
            .first<{ count: number }>()
        );
        expect(checkpoint?.count).toBe(1);
        const report = yield* Effect.tryPromise(() =>
          send(db, request(0, "/budget-status?timeZone=America%2FBogota"))
        );
        expect(report.status).toBe(200);
        const statuses = (yield* Schema.decodeUnknownEffect(Report)(
          yield* Effect.tryPromise(() => report.json())
        )).data.statuses;
        expect(statuses.map((status) => encodeMoneyAmount(status.spent.amount))).toEqual([
          "25",
          "25",
        ]);
      })
    ),
  90000
);

it(
  "refuses an expensive capture without partial effects, then resumes the month on retry",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        expect(
          (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload()))))
            .status
        ).toBe(201);
        yield* seedMonthlyMovements(db, {
          categoryId: category,
          currency: "COP",
          count: 5001,
          offset: 0,
          occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
        });
        const capture = (): Promise<Response> =>
          send(
            db,
            request(0, "/transactions", "POST", {
              money: { amount: "30", currency: "COP" },
              categoryId: category,
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            })
          );
        expect((yield* Effect.tryPromise(() => capture())).status).toBe(503);
        const afterRefusal = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?")
            .bind(users[0])
            .first<{ count: number }>()
        );
        expect(afterRefusal?.count).toBe(5001);
        expect((yield* Effect.tryPromise(() => capture())).status).toBe(201);
        const report = yield* Effect.tryPromise(() =>
          send(db, request(0, "/budget-status?timeZone=America%2FBogota"))
        );
        expect(report.status).toBe(200);
        const [status] = (yield* Schema.decodeUnknownEffect(Report)(
          yield* Effect.tryPromise(() => report.json())
        )).data.statuses;
        expect(status === undefined ? undefined : encodeMoneyAmount(status.spent.amount)).toBe(
          "80.01"
        );
      })
    ),
  90000
);

it(
  "does not publish a total if a Transaction moves across a paging cursor",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        expect(
          (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload()))))
            .status
        ).toBe(201);
        const period = deriveCurrentBudgetMonth({
          now: DateTime.nowUnsafe(),
          timeZone: IanaTimeZone.make("America/Bogota"),
        });
        yield* seedMonthlyMovements(db, {
          categoryId: category,
          currency: "COP",
          count: 513,
          offset: 0,
          occurredAt: DateTime.formatIso(period.from),
        });
        let moved = false;
        const intercept = (statement: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(statement, {
            get(target, property, receiver) {
              if (property === "bind") {
                return (...values: Parameters<D1PreparedStatement["bind"]>): D1PreparedStatement =>
                  intercept(target.bind(...values));
              }
              if (property === "all") {
                return (): Promise<D1Result<Record<string, unknown>>> =>
                  target.all().then((result) => {
                    if (moved) return result;
                    moved = true;
                    return db
                      .prepare(
                        "UPDATE transactions SET occurred_at = ? WHERE user_id = ? AND id = ?"
                      )
                      .bind(
                        DateTime.formatIso(
                          DateTime.makeUnsafe(period.from.epochMilliseconds + 1000)
                        ),
                        users[0],
                        "30000000-0000-4000-8000-000000000001"
                      )
                      .run()
                      .then(() => result);
                  });
              }
              const value: unknown = Reflect.get(target, property, receiver);
              return value;
            },
          });
        const racingDb: D1Database = {
          prepare: (sql) =>
            sql.includes("ORDER BY occurred_at, id LIMIT")
              ? intercept(db.prepare(sql))
              : db.prepare(sql),
          batch: (statements) => db.batch(statements),
          exec: (sql) => db.exec(sql),
          withSession: (constraint) => db.withSession(constraint),
          dump: () => db.dump(),
        };
        expect(
          (yield* Effect.tryPromise(() =>
            send(racingDb, request(0, "/budget-status?timeZone=America%2FBogota"))
          )).status
        ).toBe(503);
        expect(moved).toBe(true);
        // The next query resumes the new financial revision, without first draining alert work.
        const report = yield* Effect.tryPromise(() =>
          send(db, request(0, "/budget-status?timeZone=America%2FBogota"))
        );
        expect(report.status).toBe(200);
        const [status] = (yield* Schema.decodeUnknownEffect(Report)(
          yield* Effect.tryPromise(() => report.json())
        )).data.statuses;
        expect(status === undefined ? undefined : encodeMoneyAmount(status.spent.amount)).toBe(
          "5.13"
        );
      })
    ),
  90000
);

it("latches 80% and 100% only once across concurrent capture and correction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload())))).status
      ).toBe(201);
      const occurredAt = DateTime.formatIso(DateTime.nowUnsafe());
      const capture = (): Promise<Response> =>
        send(
          db,
          request(0, "/transactions", "POST", {
            money: { amount: "50", currency: "COP" },
            direction: "outflow",
            categoryId: category,
            occurredAt,
          })
        );
      const [one, two] = yield* Effect.tryPromise(() => Promise.all([capture(), capture()]));
      expect([one.status, two.status]).toEqual([201, 201]);
      const first = yield* Schema.decodeUnknownEffect(Captured)(
        yield* Effect.tryPromise(() => one.json())
      );
      const recorded = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT threshold FROM budget_threshold_alerts WHERE user_id = ? ORDER BY threshold"
          )
          .bind(users[0])
          .all<{ threshold: number }>()
      );
      expect(recorded.results.map((row) => row.threshold)).toEqual([80, 100]);
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, `/transactions/${first.data.id}`, "PUT", {
              expectedRevision: 0,
              changes: { money: { amount: "10", currency: "COP" } },
            })
          )
        )).status
      ).toBe(200);
      expect((yield* Effect.tryPromise(() => capture())).status).toBe(201);
      const after = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT threshold FROM budget_threshold_alerts WHERE user_id = ? ORDER BY threshold"
          )
          .bind(users[0])
          .all<{ threshold: number }>()
      );
      expect(after.results.map((row) => row.threshold)).toEqual([80, 100]);
    })
  ));

const seedCrossingConsent = (
  db: D1Database
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const disclosure = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot))
    )(currentDisclosureFor());
    yield* Effect.tryPromise(() =>
      db.batch(
        users.map((user) =>
          db
            .prepare(
              "INSERT INTO onboarding_consent_records (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES (?,?,?,'disclosed','accepted',0,0)"
            )
            .bind(user, user, disclosure)
        )
      )
    );
  });

const grantBudgetDelivery = (
  db: D1Database
): Effect.Effect<ConsentRecordId, ConsentUnavailable | InsightUnavailable | Cause.UnknownError> =>
  Effect.gen(function* () {
    const userId = UserId.make(users[0]);
    const now = yield* DateTime.now;
    const caller = WhatsAppCallerReference.make({
      businessPortfolioId: WhatsAppBusinessPortfolioId.make("123456789"),
      businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.budgetuser"),
    });
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT OR IGNORE INTO whatsapp_identities(user_id,portfolio_id,bsuid,verified_at_ms) VALUES(?,?,?,?)"
        )
        .bind(
          userId,
          caller.businessPortfolioId,
          caller.businessScopedUserId,
          now.epochMilliseconds
        )
        .run()
    );
    const context = { db, userId, caller, kind: "budget-threshold" as const, now };
    const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
    expect(
      yield* recordProactivityConsentDisclosure({
        ...context,
        offerId: offer.id,
        disclosureMessageId: "budget-disclosure",
      })
    ).toBe(true);
    expect(
      yield* recordProactivityDecision({
        ...context,
        choice: offer.acceptChoice,
        decisionMessageId: "budget-accept",
      })
    ).toBe(true);
    const grant = yield* findProactivityConsentGrant(context);
    return Option.getOrThrow(grant).id;
  });

it("freezes both crossing facts before later corrections and isolates them from a foreign User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* seedCrossingConsent(db);
      const created = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budgets", "POST", payload()))
      );
      expect(created.status).toBe(201);
      const body = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.toCodecJson(Budget) })
      )(yield* Effect.tryPromise(() => created.json()));
      const period = deriveCurrentBudgetMonth({
        now: DateTime.nowUnsafe(),
        timeZone: IanaTimeZone.make("America/Bogota"),
      });
      const captured = yield* Effect.tryPromise(() =>
        send(
          db,
          request(0, "/transactions", "POST", {
            money: { amount: "110", currency: "COP" },
            direction: "outflow",
            categoryId: category,
            occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
          })
        )
      );
      expect(captured.status).toBe(201);
      const movement = yield* Schema.decodeUnknownEffect(Captured)(
        yield* Effect.tryPromise(() => captured.json())
      );
      const input = {
        db,
        userId: UserId.make(users[0]),
        budgetId: BudgetId.make(body.data.id),
        period,
      };
      const crossings = yield* readBudgetCrossings(input);
      const groups = yield* readBudgetCrossingGroups({ db, userId: input.userId });
      expect(groups).toHaveLength(1);
      const group = Option.getOrThrow(EffectArray.head(groups));
      expect(Option.isNone(group.grantId)).toBe(true);
      expect(group.crossings.map((crossing) => crossing.threshold)).toEqual([80, 100]);
      yield* grantBudgetDelivery(db);
      expect(yield* readBudgetCrossingGroups({ db, userId: input.userId })).toEqual(groups);
      expect(yield* readBudgetCrossingGroups({ db, userId: UserId.make(users[1]) })).toEqual([]);
      expect(crossings.map((crossing) => crossing.threshold)).toEqual([80, 100]);
      expect(crossings.map((crossing) => encodeMoneyAmount(crossing.spent.amount))).toEqual([
        "110",
        "110",
      ]);
      expect(crossings.map((crossing) => crossing.spent.currency)).toEqual(["COP", "COP"]);
      expect(yield* readBudgetCrossings({ ...input, userId: UserId.make(users[1]) })).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, `/transactions/${movement.data.id}`, "PUT", {
              expectedRevision: 0,
              changes: { money: { amount: "1", currency: "COP" } },
            })
          )
        )).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, `/budgets/${body.data.id}`, "PUT", payload("200")))
        )).status
      ).toBe(200);
      const frozen = yield* readBudgetCrossings(input);
      expect(frozen.map((crossing) => encodeMoneyAmount(crossing.cap.amount))).toEqual([
        "100",
        "100",
      ]);
      expect(frozen.map((crossing) => encodeMoneyAmount(crossing.spent.amount))).toEqual([
        "110",
        "110",
      ]);
      expect(frozen.map((crossing) => DateTime.formatIso(crossing.detectedAt))).toEqual(
        crossings.map((crossing) => DateTime.formatIso(crossing.detectedAt))
      );
    })
  ));

it("captures the live Budget grant once for a both-threshold mutation without resetting monthly latches", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* seedCrossingConsent(db);
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload())))).status
      ).toBe(201);
      const grantId = yield* grantBudgetDelivery(db);
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/transactions", "POST", {
              money: { amount: "110", currency: "COP" },
              direction: "outflow",
              categoryId: category,
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            })
          )
        )).status
      ).toBe(201);
      const context = { db, userId: UserId.make(users[0]) };
      const groups = yield* readBudgetCrossingGroups(context);
      expect(groups).toHaveLength(1);
      const group = Option.getOrThrow(EffectArray.head(groups));
      expect(group.grantId).toEqual(Option.some(grantId));
      expect(group.crossings.map((crossing) => crossing.threshold)).toEqual([80, 100]);
      expect(yield* evaluateBudgetAlerts({ db, userId: users[0] })).toBe(true);
      expect(yield* readBudgetCrossingGroups(context)).toEqual(groups);
      const mutation = yield* Effect.exit(
        Effect.tryPromise(() =>
          db
            .prepare("UPDATE budget_threshold_alerts SET consent_grant_id=NULL WHERE user_id=?")
            .bind(users[0])
            .run()
        )
      );
      expect(mutation._tag).toBe("Failure");
      expect(yield* readBudgetCrossingGroups(context)).toEqual(groups);
    })
  ));

it("rolls back both threshold marks and frozen facts if one crossing cannot commit, then recovers without losing the peak", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* seedCrossingConsent(db);
      const created = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budgets", "POST", payload()))
      );
      expect(created.status).toBe(201);
      const body = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.toCodecJson(Budget) })
      )(yield* Effect.tryPromise(() => created.json()));
      const period = deriveCurrentBudgetMonth({
        now: DateTime.nowUnsafe(),
        timeZone: IanaTimeZone.make("America/Bogota"),
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER reject_crossing BEFORE INSERT ON budget_threshold_alerts WHEN NEW.threshold=100 BEGIN SELECT RAISE(ABORT,'test_crossing_refusal'); END"
          )
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/transactions", "POST", {
              money: { amount: "110", currency: "COP" },
              direction: "outflow",
              categoryId: category,
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            })
          )
        )).status
      ).toBe(201);
      const input = {
        db,
        userId: UserId.make(users[0]),
        budgetId: BudgetId.make(body.data.id),
        period,
      };
      expect(yield* readBudgetCrossings(input)).toEqual([]);
      const marks = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT reached_80,reached_100 FROM budget_month_latches WHERE user_id=? AND budget_id=?"
          )
          .bind(users[0], body.data.id)
          .first()
      );
      expect(marks).toEqual({ reached_80: 0, reached_100: 0 });
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER reject_crossing").run());
      expect(yield* evaluateBudgetAlerts({ db, userId: users[0] })).toBe(true);
      expect((yield* readBudgetCrossings(input)).map((crossing) => crossing.threshold)).toEqual([
        80, 100,
      ]);
      const overwrite = yield* Effect.exit(
        Effect.tryPromise(() =>
          db
            .prepare(
              "UPDATE budget_threshold_alerts SET crossing_json='{}' WHERE user_id=? AND budget_id=?"
            )
            .bind(users[0], body.data.id)
            .run()
        )
      );
      expect(overwrite._tag).toBe("Failure");
      expect(
        (yield* readBudgetCrossings(input)).map((crossing) =>
          encodeMoneyAmount(crossing.spent.amount)
        )
      ).toEqual(["110", "110"]);
    })
  ));

it("latches a backdated month and does not reopen it after a correction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload())))).status
      ).toBe(201);
      const previous = DateTime.makeUnsafe(DateTime.nowUnsafe().epochMilliseconds - 40 * 86400000);
      const priorPeriod = deriveCurrentBudgetMonth({
        now: previous,
        timeZone: IanaTimeZone.make("America/Bogota"),
      });
      const captured = yield* Effect.tryPromise(() =>
        send(
          db,
          request(0, "/transactions", "POST", {
            money: { amount: "100", currency: "COP" },
            direction: "outflow",
            categoryId: category,
            occurredAt: DateTime.formatIso(priorPeriod.from),
          })
        )
      );
      expect(captured.status).toBe(201);
      const first = yield* Schema.decodeUnknownEffect(Captured)(
        yield* Effect.tryPromise(() => captured.json())
      );
      const alerts = (): Promise<D1Result<{ threshold: number }>> =>
        db
          .prepare(
            "SELECT threshold FROM budget_threshold_alerts WHERE user_id = ? ORDER BY threshold"
          )
          .bind(users[0])
          .all<{ threshold: number }>();
      expect(
        (yield* Effect.tryPromise(() => alerts())).results.map((row) => row.threshold)
      ).toEqual([80, 100]);
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, `/transactions/${first.data.id}`, "PUT", {
              expectedRevision: 0,
              changes: { money: { amount: "1", currency: "COP" } },
            })
          )
        )).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() => alerts())).results.map((row) => row.threshold)
      ).toEqual([80, 100]);
    })
  ));

it(
  "blocks a correcting mutation until its versioned work backlog has drained",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        expect(
          (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload()))))
            .status
        ).toBe(201);
        const instant = DateTime.nowUnsafe();
        const created = yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/transactions", "POST", {
              money: { amount: "100", currency: "COP" },
              direction: "outflow",
              categoryId: category,
              occurredAt: DateTime.formatIso(instant),
            })
          )
        );
        expect(created.status).toBe(201);
        const transaction = yield* Schema.decodeUnknownEffect(Captured)(
          yield* Effect.tryPromise(() => created.json())
        );
        const earlier = DateTime.makeUnsafe(instant.epochMilliseconds - 40 * 86400000);
        const work = Array.from({ length: 9 }, (_, index) =>
          db
            .prepare(`INSERT INTO budget_reconciliation_work
    (user_id, occurred_at) VALUES (?, ?)`)
            .bind(
              users[0],
              DateTime.formatIso(DateTime.makeUnsafe(earlier.epochMilliseconds + index * 1000))
            )
        );
        yield* Effect.tryPromise(() => db.batch(work));
        const correction = (): Promise<Response> =>
          send(
            db,
            request(0, `/transactions/${transaction.data.id}`, "PUT", {
              expectedRevision: 0,
              changes: { money: { amount: "1", currency: "COP" } },
            })
          );
        expect((yield* Effect.tryPromise(() => correction())).status).toBe(503);
        const pending = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM budget_reconciliation_work WHERE user_id = ?")
            .bind(users[0])
            .first<{ count: number }>()
        );
        expect(pending?.count).toBe(8);
        const retryCount = 7;
        const refusals = yield* Effect.all(
          Array.from({ length: retryCount }, () => Effect.tryPromise(correction)),
          { concurrency: 2 }
        );
        expect(refusals.map((response) => response.status)).toEqual(Array(retryCount).fill(503));
        expect((yield* Effect.tryPromise(() => correction())).status).toBe(200);
        const alerts = yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT threshold FROM budget_threshold_alerts WHERE user_id = ? ORDER BY threshold"
            )
            .bind(users[0])
            .all<{ threshold: number }>()
        );
        expect(alerts.results.map((row) => row.threshold)).toEqual([80, 100]);
      })
    ),
  30000
);

it("denies read-scoped PAT writes and write-scoped PAT reads without disclosure or mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const readToken = `fin_${"r".repeat(8)}_${"a".repeat(43)}`;
      const writeToken = `fin_${"w".repeat(8)}_${"b".repeat(43)}`;
      yield* seedPAT(db, {
        token: readToken,
        scope: "read",
        id: "40000000-0000-4000-8000-000000000031",
      });
      yield* seedPAT(db, {
        token: writeToken,
        scope: "write",
        id: "40000000-0000-4000-8000-000000000032",
      });
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, patRequest(readToken, "/budgets", "POST", payload()))
        )).status
      ).toBe(403);
      const created = yield* Effect.tryPromise(() =>
        send(db, request(0, "/budgets", "POST", payload()))
      );
      expect(created.status).toBe(201);
      const owner = (yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => created.json())
      )).data;
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, patRequest(readToken, `/budgets/${owner.id}`, "DELETE"))
        )).status
      ).toBe(403);
      const denied = yield* Effect.tryPromise(() =>
        send(db, patRequest(writeToken, `/budgets/${owner.id}`))
      );
      expect(denied.status).toBe(403);
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, patRequest(writeToken, "/budget-status?timeZone=America%2FBogota"))
        )).status
      ).toBe(403);
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, `/budgets/${owner.id}`)))).status
      ).toBe(200);
      const count = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM budgets WHERE user_id = ?")
          .bind(users[0])
          .first<{ count: number }>()
      );
      expect(count?.count).toBe(1);
    })
  ));

it("keeps peer Budget cap and spending projections within one explicit User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      for (const index of [0, 1]) {
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, request(index, "/budgets", "POST", payload(index === 0 ? "100" : "200")))
          )).status
        ).toBe(201);
        expect(
          (yield* Effect.tryPromise(() =>
            send(
              db,
              request(index, "/transactions", "POST", {
                money: { amount: index === 0 ? "80.01" : "5.02", currency: "COP" },
                categoryId: category,
                direction: "outflow",
                occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
              })
            )
          )).status
        ).toBe(201);
      }
      const first = Option.getOrThrow(yield* readBudgetCaps({ db, userId: users[0] }));
      const second = Option.getOrThrow(yield* readBudgetCaps({ db, userId: users[1] }));
      expect(first.map((budget) => encodeMoneyAmount(budget.cap.amount))).toEqual(["100"]);
      expect(second.map((budget) => encodeMoneyAmount(budget.cap.amount))).toEqual(["200"]);
      expect(second.map((budget) => budget.id)).not.toEqual(first.map((budget) => budget.id));
      const read = (userId: string): Effect.Effect<Option.Option<BudgetStatusReport>> =>
        readBudgetSpending({
          db,
          userId,
          query: { timeZone: IanaTimeZone.make("America/Bogota") },
          now: DateTime.nowUnsafe(),
        });
      const firstReport = Option.getOrThrow(yield* read(users[0]));
      const secondReport = Option.getOrThrow(yield* read(users[1]));
      expect(firstReport.statuses.map((status) => encodeMoneyAmount(status.spent.amount))).toEqual([
        "80.01",
      ]);
      expect(secondReport.statuses.map((status) => encodeMoneyAmount(status.spent.amount))).toEqual(
        ["5.02"]
      );
    })
  ));

it("keeps read-only HTTP and hosted queries observational even with pending or invalid alert work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const token = `fin_${"r".repeat(8)}_${"a".repeat(43)}`;
      const patId = "40000000-0000-4000-8000-000000000033";
      yield* seedPAT(db, { token, scope: "read", id: patId });
      const budgetIds: Array<string> = [];
      for (const index of [0, 1]) {
        const response = yield* Effect.tryPromise(() =>
          send(db, request(index, "/budgets", "POST", payload()))
        );
        expect(response.status).toBe(201);
        const created = yield* Schema.decodeUnknownEffect(Created)(
          yield* Effect.tryPromise(() => response.json())
        );
        budgetIds.push(created.data.id);
        const occurredAt = DateTime.formatIso(DateTime.nowUnsafe());
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(`INSERT INTO transactions
              (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
              VALUES (?, ?, '80.01', 'COP', 'outflow', ?, ?, ?)`)
              .bind(
                `30000000-0000-4000-8000-00000000009${index}`,
                users[index],
                category,
                occurredAt,
                occurredAt
              ),
            db
              .prepare(
                "INSERT INTO budget_reconciliation_work (user_id, occurred_at) VALUES (?, 'zz-invalid')"
              )
              .bind(users[index]),
          ])
        );
      }
      const snapshot = (): Promise<ReadonlyArray<ReadonlyArray<unknown>>> =>
        Promise.all([
          db.prepare("SELECT * FROM budgets ORDER BY user_id, id").all(),
          db
            .prepare("SELECT * FROM budget_month_latches ORDER BY user_id, budget_id, from_utc")
            .all(),
          db
            .prepare(
              "SELECT * FROM budget_threshold_alerts ORDER BY user_id, budget_id, from_utc, threshold"
            )
            .all(),
          db
            .prepare("SELECT * FROM budget_reconciliation_work ORDER BY user_id, occurred_at")
            .all(),
        ]).then((results) => results.map((result) => result.results));
      const before = yield* Effect.tryPromise(snapshot);
      const subject = {
        userId: users[0],
        patId,
        digest: yield* Effect.tryPromise(() => digest(token)),
        requiredScope: Option.some("read" as const),
      };
      const queries = [
        { operation: "budgets.listBudgets", path: "/budgets", input: {} },
        {
          operation: "budgets.getBudget",
          path: `/budgets/${budgetIds[0]}`,
          input: { params: { id: budgetIds[0] } },
        },
        {
          operation: "budgets.getBudgetStatus",
          path: "/budget-status?timeZone=America%2FBogota",
          input: { query: { timeZone: "America/Bogota" } },
        },
        { operation: "transactions.listTransactions", path: "/transactions", input: {} },
      ];
      for (const query of queries) {
        const http = yield* Effect.tryPromise(() => send(db, patRequest(token, query.path)));
        expect(http.status).toBe(200);
        expect(yield* Effect.tryPromise(snapshot)).toEqual(before);
        const hosted = yield* executeCanonicalWork({
          db,
          subject,
          current: DateTime.nowUnsafe().epochMilliseconds,
          bucket: Option.none(),
          hostedFence: Option.none(),
          inference: Option.none(),
          work: {
            _tag: "Call",
            operation: CanonicalOperationId.make(query.operation),
            input: query.input,
          },
        });
        expect(hosted.status).toBe(200);
        expect(yield* Effect.tryPromise(snapshot)).toEqual(before);
      }
      expect(
        (yield* Effect.tryPromise(() => send(db, patRequest(token, `/budgets/${budgetIds[1]}`))))
          .status
      ).toBe(404);
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, patRequest(token, "/budget-status?timeZone=invalid"))
        )).status
      ).toBe(400);
      expect(yield* Effect.tryPromise(snapshot)).toEqual(before);
      // A failed retained-state decode also cannot perform or consume pending alert work.
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE budgets SET cap = 'invalid' WHERE user_id = ?").bind(users[0]).run()
      );
      const corrupted = yield* Effect.tryPromise(snapshot);
      expect((yield* Effect.tryPromise(() => send(db, patRequest(token, "/budgets")))).status).toBe(
        503
      );
      const failure = yield* executeCanonicalWork({
        db,
        subject,
        current: DateTime.nowUnsafe().epochMilliseconds,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("budgets.listBudgets"),
          input: {},
        },
      });
      expect(failure.status).toBe(503);
      expect(yield* Effect.tryPromise(snapshot)).toEqual(corrupted);
      const audit = yield* Effect.tryPromise(() =>
        db.prepare("SELECT operation FROM pat_audit WHERE pat_id = ?").bind(patId).all()
      );
      expect(audit.results.length).toBeGreaterThanOrEqual(8);
    })
  ));

it("does not drain another User's pending Budget alerts from a non-request evaluation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload())))).status
      ).toBe(201);
      const occurredAt = DateTime.formatIso(DateTime.nowUnsafe());
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO transactions
        (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
        VALUES ('30000000-0000-4000-8000-000000000099', ?, '80.01', 'COP', 'outflow', ?, ?, ?)`)
          .bind(users[0], category, occurredAt, occurredAt)
          .run()
      );
      expect(yield* evaluateBudgetAlerts({ db, userId: users[1] })).toBe(true);
      const thresholds = (): Promise<D1Result<{ threshold: number }>> =>
        db
          .prepare(
            "SELECT threshold FROM budget_threshold_alerts WHERE user_id = ? ORDER BY threshold"
          )
          .bind(users[0])
          .all<{ threshold: number }>();
      expect((yield* Effect.tryPromise(thresholds)).results).toEqual([]);
      expect(yield* evaluateBudgetAlerts({ db, userId: users[0] })).toBe(true);
      expect((yield* Effect.tryPromise(thresholds)).results.map((row) => row.threshold)).toEqual([
        80,
      ]);
      expect(yield* evaluateBudgetAlerts({ db, userId: users[1] })).toBe(true);
      expect((yield* Effect.tryPromise(thresholds)).results.map((row) => row.threshold)).toEqual([
        80,
      ]);
    })
  ));
