import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Cause, Clock, DateTime, Effect, Option, Schema } from "effect";
import {
  canonicalAdmissionMigrationNames,
  hostedTurnTestMigrations,
  installTestSchema,
  isolatedTestDatabases,
  statementAuditTestMigrations,
} from "../d1-test-fixture";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { UserTransactionCoordinator } from "../transactions/runtime";
import { fixtureWorker as coreWorker } from "../core-worker.test-fixture";
import publicWorker from "../public-worker";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import {
  PrivacyTransactionPage,
  ProcessingAuthorization,
  ProcessingConsentStatus,
} from "../../src/shell/processing-consent/contract";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { executeConsentWithdrawal, prepareConsentAction, readConsentStatus } from "./operations";
import type { ConsentUnavailable } from "./contract";

const users = [
  "10000000-0000-4000-8000-000000000051",
  "10000000-0000-4000-8000-000000000052",
] as const;
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
  input: Readonly<{
    user: string;
    index: number;
    current: number;
  }>
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
      "0063_connections",
      "0064_connection_browser_execution",
      "0065_connection_attempt_retention",
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
      "0075_transaction_query_costs",
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
const send = (
  db: D1Database,
  request: Request,
  beforeCoordinate?: (database: D1Database) => Promise<unknown>
): Promise<Response> => {
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
                const admittedCoordinator = coordinator;
                return beforeCoordinate === undefined
                  ? admittedCoordinator.fetch(new Request(command))
                  : beforeCoordinate(db).then(() =>
                      admittedCoordinator.fetch(new Request(command))
                    );
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

const consentSetup = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* setup();
    const current = DateTime.nowUnsafe().epochMilliseconds;
    yield* Effect.tryPromise(() =>
      db.batch(
        users.map((userId, index) =>
          db
            .prepare(
              "INSERT INTO onboarding_consent_records VALUES (?, ?, ?, 'disclosed', 'accepted', ?, ?)"
            )
            .bind(
              `30000000-0000-4000-8000-00000000000${index}`,
              userId,
              Schema.encodeSync(Schema.fromJsonString(DisclosureSnapshot))(currentDisclosureFor()),
              current,
              current
            )
        )
      )
    );
    return db;
  });

const privacyHistorySetup = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* consentSetup();
    yield* Effect.tryPromise(() =>
      db.batch(
        users.map((userId, index) =>
          db
            .prepare(
              "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,notes,occurred_at,created_at) VALUES(?,?,'12000','COP','outflow','10000000-0000-4000-8000-000000000001',?,'2026-10-01T12:00:00.000Z','2026-10-01T12:00:00.000Z')"
            )
            .bind(
              `40000000-0000-4000-8000-00000000000${index}`,
              userId,
              `Synthetic owned record ${index}`
            )
        )
      )
    );
    return db;
  });

