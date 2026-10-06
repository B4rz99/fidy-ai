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
  findCurrentProactivityOffer,
  findProactivityConsentGrant,
  recordProactivityConsentDisclosure,
} from "../consent/operations";
import {
  makeExecutingWeeklyFixtureStep,
  makeProactivityCoordinator,
  proactivityWorkflowHarness,
} from "../weekly-summary.test-fixture";
import type { WorkflowStep } from "cloudflare:workers";
import type { ProactivityDeliveryWork } from "../insights/contract";
import { WhatsAppStatusAdmission } from "../whatsapp/contract";
import { findInsightRecipient, prepareInsightRecipient } from "../whatsapp/operations";
import {
  HostedDeliveryCorrelationToken,
  ProactivityTemplateConfiguration,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { readProactiveMessageTranscript, readProactiveTranscript } from "../agent/operations";
import { InsightEventId } from "../../src/core/insights/contract";
import { FetchHttpClient } from "effect/http";
import { executeProactivityWork } from "../insights/runtime";
import { findProactivityReport, recordProactivityDecision } from "../insights/operations";
import { type ConsentRecordId, DisclosureSnapshot } from "../../src/core/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { executeCanonicalWork } from "../canonical-operations/operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import {
  canonicalAdmissionMigrationNames,
  hostedTurnTestMigrations,
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
      "0002_resource_admission",
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
      "0017_hosted_compaction",
      "0037_budget_crossing_facts",
      "0038_proactivity_consent",
      "0042_budget_proactivity",
      "0039_reminder_schedules",
      "0041_proactivity_messages",
      "0044_proactivity_channel",
      "0032_proactive_transcript",
      "0045_budget_messages_transcript",
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
      ...hostedTurnTestMigrations,
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
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
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

it.each([
  { label: "after hours", createdAt: "2026-10-07T01:00:00Z", unstarted: false },
  { label: "near closing", createdAt: "2026-10-06T23:59:00Z", unstarted: true },
  { label: "before a delayed Queue execution", createdAt: "2026-10-06T17:00:00Z", unstarted: true },
])(
  "a first Budget created $label retains a recoverable opt-in request until visible disclosure",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const night = DateTime.makeUnsafe(scenario.createdAt);
        vi.setSystemTime(night.epochMilliseconds);
        const db = yield* setup();
        expect(
          (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload()))))
            .status
        ).toBe(201);
        const userId = UserId.make(users[0]);
        const caller = WhatsAppCallerReference.make({
          businessPortfolioId: WhatsAppBusinessPortfolioId.make("123456789"),
          businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.budgetuser"),
        });
        yield* seedCrossingConsent(db);
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO whatsapp_identities(user_id,portfolio_id,bsuid,verified_at_ms) VALUES(?,?,?,?)"
            )
            .bind(
              userId,
              caller.businessPortfolioId,
              caller.businessScopedUserId,
              night.epochMilliseconds
            )
            .run()
        );
        const phone = WhatsAppBusinessPhoneNumberId.make("123456789");
        yield* Effect.tryPromise(() =>
          db.batch([
            prepareInsightRecipient({
              db,
              userId,
              recipient: {
                portfolioId: caller.businessPortfolioId,
                bsuid: caller.businessScopedUserId,
                businessPhoneNumberId: phone,
              },
              receivedAtMs: night.epochMilliseconds,
            }),
          ])
        );
        const environment = {
          DB: db,
          PROACTIVITY_ENABLED: "enabled",
          KAPSO_API_KEY: "test-only",
          PROACTIVITY_TEMPLATE_JSON: yield* Schema.encodeEffect(
            Schema.fromJsonString(ProactivityTemplateConfiguration)
          )({
            name: "fidy_proactivity",
            language: "es",
            approval: "approved",
            body: "Fidy: {{1}}",
          }),
        };
        const harness = proactivityWorkflowHarness({
          environment,
          userId,
          otherUserIds: [],
          unavailableUserIds: [],
        });
        yield* Effect.exit(harness.sweep());
        const prior = yield* findCurrentProactivityOffer({
          db,
          userId,
          caller,
          kind: "budget-threshold",
          now: night,
        });
        expect(Option.isSome(prior)).toBe(scenario.unstarted);
        if (Option.isSome(prior)) {
          const delayed = DateTime.makeUnsafe(night.epochMilliseconds + 660000);
          vi.setSystemTime(delayed.epochMilliseconds);
          yield* executeProactivityWork({
            environment,
            userId,
            now: delayed,
            work: { kind: "proactivity-delivery", version: 1, userId, id: prior.value.id },
          });
          expect(
            yield* Effect.tryPromise(() =>
              db
                .prepare("SELECT state FROM proactivity_outbox WHERE user_id=? AND delivery_id=?")
                .bind(userId, prior.value.id)
                .first()
            )
          ).toEqual({ state: "expired" });
        }
        if (!scenario.unstarted) {
          for (let attempt = 1; attempt <= 36; attempt += 1) {
            vi.setSystemTime(night.epochMilliseconds + attempt * 60000);
            yield* Effect.exit(harness.sweep());
          }
        }
        const morning = DateTime.makeUnsafe("2026-10-07T14:00:00Z");
        vi.setSystemTime(morning.epochMilliseconds);
        yield* Effect.exit(harness.sweep());
        const offer = Option.getOrThrow(
          yield* findCurrentProactivityOffer({
            db,
            userId,
            caller,
            kind: "budget-threshold",
            now: morning,
          })
        );
        expect(offer.expiresAt.epochMilliseconds).toBe(morning.epochMilliseconds + 600000);
        if (Option.isSome(prior)) expect(offer.id).not.toBe(prior.value.id);
        expect(
          Option.isNone(
            yield* findProactivityConsentGrant({ db, userId, kind: "budget-threshold" })
          )
        ).toBe(true);
        const coordinator = makeProactivityCoordinator({ environment, userId });
        const provider = vi.fn(() =>
          Promise.resolve(
            Response.json({
              messaging_product: "whatsapp",
              messages: [{ id: "morning-budget-offer" }],
            })
          )
        );
        vi.stubGlobal("fetch", provider);
        yield* executeProactivityWork({
          environment,
          userId,
          now: morning,
          work: { kind: "proactivity-delivery", version: 1, userId, id: offer.id },
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
        const claim = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ correlation_token: HostedDeliveryCorrelationToken })
        )(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT correlation_token FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
              )
              .bind(userId, offer.id)
              .first()
          )
        );
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(WhatsAppStatusAdmission))({
          userId,
          correlationToken: claim.correlation_token,
          businessPhoneNumberId: phone,
          providerMessageId: WhatsAppProviderMessageId.make("morning-budget-offer"),
          outcome: "delivered",
          occurredAtMs: morning.epochMilliseconds,
          receivedAtMs: morning.epochMilliseconds,
        });
        expect(
          (yield* Effect.tryPromise(() =>
            coordinator.fetch(
              new Request("https://coordinator/hosted-turn/whatsapp/status", {
                method: "POST",
                body,
              })
            )
          )).status
        ).toBe(200);
        expect(
          Option.getOrThrow(
            yield* readProactiveMessageTranscript({
              db,
              userId,
              id: offer.id,
              now: morning.epochMilliseconds,
            })
          ).text
        ).toBe(`Fidy: ${offer.disclosure.text}\n${offer.acceptChoice}\n${offer.declineChoice}`);
        expect(provider).toHaveBeenCalledOnce();
      })
    )
);

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

