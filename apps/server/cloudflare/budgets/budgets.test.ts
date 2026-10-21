import { type ConsentUnavailable } from "../consent/contract";
import { type InsightUnavailable, type ProactivityDeliveryWork } from "../insights/contract";
import { type WorkflowStep } from "cloudflare:workers";
import { type ConsentRecordId, DisclosureSnapshot } from "../../src/core/consent/contract";
import { type Cause, DateTime, Effect, Array as EffectArray, Option, Schema } from "effect";
import {
  evaluateBudgetAlerts,
  prepareDeleteBudget,
  prepareUpdateBudget,
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
import { WhatsAppStatusAdmission } from "../whatsapp/contract";
import { findInsightRecipient, prepareInsightRecipient } from "../whatsapp/operations";
import {
  HostedDeliveryCorrelationToken,
  ProactivityTemplateConfiguration,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { readProactiveMessageTranscript } from "../agent/operations";
import { InsightEventId } from "../../src/core/insights/contract";
import { FetchHttpClient } from "effect/http";
import { executeProactivityWork } from "../insights/runtime";
import {
  findProactivityReport,
  readProactiveTranscript,
  recordProactivityDecision,
} from "../insights/operations";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { executeCanonicalWork } from "../canonical-operations/operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Budget,
  BudgetId,
  BudgetStatusReport,
  UpdateBudgetInput,
} from "../../src/core/budgets/contract";
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
const sessions = [
  "10000000-0000-4000-8000-000000000061",
  "10000000-0000-4000-8000-000000000062",
] as const;
const databases = isolatedTestDatabases();
const bearer = (index: number): string => String(index + 1).repeat(43);
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));

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

    yield* Effect.tryPromise(() => installTestSchema({ db }));
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
                    {
                      id: { name },
                      storage: {
                        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> =>
                          Promise.resolve(null),
                        deleteAlarm: (): Promise<void> => Promise.resolve(),
                        setAlarm: (): Promise<void> => Promise.resolve(),
                      },
                    },
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
          WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
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
      "Fidy-Session-Binding": sessions[index] ?? "invalid",
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
              "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES(?,?,?,?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
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
          WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
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
                .prepare(
                  "SELECT state FROM (SELECT rowid,user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM insight_reports WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='proactivity-delivery' AND user_id=? AND delivery_id=?"
                )
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
                "SELECT correlation_token FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='proactivity') AS proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
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

it("reports corrupt retained Budget state as unavailable without false caller refusal or mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() =>
          send(db, request(0, "/budgets", "POST", payload())).then((response) => response.json())
        )
      );
      const id = created.data.id;
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE budgets SET cap='1e2' WHERE user_id=? AND id=?").bind(users[0], id).run()
      );
      const subject = {
        id: sessions[0],
        userId: users[0],
        digest: yield* Effect.tryPromise(() => digest(bearer(0))),
      };
      const current = DateTime.nowUnsafe().epochMilliseconds;
      expect(
        yield* prepareUpdateBudget({
          db,
          subject,
          id,
          current,
          payload: yield* Schema.decodeUnknownEffect(Schema.toCodecJson(UpdateBudgetInput))(
            payload()
          ),
        })
      ).toEqual({ _tag: "Failed" });
      expect(yield* prepareDeleteBudget({ db, subject, id, current })).toEqual({ _tag: "Failed" });
      for (const method of ["PUT", "DELETE"] as const) {
        const response = yield* Effect.tryPromise(() =>
          send(db, request(0, `/budgets/${id}`, method, method === "PUT" ? payload() : undefined))
        );
        expect(response.status).toBe(503);
      }
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT cap FROM budgets WHERE user_id=? AND id=?").bind(users[0], id).first()
        )
      ).toEqual({ cap: "1e2" });
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT operation FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'budgets.*' AND user_id=? AND outcome='rejected'"
            )
            .bind(users[0])
            .all()
        )).results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() => send(db, request(1, `/budgets/${id}`, "DELETE")))).status
      ).toBe(404);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE budgets SET cap='100' WHERE user_id=? AND id=?").bind(users[0], id).run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE budgets SET created_at='not-a-date' WHERE user_id=? AND id=?")
          .bind(users[0], id)
          .run()
      );
      expect(yield* prepareDeleteBudget({ db, subject, id, current })).toEqual({ _tag: "Failed" });
      const missing = yield* prepareDeleteBudget({
        db,
        subject,
        current,
        id: BudgetId.make("11111111-1111-4111-8111-111111111111"),
      });
      expect(missing._tag).toBe("Refused");
      if (missing._tag === "Refused") expect(missing.refusal.code).toBe("not_found");
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
        db
          .prepare("DELETE FROM budget_state WHERE kind='work' AND user_id = ?")
          .bind(users[0])
          .run()
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
          db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'budgets.*'"
            )
            .first<{ count: number }>()
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
            .prepare(
              "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'budgets.*' AND outcome = 'accepted'"
            )
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'budgets.*' AND outcome = 'rejected'"
            )
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
            .prepare(
              "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'budgets.*' AND outcome = 'rejected'"
            )
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