it("bounds privacy history pages and keeps every continuation bound to the authenticated User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* privacyHistorySetup();
      yield* Effect.tryPromise(() =>
        db
          .prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<100)
      INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at,created_at)
      SELECT printf('41000000-0000-4000-8000-%012d',value),?,'1000','COP','outflow','10000000-0000-4000-8000-000000000001',
      '2026-10-02T12:00:00.000Z','2026-10-02T12:00:00.000Z' FROM n`)
          .bind(users[0])
          .run()
      );
      const first = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/privacy/transactions", "POST", { cursor: null }))
      );
      const firstPage = yield* Schema.decodeUnknownEffect(PrivacyTransactionPage)(
        yield* Effect.tryPromise(() => first.json())
      );
      expect(firstPage.data).toHaveLength(100);
      expect(firstPage.next).not.toBeNull();
      const encoded = yield* Schema.encodeEffect(PrivacyTransactionPage)(firstPage);
      const second = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/privacy/transactions", "POST", { cursor: encoded.next }))
      );
      const secondPage = yield* Schema.decodeUnknownEffect(PrivacyTransactionPage)(
        yield* Effect.tryPromise(() => second.json())
      );
      expect(secondPage.data).toHaveLength(1);
      expect(secondPage.next).toBeNull();
      expect(new Set([...firstPage.data, ...secondPage.data].map((record) => record.id)).size).toBe(
        101
      );
      const other = yield* Effect.tryPromise(() =>
        send(db, request(1, "/web/privacy/transactions", "POST", { cursor: encoded.next }))
      );
      const otherPage = yield* Schema.decodeUnknownEffect(PrivacyTransactionPage)(
        yield* Effect.tryPromise(() => other.json())
      );
      expect(otherPage.data.every((record) => record.id.endsWith("001"))).toBe(true);
      const wrongOrigin = request(0, "/web/privacy/transactions", "POST", { cursor: null });
      wrongOrigin.headers.set("origin", "https://hostile.example");
      expect((yield* Effect.tryPromise(() => send(db, wrongOrigin))).status).toBe(403);
      const bearerOnly = request(0, "/web/privacy/transactions", "POST", { cursor: null });
      bearerOnly.headers.delete("cookie");
      bearerOnly.headers.set("authorization", "Bearer synthetic-pat");
      expect((yield* Effect.tryPromise(() => send(db, bearerOnly))).status).toBe(401);
    })
  ));

it("delivers actual same-User Transactions after withdrawal with scoped Audit and no renewed processing Consent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* privacyHistorySetup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE users SET time_zone='Europe/Madrid' WHERE id=?").bind(users[0]).run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/consent/withdraw", "POST", { confirm: true }))
        )).status
      ).toBe(200);
      const response = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/privacy/transactions", "POST", { cursor: null }))
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const page = yield* Schema.decodeUnknownEffect(PrivacyTransactionPage)(
        yield* Effect.tryPromise(() => response.json())
      );
      expect(page.presentation).toEqual({ locale: "es-CO", timeZone: "Europe/Madrid" });
      expect(
        page.categories.find((category) => category.id === page.data[0]?.categoryId)?.label
      ).toBe("Restaurantes");
      expect(page.scope).toBe("transactions");
      expect(page.data.map((record) => Option.getOrThrow(record.notes))).toEqual([
        "Synthetic owned record 0",
      ]);
      expect(page.next).toBeNull();
      const audit = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT user_id,operation,outcome FROM pat_audit WHERE id=?")
          .bind(page.reference)
          .first()
      );
      expect(audit).toEqual({
        user_id: users[0],
        operation: "privacy.transactions",
        outcome: "accepted",
      });
      expect(yield* readConsentStatus({ db, userId: users[0] })).toBe("Revoked");
      const foreignSelector = yield* Effect.tryPromise(() =>
        send(
          db,
          request(0, "/web/privacy/transactions", "POST", { cursor: null, userId: users[1] })
        )
      );
      expect(foreignSelector.status).toBe(400);
      const other = yield* Effect.tryPromise(() =>
        send(db, request(1, "/web/privacy/transactions", "POST", { cursor: null }))
      );
      const otherPage = yield* Schema.decodeUnknownEffect(PrivacyTransactionPage)(
        yield* Effect.tryPromise(() => other.json())
      );
      expect(otherPage.presentation.timeZone).toBe("America/Bogota");
      expect(otherPage.data.map((record) => Option.getOrThrow(record.notes))).toEqual([
        "Synthetic owned record 1",
      ]);
    })
  ));

it("refuses stale or raced privacy proof and rolls back failed accountability without disclosing history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* privacyHistorySetup();
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE web_sessions SET created_at_ms=created_at_ms-600001,fresh_until_ms=fresh_until_ms-600001,hard_expires_at_ms=hard_expires_at_ms-600001 WHERE user_id=?"
          )
          .bind(users[0])
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/privacy/transactions", "POST", { cursor: null }))
        )).status
      ).toBe(401);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE web_sessions SET created_at_ms=created_at_ms+600001,fresh_until_ms=fresh_until_ms+600001,hard_expires_at_ms=hard_expires_at_ms+600001 WHERE user_id=?"
          )
          .bind(users[0])
          .run()
      );
      yield* Effect.tryPromise(() =>
        db.exec(
          "CREATE TRIGGER fail_privacy_audit BEFORE INSERT ON pat_audit WHEN NEW.operation='privacy.transactions' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;"
        )
      );
      const failed = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/privacy/transactions", "POST", { cursor: null }))
      );
      expect(failed.status).toBe(503);
      expect(yield* Effect.tryPromise(() => failed.text())).not.toContain("Synthetic owned record");
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS n FROM pat_audit WHERE operation='privacy.transactions'")
            .first()
        ))?.n
      ).toBe(0);
      yield* Effect.tryPromise(() =>
        db.exec(
          "DROP TRIGGER fail_privacy_audit; CREATE TRIGGER expire_privacy_session AFTER INSERT ON canonical_request_leases BEGIN UPDATE web_sessions SET created_at_ms=created_at_ms-600001,fresh_until_ms=fresh_until_ms-600001,hard_expires_at_ms=hard_expires_at_ms-600001; END;"
        )
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/privacy/transactions", "POST", { cursor: null }))
        )).status
      ).toBe(401);
    })
  ));

it("withdraws only the authenticated User, keeps one stable receipt on concurrent replay and refuses later protected work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* consentSetup();
      const before = yield* Effect.tryPromise(() => send(db, request(0, "/web/consent")));
      expect(before.status).toBe(200);
      const queued = prepareConsentAction({
        db,
        subject: { _tag: "User", userId: users[0] },
        requirement: "active",
        statement: { sql: "UPDATE users SET time_zone='Etc/UTC' WHERE id=?", params: [users[0]] },
      });
      const results = yield* Effect.tryPromise(() =>
        Promise.all([
          send(db, request(0, "/web/consent/withdraw", "POST", { confirm: true })),
          send(db, request(0, "/web/consent/withdraw", "POST", { confirm: true })),
        ])
      );
      expect(results.map((response) => response.status)).toEqual([200, 200]);
      const receipts = yield* Effect.tryPromise(() =>
        Promise.all(results.map((response) => response.json()))
      );
      expect(receipts[0]).toEqual(receipts[1]);
      const decodedReceipt = yield* Schema.decodeUnknownEffect(ProcessingConsentStatus)(
        receipts[0]
      );
      expect(decodedReceipt.status).toBe("Revoked");
      expect(decodedReceipt.withdrawal).not.toBeNull();
      expect(yield* readConsentStatus({ db, userId: users[1] })).toBe("Granted");
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT COUNT(*) AS n FROM consent_user_revocations").first()
        ))?.n
      ).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS n FROM pat_audit WHERE operation='consent.withdraw'")
            .first()
        ))?.n
      ).toBe(1);
      const after = yield* Effect.tryPromise(() => send(db, request(0, "/web/consent")));
      expect(yield* Effect.tryPromise(() => after.json())).toEqual(receipts[0]);
      const rejected = yield* Effect.tryPromise(() =>
        send(db, request(0, "/transactions?limit=1"))
      );
      expect(rejected.status).toBe(401);
      expect((yield* Effect.tryPromise(() => queued.run())).meta.changes).toBe(0);
    })
  ));

it("rejects hostile origin, bearer-only calls, malformed decisions and wrong methods without withdrawal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* consentSetup();
      const hostile = request(0, "/web/consent/withdraw", "POST", { confirm: true });
      hostile.headers.set("origin", "https://attacker.example");
      const anonymous = request(0, "/web/consent/withdraw", "POST", { confirm: true });
      anonymous.headers.delete("cookie");
      anonymous.headers.set("authorization", "Bearer " + bearer(0));
      const originless = request(0, "/web/consent/withdraw", "POST", { confirm: true });
      originless.headers.delete("origin");
      const scenarios = [
        { request: hostile, status: 403 },
        { request: originless, status: 403 },
        { request: anonymous, status: 401 },
        { request: request(0, "/web/consent/withdraw"), status: 405 },
        { request: request(0, "/web/consent/withdraw", "POST", { confirm: false }), status: 400 },
        {
          request: request(0, "/web/consent/withdraw", "POST", { confirm: true, userId: users[1] }),
          status: 400,
        },
        {
          request: request(0, "/web/consent/withdraw?userId=" + users[1], "POST", {
            confirm: true,
          }),
          status: 400,
        },
      ];
      for (const scenario of scenarios) {
        expect((yield* Effect.tryPromise(() => send(db, scenario.request))).status).toBe(
          scenario.status
        );
      }
      expect(yield* readConsentStatus({ db, userId: users[0] })).toBe("Granted");
      expect(yield* readConsentStatus({ db, userId: users[1] })).toBe("Granted");
    })
  ));

it("rechecks revoked proof at coordinated commit and rolls withdrawal back when Audit fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* consentSetup();
      const stale = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/consent/withdraw", "POST", { confirm: true }), (database) =>
          database
            .prepare("UPDATE web_sessions SET revoked_at_ms=? WHERE id=?")
            .bind(DateTime.nowUnsafe().epochMilliseconds, sessions[0])
            .run()
        )
      );
      expect(stale.status).toBe(401);
      expect(yield* readConsentStatus({ db, userId: users[0] })).toBe("Granted");
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER test_withdraw_audit BEFORE INSERT ON pat_audit WHEN NEW.operation='consent.withdraw' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END;"
          )
          .run()
      );
      const failed = yield* Effect.tryPromise(() =>
        send(db, request(1, "/web/consent/withdraw", "POST", { confirm: true }))
      );
      expect(failed.status).toBe(503);
      expect(yield* readConsentStatus({ db, userId: users[1] })).toBe("Granted");
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER test_withdraw_audit").run());
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(1, "/web/consent/withdraw", "POST", { confirm: true }))
        )).status
      ).toBe(200);
    })
  ));

it("refuses foreign coordinator, mismatched digest, expired admission and aborted work without effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* consentSetup();
      const current = yield* Clock.currentTimeMillis;
      const bytes = yield* Effect.tryPromise(() => digest(bearer(0)));
      const admission = {
        userId: users[0],
        sessionId: sessions[0],
        digest: Array.from(bytes),
        deadlineMilliseconds: current + 5000,
      };
      const abortedSignal = AbortSignal.abort();
      const liveSignal = yield* Effect.abortSignal;
      for (const scenario of [
        {
          candidate: admission,
          userId: users[1],
          signal: liveSignal,
          status: 503,
        },
        {
          candidate: { ...admission, digest: Array(32).fill(0) },
          userId: users[0],
          signal: liveSignal,
          status: 401,
        },
        {
          candidate: { ...admission, deadlineMilliseconds: current },
          userId: users[0],
          signal: liveSignal,
          status: 503,
        },
        { candidate: admission, userId: users[0], signal: abortedSignal, status: 503 },
      ]) {
        expect((yield* executeConsentWithdrawal({ db, ...scenario })).status).toBe(scenario.status);
      }
      expect(yield* readConsentStatus({ db, userId: users[0] })).toBe("Granted");
    }).pipe(Effect.scoped)
  ));

it("rejects receipt/status combinations that cannot represent a processing authorization", () => {
  const decode = Schema.decodeUnknownOption(ProcessingConsentStatus);
  const receipt = { reference: users[0], occurredAtMs: 1000 };
  for (const value of [
    { status: "Revoked", withdrawal: null },
    { status: "Granted", withdrawal: receipt },
    { status: "Missing", withdrawal: receipt },
  ]) {
    expect(decode(value)._tag).toBe("None");
  }
  expect(decode({ status: "Revoked", withdrawal: receipt })._tag).toBe("Some");
});

const expireSession = (
  db: D1Database,
  expiry: "idle_expires_at_ms" | "hard_expires_at_ms"
): Promise<D1Result> => {
  const current = DateTime.nowUnsafe().epochMilliseconds;
  return expiry === "idle_expires_at_ms"
    ? db
        .prepare("UPDATE web_sessions SET idle_expires_at_ms=? WHERE id=?")
        .bind(current, sessions[0])
        .run()
    : db
        .prepare(
          "UPDATE web_sessions SET created_at_ms=?,fresh_until_ms=?,idle_expires_at_ms=?,hard_expires_at_ms=? WHERE id=?"
        )
        .bind(current - 7776000000, current - 7775400000, current, current, sessions[0])
        .run();
};

const expectNoWithdrawal = (
  db: D1Database
): Effect.Effect<void, Cause.UnknownError | ConsentUnavailable> =>
  Effect.gen(function* () {
    expect(yield* readConsentStatus({ db, userId: users[0] })).toBe("Granted");
    const evidence = yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare("SELECT COUNT(*) AS n FROM consent_user_revocations"),
        db.prepare("SELECT COUNT(*) AS n FROM pat_audit WHERE operation='consent.withdraw'"),
      ])
    );
    expect(evidence.map((result) => result.results)).toEqual([[{ n: 0 }], [{ n: 0 }]]);
  });

it("refuses idle- and hard-expired cookies at public admission and coordinated commit without withdrawal or Audit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const expiry of ["idle_expires_at_ms", "hard_expires_at_ms"] as const) {
        const expired = yield* consentSetup();
        yield* Effect.tryPromise(() => expireSession(expired, expiry));
        const read = yield* Effect.tryPromise(() => send(expired, request(0, "/web/consent")));
        expect(read.status).toBe(401);
        const authorization = yield* Effect.tryPromise(() =>
          send(expired, request(0, "/web/consent/authorization"))
        );
        expect(authorization.status).toBe(401);
        const withdrawal = yield* Effect.tryPromise(() =>
          send(expired, request(0, "/web/consent/withdraw", "POST", { confirm: true }))
        );
        expect(withdrawal.status).toBe(401);
        yield* expectNoWithdrawal(expired);
        const racing = yield* consentSetup();
        const refused = yield* Effect.tryPromise(() =>
          send(racing, request(0, "/web/consent/withdraw", "POST", { confirm: true }), (database) =>
            expireSession(database, expiry)
          )
        );
        expect(refused.status).toBe(401);
        yield* expectNoWithdrawal(racing);
      }
    })
  ));

it("returns each authenticated User's exact authorization copy after withdrawal without reviving Consent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* consentSetup();
      const copy = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/consent/authorization"))
      );
      expect(copy.status).toBe(200);
      expect(copy.headers.get("cache-control")).toContain("no-store");
      const first = yield* Schema.decodeUnknownEffect(ProcessingAuthorization)(
        yield* Effect.tryPromise(() => copy.json())
      );
      expect(first.authorization?.reference).toBe("30000000-0000-4000-8000-000000000000");
      expect(first.authorization?.disclosure).toEqual(currentDisclosureFor());
      const second = yield* Effect.tryPromise(() =>
        send(db, request(1, "/web/consent/authorization"))
      );
      const other = yield* Schema.decodeUnknownEffect(ProcessingAuthorization)(
        yield* Effect.tryPromise(() => second.json())
      );
      expect(other.authorization?.reference).toBe("30000000-0000-4000-8000-000000000001");
      yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/consent/withdraw", "POST", { confirm: true }))
      );
      const after = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/consent/authorization"))
      );
      expect(yield* Effect.tryPromise(() => after.json())).toEqual(first);
      expect(yield* readConsentStatus({ db, userId: users[0] })).toBe("Revoked");
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/consent/authorization?userId=" + users[1]))
        )).status
      ).toBe(400);
    })
  ));

it("refuses authorization copies with lost proof, hostile origins or malformed and oversized saved disclosures", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* consentSetup();
      const hostile = request(0, "/web/consent/authorization");
      hostile.headers.set("origin", "https://attacker.example");
      expect((yield* Effect.tryPromise(() => send(db, hostile))).status).toBe(403);
      const bearerOnly = request(0, "/web/consent/authorization");
      bearerOnly.headers.delete("cookie");
      bearerOnly.headers.set("authorization", "Bearer " + bearer(0));
      expect((yield* Effect.tryPromise(() => send(db, bearerOnly))).status).toBe(401);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER revoke_copy_session AFTER INSERT ON canonical_request_leases BEGIN UPDATE web_sessions SET revoked_at_ms=created_at_ms WHERE id='10000000-0000-4000-8000-000000000061'; END"
          )
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() => send(db, request(0, "/web/consent/authorization")))).status
      ).toBe(401);
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER revoke_copy_session").run());
      for (const value of ["{}", '{"padding":"' + "x".repeat(32769) + '"}']) {
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE onboarding_consent_records SET disclosure_json=? WHERE user_id=?")
            .bind(value, users[1])
            .run()
        );
        const refused = yield* Effect.tryPromise(() =>
          send(db, request(1, "/web/consent/authorization"))
        );
        expect(refused.status).toBe(503);
        expect(yield* Effect.tryPromise(() => refused.json())).toEqual({
          error: { code: "consent_unavailable" },
        });
      }
      expect(yield* readConsentStatus({ db, userId: users[1] })).toBe("Granted");
    })
  ));