it("installed category generation atomically materializes two Budget events and one frozen delivery intent", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        vi.spyOn(Date, "now").mockReturnValue(
          DateTime.makeUnsafe("2026-10-06T17:00:00Z").epochMilliseconds
        );
        const db = yield* setup();
        yield* seedCrossingConsent(db);
        expect(
          (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload()))))
            .status
        ).toBe(201);
        yield* grantBudgetDelivery(db);
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
        const userId = UserId.make(users[0]);
        const group = Option.getOrThrow(
          EffectArray.head(yield* readBudgetCrossingGroups({ db, userId }))
        );
        const work = { kind: "proactivity-generate" as const, version: 1 as const, userId };
        yield* executeProactivityWork({
          environment: { DB: db, PROACTIVITY_ENABLED: "enabled" },
          userId,
          now: yield* DateTime.now,
          work,
        });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT count(*) AS n FROM insight_events WHERE user_id=? AND kind='budget-threshold'"
              )
              .bind(userId)
              .first()
          )
        ).toEqual({ n: 2 });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT count(*) AS n FROM proactivity_outbox WHERE user_id=?")
              .bind(userId)
              .first()
          )
        ).toEqual({ n: 1 });
        expect(yield* readBudgetCrossingGroups({ db, userId })).toEqual([]);
        const now = yield* DateTime.now;
        const phone = WhatsAppBusinessPhoneNumberId.make("123456789");
        yield* Effect.tryPromise(() =>
          db.batch([
            prepareInsightRecipient({
              db,
              userId,
              recipient: {
                portfolioId: WhatsAppBusinessPortfolioId.make("123456789"),
                bsuid: WhatsAppBusinessScopedUserId.make("CO.budgetuser"),
                businessPhoneNumberId: phone,
              },
              receivedAtMs: now.epochMilliseconds,
            }),
          ])
        );
        expect(Option.isSome(yield* findInsightRecipient({ db, userId }))).toBe(true);
        expect(Option.isSome(yield* findProactivityReport({ db, userId, id: group.id }))).toBe(
          true
        );
        const provider = vi.fn(() =>
          Promise.resolve(
            Response.json({ messaging_product: "whatsapp", messages: [{ id: "budget-provider" }] })
          )
        );
        vi.stubGlobal("fetch", provider);
        const environment = {
          DB: db,
          PROACTIVITY_ENABLED: "enabled",
          KAPSO_API_KEY: "test-key",
          PROACTIVITY_TEMPLATE_JSON:
            '{"name":"fidy_proactivity","language":"es","body":"Fidy: {{1}}","approval":"approved"}',
        };
        yield* executeProactivityWork({
          environment,
          userId,
          now,
          work: { kind: "proactivity-delivery", version: 1, userId, id: group.id },
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
        expect(provider).toHaveBeenCalledOnce();
        const claim = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ correlation_token: HostedDeliveryCorrelationToken })
        )(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT correlation_token FROM proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
              )
              .bind(userId, group.id)
              .first()
          )
        );
        const coordinator = makeProactivityCoordinator({ environment, userId });
        const status = (): Request =>
          new Request("https://coordinator/hosted-turn/whatsapp/status", {
            method: "POST",
            body: Schema.encodeSync(Schema.fromJsonString(WhatsAppStatusAdmission))({
              userId,
              correlationToken: claim.correlation_token,
              businessPhoneNumberId: phone,
              providerMessageId: WhatsAppProviderMessageId.make("budget-provider"),
              outcome: "delivered",
              occurredAtMs: now.epochMilliseconds,
              receivedAtMs: now.epochMilliseconds,
            }),
          });
        expect((yield* Effect.tryPromise(() => coordinator.fetch(status()))).status).toBe(200);
        expect((yield* Effect.tryPromise(() => coordinator.fetch(status()))).status).toBe(200);
        const events = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({ id: InsightEventId, lifecycle_state: Schema.Literal("delivered") })
          )
        )(
          (yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT id,lifecycle_state FROM insight_events WHERE user_id=? AND kind='budget-threshold'"
              )
              .bind(userId)
              .all()
          )).results
        );
        expect(events).toHaveLength(2);
        const transcripts = yield* Effect.forEach(events, (event) =>
          readProactiveTranscript({
            db,
            userId,
            insightEventId: event.id,
            now: now.epochMilliseconds,
          })
        );
        const first = Option.getOrThrow(Option.getOrThrow(EffectArray.head(transcripts)));
        expect(Option.getOrThrow(Option.getOrThrow(EffectArray.last(transcripts))).id).toBe(
          first.id
        );
        expect(first.text).toContain("80% y 100%");
        expect(first.text).toContain("110 COP");
        expect(provider).toHaveBeenCalledOnce();
        yield* executeProactivityWork({
          environment: { DB: db, PROACTIVITY_ENABLED: "enabled" },
          userId,
          now: yield* DateTime.now,
          work,
        });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT count(*) AS n FROM proactivity_outbox WHERE user_id=?")
              .bind(userId)
              .first()
          )
        ).toEqual({ n: 1 });
      })
    )
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
      yield* grantBudgetDelivery(db);
      const recovery = proactivityWorkflowHarness({
        environment: { DB: db, PROACTIVITY_ENABLED: "enabled" },
        userId: UserId.make(users[0]),
        otherUserIds: [],
        unavailableUserIds: [],
      });
      yield* Effect.exit(recovery.sweep());
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
      yield* Effect.exit(recovery.sweep());
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