it("combines Category and Currency filters without including other Budgets or Users", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const otherCategory = "10000000-0000-4000-8000-000000000001";
      for (const { categoryId, currency } of [
        { categoryId: category, currency: "COP" },
        { categoryId: category, currency: "USD" },
        { categoryId: otherCategory, currency: "COP" },
      ]) {
        expect(
          (yield* Effect.tryPromise(() =>
            send(
              db,
              request(0, "/budgets", "POST", {
                categoryId,
                cap: { amount: "100", currency },
              })
            )
          )).status
        ).toBe(201);
      }
      const foreign = yield* Effect.tryPromise(() =>
        send(db, request(1, "/budgets", "POST", payload()))
      );
      expect(foreign.status).toBe(201);
      const foreignBudget = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => foreign.json())
      );
      for (const selection of [
        { query: `categoryId=${category}`, expected: [`${category}:COP`, `${category}:USD`] },
        { query: "currency=COP", expected: [`${category}:COP`, `${otherCategory}:COP`] },
        { query: `categoryId=${category}&currency=COP`, expected: [`${category}:COP`] },
        { query: `categoryId=${otherCategory}&currency=USD`, expected: [] },
      ]) {
        const response = yield* Effect.tryPromise(() =>
          send(db, request(0, `/budget-status?timeZone=America%2FBogota&${selection.query}`))
        );
        expect(response.status).toBe(200);
        const report = yield* Schema.decodeUnknownEffect(Report)(
          yield* Effect.tryPromise(() => response.json())
        );
        expect(report.data.statuses.map(({ budget }) => budget.id)).not.toContain(
          foreignBudget.data.id
        );
        expect(
          report.data.statuses
            .map(({ budget }) => `${budget.categoryId}:${budget.cap.currency}`)
            .sort()
        ).toEqual(selection.expected.toSorted());
      }
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
            "SELECT operation, outcome FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'budgets.*' AND user_id = ? ORDER BY operation"
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
          .prepare(
            `SELECT operation FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'budgets.*' AND user_id = ? AND outcome = 'rejected' ORDER BY operation`
          )
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
  "returns complete exact spending for multiple Budgets in the first request",
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
              "INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES ('processing_grant',?,?,?,'disclosed','accepted',0,0)"
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
          "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES(?,?,?,?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms WHERE users.whatsapp_portfolio_id IS NULL"
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
              .prepare(
                "SELECT count(*) AS n FROM (SELECT rowid,user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM insight_reports WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='proactivity-delivery' AND user_id=?"
              )
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
          WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
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
                "SELECT correlation_token FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='proactivity') AS proactivity_whatsapp_claims WHERE user_id=? AND delivery_id=?"
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
              .prepare(
                "SELECT count(*) AS n FROM (SELECT rowid,user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM insight_reports WHERE dispatch_state IS NOT NULL) AS proactivity_delivery_outbox WHERE kind='proactivity-delivery' AND user_id=?"
              )
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
      const environment = {
        DB: db,
        PROACTIVITY_ENABLED: "enabled",
        KAPSO_API_KEY: "test-only",
        WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
        PROACTIVITY_TEMPLATE_JSON: yield* Schema.encodeEffect(
          Schema.fromJsonString(ProactivityTemplateConfiguration)
        )({ name: "fidy_proactivity", language: "es", approval: "approved", body: "Fidy: {{1}}" }),
      };
      yield* executeProactivityWork({
        environment,
        userId,
        now: yield* DateTime.now,
        work: { kind: "proactivity-generate", version: 1, userId },
      });
      const report = Option.getOrThrow(yield* findProactivityReport({ db, userId, id: group.id }));
      expect(Option.getOrThrow(report.text)).toContain("110 COP");
      yield* Effect.tryPromise(() =>
        db.batch([
          prepareInsightRecipient({
            db,
            userId,
            recipient: {
              portfolioId: WhatsAppBusinessPortfolioId.make("123456789"),
              bsuid: WhatsAppBusinessScopedUserId.make("CO.budgetuser"),
              businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
            },
            receivedAtMs: DateTime.nowUnsafe().epochMilliseconds,
          }),
        ])
      );
      const snapshot = (): Effect.Effect<
        ReadonlyArray<ReadonlyArray<unknown>>,
        Cause.UnknownError
      > =>
        Effect.forEach(
          [
            "insight_reports",
            "whatsapp_deliveries",
            "(SELECT rowid,user_id,kind,delivery_id,dispatch_state AS state,dispatch_created_at_ms AS created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM insight_reports WHERE dispatch_state IS NOT NULL)",
            "insight_events",
            "proactivity_governors",
            "consent_offers",
            "consent_history",
            "proactive_transcript_entries",
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
      provider.mockResolvedValueOnce(
        Response.json({
          messaging_product: "whatsapp",
          messages: [{ id: "same-user-category-control" }],
        })
      );
      const ownWork = { ...work, userId };
      const message = { body: ownWork, ack: vi.fn(), retry: vi.fn() };
      yield* harness.receive({ messages: [message], workflow: Option.some(binding) });
      expect(message.ack).toHaveBeenCalledOnce();
      expect(
        (yield* Effect.exit(Effect.tryPromise(() => harness.execute({ work: ownWork, step }))))._tag
      ).toBe("Success");
      expect(provider).toHaveBeenCalledOnce();
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
            "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES(?,?,?,?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
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
              "SELECT count(*) AS n FROM insight_reports WHERE kind='proactivity-delivery' AND scheduled_at_ms IS NOT NULL AND user_id=? AND role='budget-threshold'"
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
            .prepare(`INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',?, ?)`)
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
            .prepare(
              "SELECT COUNT(*) AS count FROM (SELECT rowid,user_id,occurred_at,version,last_evaluated_at_ms FROM budget_state WHERE kind='work') AS budget_reconciliation_work WHERE user_id = ?"
            )
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
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/transactions", "POST", {
              money: { amount: "250.12", currency: "USD" },
              categoryId: category,
              direction: "inflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            })
          )
        )).status
      ).toBe(201);
      const firstReport = Option.getOrThrow(yield* read(users[0]));
      const secondReport = Option.getOrThrow(yield* read(users[1]));
      expect(
        firstReport.cashFlow.income.map((money) => [
          money.currency,
          encodeMoneyAmount(money.amount),
        ])
      ).toEqual([["USD", "250.12"]]);
      expect(firstReport.cashFlow.expenses.map((money) => encodeMoneyAmount(money.amount))).toEqual(
        ["80.01"]
      );
      expect(secondReport.cashFlow.income).toEqual([]);
      expect(
        secondReport.cashFlow.expenses.map((money) => encodeMoneyAmount(money.amount))
      ).toEqual(["5.02"]);

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
                "INSERT INTO budget_state(kind,user_id, occurred_at) VALUES('work',?, 'zz-invalid')"
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
            .prepare(
              "SELECT * FROM (SELECT user_id,occurred_at,version,last_evaluated_at_ms FROM budget_state WHERE kind='work') AS budget_reconciliation_work ORDER BY user_id, occurred_at"
            )
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
          oauthConfirmation: Option.none(),
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
        oauthConfirmation: Option.none(),
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
        db
          .prepare(
            "SELECT operation FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE pat_id = ?"
          )
          .bind(patId)
          .all()
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

it(
  "freezes monthly plans, inherits forward without rollover, and isolates owners",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const response = yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/budgets", "POST", { ...payload(), month: "2026-10", groupName: "Hogar" })
          )
        );
        expect(response.status).toBe(201);
        const created = yield* Schema.decodeUnknownEffect(Created)(
          yield* Effect.tryPromise(() => response.json())
        );
        const report = (
          month: string,
          owner = 0
        ): Effect.Effect<BudgetStatusReport, Cause.UnknownError | Schema.SchemaError> =>
          Effect.gen(function* () {
            const res = yield* Effect.tryPromise(() =>
              send(db, request(owner, `/budget-status?timeZone=America%2FBogota&month=${month}`))
            );
            expect(res.status).toBe(200);
            return (yield* Schema.decodeUnknownEffect(Report)(
              yield* Effect.tryPromise(() => res.json())
            )).data;
          });
        const preview = yield* report("2026-11");
        expect(preview.initialized).toBe(false);
        expect(
          encodeMoneyAmount(Option.getOrThrow(EffectArray.head(preview.statuses)).budget.cap.amount)
        ).toBe("100");
        for (const [month, cap] of [
          ["2026-11", "200"],
          ["2026-10", "50"],
        ]) {
          const saved = yield* Effect.tryPromise(() =>
            send(db, request(0, `/budgets/${created.data.id}`, "PUT", { ...payload(cap), month }))
          );
          expect(saved.status).toBe(200);
          expect(
            encodeMoneyAmount(
              (yield* Schema.decodeUnknownEffect(Created)(
                yield* Effect.tryPromise(() => saved.json())
              )).data.cap.amount
            )
          ).toBe(cap);
        }
        expect(
          encodeMoneyAmount(
            Option.getOrThrow(EffectArray.head((yield* report("2026-10")).statuses)).budget.cap
              .amount
          )
        ).toBe("50");
        const november = yield* report("2026-11");
        expect(november.initialized).toBe(true);
        expect(
          encodeMoneyAmount(
            Option.getOrThrow(EffectArray.head(november.statuses)).budget.cap.amount
          )
        ).toBe("200");
        expect(
          encodeMoneyAmount(
            Option.getOrThrow(EffectArray.head((yield* report("2026-12")).statuses)).budget.cap
              .amount
          )
        ).toBe("200");
        expect((yield* report("2026-09")).statuses).toEqual([]);
        expect((yield* report("2026-11", 1)).statuses).toEqual([]);
        const renamed = yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, `/budgets/${created.data.id}`, "PUT", {
              ...payload("200"),
              month: "2026-11",
              groupName: "Casa",
              groupCategoryIds: [category],
            })
          )
        );
        expect(renamed.status).toBe(200);
        expect(
          Option.getOrThrow(EffectArray.head((yield* report("2026-10")).statuses)).budget.groupName
        ).toBe("Casa");
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, request(0, "/budget-status?timeZone=America%2FBogota&month=2026-13"))
          )).status
        ).toBe(400);
      })
    ),
  30000
);