it("category Queue-to-Workflow redelivery rejects another User's frozen Budget message without provider effects or partial settlement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.setSystemTime(DateTime.makeUnsafe("2026-10-06T17:00:00Z").epochMilliseconds);
      const db = yield* setup();
      yield* seedCrossingConsent(db);
      yield* grantBudgetDelivery(db);
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload())))).status
      ).toBe(201);
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
      const userId = UserId.make(users[0]);
      const group = (yield* readBudgetCrossingGroups({ db, userId }))[0];
      if (group === undefined) return yield* Effect.die("Expected Budget crossings");
      const environment = { DB: db, PROACTIVITY_ENABLED: "enabled" };
      yield* executeProactivityWork({
        environment,
        userId,
        now: yield* DateTime.now,
        work: { kind: "proactivity-generate", version: 1, userId },
      });
      const report = Option.getOrThrow(yield* findProactivityReport({ db, userId, id: group.id }));
      expect(Option.getOrThrow(report.text)).toContain("110 COP");
      const snapshot = (): Effect.Effect<
        ReadonlyArray<ReadonlyArray<unknown>>,
        Cause.UnknownError
      > =>
        Effect.forEach(
          [
            "proactivity_reports",
            "proactivity_whatsapp_claims",
            "proactivity_outbox",
            "insight_events",
            "reminder_governors",
            "proactivity_consent_offers",
            "proactivity_consent_records",
            "proactive_transcript_entries",
            "proactive_message_transcript_entries",
          ],
          (table) =>
            Effect.tryPromise(() => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).pipe(
              Effect.map((result) => result.results)
            )
        );
      const before = yield* snapshot();
      const provider = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error("Forbidden provider IO"));
      vi.stubGlobal("fetch", provider);
      const unexpected = (): Promise<never> =>
        Promise.reject(new Error("Unexpected infrastructure authority"));
      const instance: WorkflowInstance = {
        id: "foreign-category",
        pause: unexpected,
        resume: unexpected,
        terminate: unexpected,
        restart: unexpected,
        delete: unexpected,
        sendEvent: unexpected,
        subscribe: unexpected,
        status: () => Promise.resolve({ status: "running" }),
      };
      const create = vi
        .fn<Workflow<ProactivityDeliveryWork>["create"]>()
        .mockResolvedValue(instance);
      const binding: Workflow<ProactivityDeliveryWork> = {
        create,
        get: unexpected,
        createBatch: unexpected,
        deleteBatch: unexpected,
      };
      const harness = proactivityWorkflowHarness({
        environment,
        userId,
        otherUserIds: [UserId.make(users[1])],
        unavailableUserIds: [],
      });
      const work: ProactivityDeliveryWork = {
        kind: "proactivity-delivery",
        version: 1,
        userId: UserId.make(users[1]),
        id: group.id,
      };
      const step: WorkflowStep = {
        do: makeExecutingWeeklyFixtureStep(),
        sleep: unexpected,
        sleepUntil: unexpected,
        waitForEvent: unexpected,
      };
      for (const attempt of [1, 2]) {
        const message = { body: work, ack: vi.fn(), retry: vi.fn() };
        yield* harness.receive({ messages: [message], workflow: Option.some(binding) });
        expect(message.ack).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledTimes(attempt);
        expect(
          (yield* Effect.exit(Effect.tryPromise(() => harness.execute({ work, step }))))._tag
        ).toBe("Failure");
        expect(provider).not.toHaveBeenCalled();
        expect(yield* snapshot()).toEqual(before);
      }
    })
  ));