it(
  "keeps one currency per owned group and rolls back an unconfirmed month",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const first = yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/budgets", "POST", { ...payload(), month: "2026-10", groupName: "Hogar" })
          )
        );
        const created = yield* Schema.decodeUnknownEffect(Created)(
          yield* Effect.tryPromise(() => first.json())
        );
        expect(
          (yield* Effect.tryPromise(() =>
            send(
              db,
              request(0, "/budgets", "POST", {
                categoryId: category,
                cap: { amount: "50", currency: "USD" },
                month: "2026-10",
                groupName: "Hogar",
              })
            )
          )).status
        ).toBe(400);
        expect(
          (yield* Effect.tryPromise(() =>
            send(
              db,
              request(1, "/budgets", "POST", { ...payload(), month: "2026-10", groupName: "Ajeno" })
            )
          )).status
        ).toBe(201);
        const edit = {
          ...payload("200"),
          month: "2026-11",
          groupName: "Casa",
          groupCategoryIds: [category],
        };
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, request(0, `/budgets/${created.data.id}`, "PUT", edit))
          )).status
        ).toBe(200);
        const owned = yield* readBudgetCaps({ db, userId: users[0] });
        expect(Option.getOrThrow(owned).map((budget) => budget.groupName)).toEqual(["Casa"]);
        expect(
          Option.getOrThrow(yield* readBudgetCaps({ db, userId: users[1] })).map(
            (budget) => budget.groupName
          )
        ).toEqual(["Ajeno"]);
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "CREATE TRIGGER reject_budget_group BEFORE UPDATE OF group_name ON budgets WHEN NEW.group_name='Rejected' BEGIN SELECT RAISE(ABORT,'reject_budget_group'); END"
            )
            .run()
        );
        const rejected = yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, `/budgets/${created.data.id}`, "PUT", {
              ...edit,
              month: "2026-12",
              groupName: "Rejected",
            })
          )
        );
        expect(rejected.status).toBe(503);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT 1 FROM (SELECT rowid,user_id,group_name,month,currency FROM budget_month_plan_records WHERE kind='currency') WHERE user_id=? AND group_name='Rejected'"
              )
              .bind(users[0])
              .first()
          )
        ).toBeNull();

        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT 1 FROM (SELECT rowid,user_id,month FROM budget_month_plan_records WHERE kind='plan') WHERE user_id=? AND month='2026-12'"
              )
              .bind(users[0])
              .first()
          )
        ).toBeNull();
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT 1 FROM (SELECT rowid,user_id,budget_id,month,cap FROM budget_month_plan_records WHERE kind='cap') WHERE user_id=? AND month='2026-12'"
              )
              .bind(users[0])
              .first()
          )
        ).toBeNull();
        expect(
          Option.getOrThrow(yield* readBudgetCaps({ db, userId: users[0] })).map(
            (budget) => budget.groupName
          )
        ).toEqual(["Casa"]);
      })
    ),
  30000
);

const groupCurrenciesAt = (
  db: D1Database,
  month: string
): Effect.Effect<ReadonlyArray<string>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      send(db, request(0, `/budget-status?timeZone=America%2FBogota&month=${month}`))
    );
    const report = yield* Schema.decodeUnknownEffect(Schema.Struct({ data: BudgetStatusReport }))(
      yield* Effect.tryPromise(() => response.json())
    );
    return report.data.statuses.map((status) => status.budget.cap.currency);
  });

it("versions currency for every group member without changing earlier months or another owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const response = yield* Effect.tryPromise(() =>
        send(
          db,
          request(0, "/budgets", "POST", { ...payload(), month: "2026-10", groupName: "Hogar" })
        )
      );
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => response.json())
      );
      const second = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT id FROM categories WHERE id<>? LIMIT 1")
          .bind(category)
          .first<string>("id")
      );
      expect(second).not.toBeNull();
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, "/budgets", "POST", {
              categoryId: second,
              cap: { amount: "250", currency: "COP" },
              month: "2026-10",
              groupName: "Hogar",
            })
          )
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(1, "/budgets", "POST", { ...payload(), month: "2026-10", groupName: "Hogar" })
          )
        )).status
      ).toBe(201);
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, `/budgets/${created.data.id}`, "PUT", {
              ...payload(),
              month: "2026-11",
              groupName: "Hogar",
              groupCategoryIds: [category, second],
              groupCurrency: "USD",
            })
          )
        )).status
      ).toBe(200);
      expect(yield* groupCurrenciesAt(db, "2026-10")).toEqual(["COP", "COP"]);
      expect(yield* groupCurrenciesAt(db, "2026-11")).toEqual(["USD", "USD"]);
      expect(yield* groupCurrenciesAt(db, "2026-12")).toEqual(["USD", "USD"]);
      expect(
        Option.getOrThrow(yield* readBudgetCaps({ db, userId: users[1] }))[0]?.cap.currency
      ).toBe("COP");
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, `/budgets/${created.data.id}`, "PUT", {
              categoryId: category,
              cap: { amount: "100", currency: "EUR" },
              month: "2026-11",
              groupName: "Hogar",
            })
          )
        )).status
      ).toBe(400);
      expect(yield* groupCurrenciesAt(db, "2026-11")).toEqual(["USD", "USD"]);
    })
  ));

it("refuses group currency precision loss including previously saved future caps", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const response = yield* Effect.tryPromise(() =>
        send(
          db,
          request(0, "/budgets", "POST", {
            categoryId: category,
            cap: { amount: "100", currency: "USD" },
            month: "2026-10",
            groupName: "Hogar",
          })
        )
      );
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* Effect.tryPromise(() => response.json())
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, `/budgets/${created.data.id}`, "PUT", {
              categoryId: category,
              cap: { amount: "10.25", currency: "USD" },
              month: "2026-12",
              groupName: "Hogar",
            })
          )
        )).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          send(
            db,
            request(0, `/budgets/${created.data.id}`, "PUT", {
              categoryId: category,
              cap: { amount: "100", currency: "USD" },
              month: "2026-11",
              groupName: "Hogar",
              groupCategoryIds: [category],
              groupCurrency: "JPY",
            })
          )
        )).status
      ).toBe(400);
      expect(yield* groupCurrenciesAt(db, "2026-11")).toEqual(["USD"]);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT 1 FROM (SELECT rowid,user_id,month FROM budget_month_plan_records WHERE kind='plan') WHERE user_id=? AND month='2026-11'"
            )
            .bind(users[0])
            .first()
        )
      ).toBeNull();
    })
  ));