it("accepting Budget opt-in drains pre-opt-in reconciliation as ineligible even after the financial post-commit evaluation failed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* seedCrossingConsent(db);
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/budgets", "POST", payload())))).status
      ).toBe(201);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER reject_pre_opt_in_crossing BEFORE INSERT ON budget_threshold_alerts WHEN NEW.threshold=100 BEGIN SELECT RAISE(ABORT,'test_crossing_refusal'); END"
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
      const userId = UserId.make(users[0]);
      expect(yield* readBudgetCrossingGroups({ db, userId })).toEqual([]);
      const caller = WhatsAppCallerReference.make({
        businessPortfolioId: WhatsAppBusinessPortfolioId.make("123456789"),
        businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.budgetuser"),
      });
      const now = yield* DateTime.now;
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO whatsapp_identities(user_id,portfolio_id,bsuid,verified_at_ms) VALUES(?,?,?,?)"
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
          disclosureMessageId: "delayed-crossing-offer",
        })
      ).toBe(true);
      const choice = {
        ...context,
        choice: offer.acceptChoice,
        decisionMessageId: "delayed-crossing-accept",
      };
      expect(yield* recordProactivityDecision(choice)).toBe(false);
      expect(Option.isNone(yield* findProactivityConsentGrant(context))).toBe(true);
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER reject_pre_opt_in_crossing").run());
      expect(yield* recordProactivityDecision(choice)).toBe(true);
      const groups = yield* readBudgetCrossingGroups({ db, userId });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.grantId).toEqual(Option.none());
      expect(groups[0]?.crossings.map((crossing) => crossing.threshold)).toEqual([80, 100]);
      const recovery = proactivityWorkflowHarness({
        environment: { DB: db, PROACTIVITY_ENABLED: "enabled" },
        userId,
        otherUserIds: [],
        unavailableUserIds: [],
      });
      yield* Effect.exit(recovery.sweep());
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS n FROM proactivity_reports WHERE user_id=? AND role='budget-threshold'"
            )
            .bind(userId)
            .first()
        )
      ).toEqual({ n: 0 });
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
