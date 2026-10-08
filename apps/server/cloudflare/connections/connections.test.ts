import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Cause, DateTime, Effect, Schema } from "effect";
import {
  canonicalAdmissionMigrationNames,
  hostedTurnTestMigrations,
  installTestSchema,
  isolatedTestDatabases,
  statementAuditTestMigrations,
} from "../d1-test-fixture";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { UserTransactionCoordinator } from "../transactions/runtime";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { ConnectInstitutionResult } from "../../src/core/connections/contract";

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
// The Miniflare fixture owns foreign Promise APIs, not application workflow.
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
it("discovers Bancolombia as unavailable without creating a Connection or exposing institution plumbing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const response = yield* Effect.tryPromise(() => send(db, request(0, "/institutions")));
      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        data: [
          {
            id: "bancolombia",
            displayName: "Bancolombia",
            availability: "unavailable",
            connection: null,
          },
        ],
        next: [],
      });
      const list = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(list.status).toBe(200);
      expect(yield* Effect.tryPromise(() => list.json())).toEqual({ data: [], next: [] });
    })
  ));
it("starts a stable Connecting association and reuses its original browser attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE connection_institution_gate SET enabled = 1 WHERE institution_id = 'bancolombia'"
          )
          .run()
      );
      const first = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(first.status).toBe(200);
      const started = yield* Effect.tryPromise(() => first.json());
      expect(started).toMatchObject({
        data: {
          type: "continue_in_browser",
          connection: { institutionId: "bancolombia", state: "Connecting" },
        },
      });
      const repeated = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(repeated.status).toBe(200);
      expect(yield* Effect.tryPromise(() => repeated.json())).toEqual(started);
      const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => listed.json())).toMatchObject({
        data: [{ institutionId: "bancolombia", state: "Connecting" }],
      });
    })
  ));
const decodeStartResponse = (
  response: Response
): Effect.Effect<ConnectInstitutionResult, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise(() => response.json());
    return (yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        data: Schema.toCodecJson(ConnectInstitutionResult),
        next: Schema.Array(Schema.Unknown),
      })
    )(data)).data;
  });

const start = (db: D1Database, index = 0): Promise<ConnectInstitutionResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise(() =>
        send(db, request(index, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(response.status).toBe(200);
      return (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.toCodecJson(ConnectInstitutionResult),
          next: Schema.Array(Schema.Unknown),
        })
      )(yield* Effect.tryPromise(() => response.json()))).data;
    })
  );
it("prepares a browser authorization once without activating the Connection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      const foreign = yield* Effect.tryPromise(() =>
        send(db, request(1, "/web/connections/begin", "POST", { attempt }))
      );
      expect(foreign.status).toBe(404);
      const prepared = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(prepared.status).toBe(200);
      expect(prepared.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.tryPromise(() => prepared.json())).toEqual({
        connection: started.connection,
        institutionName: "Bancolombia",
        expiresAt: DateTime.formatIso(started.continuation.expiresAt),
        phase: "prepared",
      });
      const replay = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(replay.status).toBe(404);
      const progress = yield* Effect.tryPromise(() =>
        send(db, request(0, `/web/connections/review?attempt=${attempt}`))
      );
      expect(yield* Effect.tryPromise(() => progress.json())).toMatchObject({ phase: "prepared" });
      const inspected = yield* Effect.tryPromise(() =>
        send(db, request(0, `/connections/${started.connection.id}`))
      );
      expect(yield* Effect.tryPromise(() => inspected.json())).toEqual({
        data: started.connection,
        next: [],
      });
    })
  ));
it.each(["expired", "stale-session", "revoked-session", "disabled-institution"] as const)(
  "refuses %s browser preparation without consuming the attempt",
  (condition) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() =>
          db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
        );
        const started = yield* Effect.tryPromise(() => start(db));
        if (started.type !== "continue_in_browser") {
          throw new Error("Expected browser continuation");
        }
        const attempt = new URL(started.continuation.url).searchParams.get("attempt");
        if (condition === "expired") {
          vi.setSystemTime(started.continuation.expiresAt.epochMilliseconds);
        }
        if (condition === "stale-session") {
          vi.setSystemTime(started.continuation.expiresAt.epochMilliseconds - 2000);
        }
        if (condition === "revoked-session") {
          yield* Effect.tryPromise(() =>
            db
              .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
              .bind(DateTime.nowUnsafe().epochMilliseconds, sessions[0])
              .run()
          );
        }
        if (condition === "disabled-institution") {
          yield* Effect.tryPromise(() =>
            db.prepare("UPDATE connection_institution_gate SET enabled = 0").run()
          );
        }
        const refused = yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }))
        );
        expect(refused.status).toBe(condition === "revoked-session" ? 401 : 404);
        // Persistence is the approved D1 atomicity seam: no partial attempt consumption or execution.
        expect(
          yield* Effect.tryPromise(() => db.prepare("SELECT status FROM connection_attempts").all())
        ).toMatchObject({ results: [{ status: "pending" }] });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT attempt_id FROM connection_authorization_executions").all()
          )
        ).toMatchObject({ results: [] });
      })
    )
);
it("refuses hostile browser input and origins without consuming a live attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      const crossOrigin = request(0, "/web/connections/begin", "POST", { attempt });
      crossOrigin.headers.set("origin", "https://attacker.example");
      const originless = request(0, "/web/connections/begin", "POST", { attempt });
      originless.headers.delete("origin");
      const anonymous = request(0, "/web/connections/begin", "POST", { attempt });
      anonymous.headers.delete("cookie");
      expect((yield* Effect.tryPromise(() => send(db, crossOrigin))).status).toBe(403);
      expect((yield* Effect.tryPromise(() => send(db, originless))).status).toBe(403);
      expect((yield* Effect.tryPromise(() => send(db, anonymous))).status).toBe(401);
      const hostile = [
        request(0, "/web/connections/begin", "POST", { attempt: "invalid" }),
        request(0, "/web/connections/begin", "POST", {
          attempt,
          authorizationCode: "must-not-be-accepted",
        }),
        request(0, "/web/connections/begin", "POST", { attempt, padding: "x".repeat(2048) }),
        request(0, `/web/connections/begin?attempt=${attempt}`, "POST", { attempt }),
        request(0, `/web/connections/review?attempt=${attempt}&attempt=${attempt}`),
      ];
      for (const candidate of hostile) {
        expect((yield* Effect.tryPromise(() => send(db, candidate))).status).toBe(400);
      }
      const owner = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(owner.status).toBe(200);
    })
  ));
it("commits only one concurrent browser preparation and retires old continuation progress", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      const parallel = yield* Effect.tryPromise(() =>
        Promise.all(
          Array.from({ length: 3 }, () =>
            send(db, request(0, "/web/connections/begin", "POST", { attempt }))
          )
        )
      );
      expect(parallel.filter((response) => response.status === 200)).toHaveLength(1);
      expect(parallel.every((response) => [200, 404, 429].includes(response.status))).toBe(true);
      const replacement = yield* Effect.tryPromise(() => start(db));
      expect(replacement.connection.id).toBe(started.connection.id);
      const retired = yield* Effect.tryPromise(() =>
        send(db, request(0, `/web/connections/review?attempt=${attempt}`))
      );
      expect(retired.status).toBe(404);
    })
  ));
it("rolls back browser preparation when Audit fails and allows a safe retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER refuse_browser_audit BEFORE INSERT ON pat_audit WHEN NEW.operation = 'connections.beginContinuation' BEGIN SELECT RAISE(ABORT, 'fixture_evidence_unavailable'); END"
          )
          .run()
      );
      const refused = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(refused.status).toBe(503);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT attempt_id FROM connection_authorization_executions").all()
        )
      ).toMatchObject({ results: [] });
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER refuse_browser_audit").run());
      const retried = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(retried.status).toBe(200);
    })
  ));
it.each(["session-revocation", "consent-withdrawal"] as const)(
  "rechecks %s after browser admission before preparation commits",
  (change) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() =>
          db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
        );
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO onboarding_consent_records VALUES ('browser-grant', ?, '{}', 'disclosure', 'decision', 1, 1)"
            )
            .bind(users[0])
            .run()
        );
        const started = yield* Effect.tryPromise(() => start(db));
        if (started.type !== "continue_in_browser") {
          throw new Error("Expected browser continuation");
        }
        const attempt = new URL(started.continuation.url).searchParams.get("attempt");
        const response = yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }), (database) =>
            change === "session-revocation"
              ? database
                  .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
                  .bind(DateTime.nowUnsafe().epochMilliseconds, sessions[0])
                  .run()
              : database
                  .prepare(
                    "INSERT INTO consent_user_revocations VALUES ('browser-withdrawn', ?, 'browser-grant', ?, ?)"
                  )
                  .bind(users[0], sessions[0], DateTime.nowUnsafe().epochMilliseconds)
                  .run()
          )
        );
        expect(response.status).toBe(404);
        expect(
          yield* Effect.tryPromise(() => db.prepare("SELECT status FROM connection_attempts").all())
        ).toMatchObject({ results: [{ status: "pending" }] });
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT attempt_id FROM connection_authorization_executions").all()
          )
        ).toMatchObject({ results: [] });
      })
    )
);
it("rolls back preparation at the shared User Audit budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 255)
    SELECT 'browser-budget-' || n, ?, ?, 'connections.listConnections', 'accepted', ? FROM seq`)
          .bind(users[0], sessions[0], DateTime.nowUnsafe().epochMilliseconds)
          .run()
      );
      const refused = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(refused.status).toBe(429);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT status FROM connection_attempts").all())
      ).toMatchObject({ results: [{ status: "pending" }] });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT attempt_id FROM connection_authorization_executions").all()
        )
      ).toMatchObject({ results: [] });
    })
  ));
it("shares canonical User request pressure before browser work is queued", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO canonical_request_leases VALUES ('occupied-one', ?, ?)")
            .bind(users[0], DateTime.nowUnsafe().epochMilliseconds + 90000),
          db
            .prepare("INSERT INTO canonical_request_leases VALUES ('occupied-two', ?, ?)")
            .bind(users[0], DateTime.nowUnsafe().epochMilliseconds + 90000),
        ])
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }))
        )).status
      ).toBe(429);
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, `/web/connections/review?attempt=${attempt}`))
        )).status
      ).toBe(429);
      yield* Effect.tryPromise(() =>
        db.prepare("DELETE FROM canonical_request_leases WHERE user_id = ?").bind(users[0]).run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }))
        )).status
      ).toBe(200);
    })
  ));
it("isolates ready and prepared browser review from a different User holding the locator", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      for (const phase of ["ready", "prepared"] as const) {
        if (phase === "prepared") {
          expect(
            (yield* Effect.tryPromise(() =>
              send(db, request(0, "/web/connections/begin", "POST", { attempt }))
            )).status
          ).toBe(200);
        }
        const foreign = yield* Effect.tryPromise(() =>
          send(db, request(1, `/web/connections/review?attempt=${attempt}`))
        );
        expect(foreign.status).toBe(404);
        expect(yield* Effect.tryPromise(() => foreign.json())).toEqual({
          error: { code: "continuation_unavailable" },
        });
        const owned = yield* Effect.tryPromise(() =>
          send(db, request(0, `/web/connections/review?attempt=${attempt}`))
        );
        expect(owned.status).toBe(200);
        expect(yield* Effect.tryPromise(() => owned.json())).toEqual({
          connection: started.connection,
          institutionName: "Bancolombia",
          expiresAt: DateTime.formatIso(started.continuation.expiresAt),
          phase,
        });
      }
      // Audit is an approved D1 seam: foreign review must never record accepted access.
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id FROM pat_audit WHERE user_id = ? AND operation = 'connections.reviewContinuation' AND outcome = 'accepted'"
            )
            .bind(users[1])
            .all()
        )
      ).toMatchObject({ results: [] });
    })
  ));
it("reviews a live browser continuation without granting institution authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      const review = yield* Effect.tryPromise(() =>
        send(db, request(0, `/web/connections/review?attempt=${attempt}`))
      );
      expect(review.status).toBe(200);
      expect(review.headers.get("cache-control")).toContain("no-store");
      expect(yield* Effect.tryPromise(() => review.json())).toEqual({
        connection: started.connection,
        institutionName: "Bancolombia",
        expiresAt: DateTime.formatIso(started.continuation.expiresAt),
        phase: "ready",
      });
      const listed = yield* Effect.tryPromise(() =>
        send(db, request(0, `/connections/${started.connection.id}`))
      );
      expect(yield* Effect.tryPromise(() => listed.json())).toEqual({
        data: started.connection,
        next: [],
      });
    })
  ));
it("replaces an attempt at its exact expiry without changing stable Connection identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const first = yield* Effect.tryPromise(() => start(db));
      if (first.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      vi.setSystemTime(first.continuation.expiresAt.epochMilliseconds - 1000);
      const replacement = yield* Effect.tryPromise(() => start(db));
      if (replacement.type !== "continue_in_browser") {
        throw new Error("Expected browser continuation");
      }
      expect(replacement.connection.id).toBe(first.connection.id);
      expect(replacement.continuation.url).not.toBe(first.continuation.url);
      expect(replacement.continuation.expiresAt.epochMilliseconds).toBe(
        first.continuation.expiresAt.epochMilliseconds + 600000
      );
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT status FROM connection_attempts ORDER BY created_at_ms").all()
        )
      ).toMatchObject({ results: [{ status: "invalidated" }, { status: "pending" }] });
    })
  ));
it("keeps one stable identity under concurrent starts and isolates another User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const starts = yield* Effect.tryPromise(() =>
        Promise.all(
          Array.from({ length: 3 }, () =>
            send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
          )
        )
      );
      expect(starts.some((response) => response.status === 200)).toBe(true);
      expect(starts.every((response) => response.status === 200 || response.status === 429)).toBe(
        true
      );
      const successes = yield* Effect.forEach(
        starts.filter((response) => response.status === 200),
        decodeStartResponse
      );
      const owned = yield* Effect.tryPromise(() => start(db));
      expect(successes.every((value) => value.connection.id === owned.connection.id)).toBe(true);
      const foreign = yield* Effect.tryPromise(() =>
        send(db, request(1, `/connections/${owned.connection.id}`))
      );
      expect(foreign.status).toBe(404);
      expect(yield* Effect.tryPromise(() => foreign.json())).toMatchObject({
        error: { code: "not_found" },
      });
      const foreignList = yield* Effect.tryPromise(() => send(db, request(1, "/connections")));
      expect(yield* Effect.tryPromise(() => foreignList.json())).toEqual({ data: [], next: [] });
      const second = yield* Effect.tryPromise(() => start(db, 1));
      expect(second.connection.id).not.toBe(owned.connection.id);
      const original = yield* Effect.tryPromise(() =>
        send(db, request(0, `/connections/${owned.connection.id}`))
      );
      expect(yield* Effect.tryPromise(() => original.json())).toEqual({
        data: owned.connection,
        next: [],
      });
      const ownInstitutions = yield* Effect.tryPromise(() => send(db, request(0, "/institutions")));
      expect(yield* Effect.tryPromise(() => ownInstitutions.json())).toEqual({
        data: [
          {
            id: "bancolombia",
            displayName: "Bancolombia",
            availability: "available",
            connection: { id: owned.connection.id, state: "Connecting" },
          },
        ],
        next: [],
      });
    })
  ));
it.each([
  ["bancolombia", 400],
  ["unknown", 404],
] as const)(
  "refuses unavailable institution %s without creating either lifecycle row",
  (institutionId, status) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const response = yield* Effect.tryPromise(() =>
          send(db, request(0, "/connections", "POST", { institutionId }))
        );
        expect(response.status).toBe(status);
        expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
          error: { message: "Institution unavailable." },
        });
        const list = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
        expect(yield* Effect.tryPromise(() => list.json())).toEqual({ data: [], next: [] });
        expect(
          yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_attempts").all())
        ).toMatchObject({
          results: [],
        });
      })
    )
);
it("returns an Active association without starting another attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const original = yield* Effect.tryPromise(() => start(db));
      // Trusted authorization fixture models the later browser owner; initiation cannot activate.
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = ? WHERE user_id = ? AND status = 'pending'"
          )
          .bind(DateTime.nowUnsafe().epochMilliseconds, users[0])
          .run()
      );
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connections SET state = 'Active' WHERE user_id = ?").bind(users[0]).run()
      );
      expect(yield* Effect.tryPromise(() => start(db))).toEqual({
        type: "already_connected",
        connection: { ...original.connection, state: "Active" },
      });
    })
  ));
const seedPAT = (
  db: D1Database,
  input: Readonly<{
    token: string;
    scope: "read" | "write";
    id: string;
  }>
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
    VALUES (?, ?, ?, ?, 'Connection capability fixture', ?, 7, ?, ?, ?, ?)`)
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
it("uses read and write capabilities from the shared authorization algebra", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const readToken = `fin_${"r".repeat(8)}_${"a".repeat(43)}`;
      const writeToken = `fin_${"w".repeat(8)}_${"b".repeat(43)}`;
      yield* seedPAT(db, {
        token: readToken,
        scope: "read",
        id: "10000000-0000-4000-8000-000000000081",
      });
      yield* seedPAT(db, {
        token: writeToken,
        scope: "write",
        id: "10000000-0000-4000-8000-000000000082",
      });
      const asPAT = (
        token: string,
        path: string,
        ...args: [method?: string, body?: object]
      ): Request => {
        const [method = "GET", body = {}] = args;
        const value = request(0, path, method, method === "GET" ? undefined : body);
        value.headers.delete("cookie");
        value.headers.set("authorization", `Bearer ${token}`);
        return value;
      };
      const deniedStart = yield* Effect.tryPromise(() =>
        send(db, asPAT(readToken, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(deniedStart.status).toBe(403);
      const allowedRead = yield* Effect.tryPromise(() =>
        send(db, asPAT(readToken, "/institutions"))
      );
      expect(allowedRead.status).toBe(200);
      const deniedRead = yield* Effect.tryPromise(() =>
        send(db, asPAT(writeToken, "/connections"))
      );
      expect(deniedRead.status).toBe(403);
      const allowedStart = yield* Effect.tryPromise(() =>
        send(db, asPAT(writeToken, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(allowedStart.status).toBe(200);
      expect(yield* Effect.tryPromise(() => allowedStart.json())).toMatchObject({
        data: { type: "continue_in_browser" },
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE pats SET revoked_at_ms = ? WHERE id = ?")
          .bind(DateTime.nowUnsafe().epochMilliseconds, "10000000-0000-4000-8000-000000000082")
          .run()
      );
      const revoked = yield* Effect.tryPromise(() =>
        send(db, asPAT(writeToken, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(revoked.status).toBe(401);
    })
  ));
it("rolls back Connection, attempt and success Audit when the final evidence write fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER refuse_connection_audit BEFORE INSERT ON pat_audit WHEN NEW.operation = 'connections.connectInstitution' AND NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'fixture_evidence_unavailable'); END"
          )
          .run()
      );
      const response = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(response.status).toBe(503);
      const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => listed.json())).toEqual({ data: [], next: [] });
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_attempts").all())
      ).toMatchObject({
        results: [],
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id FROM pat_audit WHERE operation = 'connections.connectInstitution' AND outcome = 'accepted'"
            )
            .all()
        )
      ).toMatchObject({ results: [] });
    })
  ));
it("composes a Connection start in the canonical atomic batch and refuses duplicate targets before commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const call = (index: number): object => ({
        callId: `20000000-0000-4000-8000-00000000000${index}`,
        operation: "connections.connectInstitution",
        input: { payload: { institutionId: "bancolombia" } },
      });
      const refused = yield* Effect.tryPromise(() =>
        send(db, request(0, "/operations/atomic-batch", "POST", { calls: [call(1), call(2)] }))
      );
      expect(refused.status).toBe(400);
      const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => listed.json())).toEqual({ data: [], next: [] });
      const accepted = yield* Effect.tryPromise(() =>
        send(db, request(0, "/operations/atomic-batch", "POST", { calls: [call(1)] }))
      );
      expect(accepted.status).toBe(200);
      expect(yield* Effect.tryPromise(() => accepted.json())).toMatchObject({
        data: {
          results: [
            {
              operation: "connections.connectInstitution",
              output: { data: { type: "continue_in_browser" } },
            },
          ],
        },
      });
    })
  ));
it("persists immutable expiry, same-User ownership, and terminal single-use attempt state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      yield* Effect.tryPromise(() =>
        expect(
          db.prepare("UPDATE connection_attempts SET expires_at_ms = expires_at_ms + 1").run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db.prepare("UPDATE connection_attempts SET user_id = ?").bind(users[1]).run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = expires_at_ms"
            )
            .run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = ?")
          .bind(DateTime.nowUnsafe().epochMilliseconds)
          .run()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare("UPDATE connection_attempts SET status = 'pending', consumed_at_ms = NULL")
            .run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare("UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = ?")
            .bind(DateTime.nowUnsafe().epochMilliseconds + 1)
            .run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "INSERT INTO connections (id,user_id,institution_id,state,created_at_ms,updated_at_ms) VALUES ('10000000-0000-4000-8000-000000000091',?,'bancolombia','Connecting',?,?)"
            )
            .bind(
              users[0],
              DateTime.nowUnsafe().epochMilliseconds,
              DateTime.nowUnsafe().epochMilliseconds
            )
            .run()
        ).rejects.toThrow()
      );
      const next = yield* Effect.tryPromise(() => start(db));
      expect(next.connection.id).toBe(started.connection.id);
      if (next.type !== "continue_in_browser" || started.type !== "continue_in_browser") {
        throw new Error("Expected browser continuations");
      }
      expect(next.continuation.url).not.toBe(started.continuation.url);
    })
  ));
it.each(["Action required", "Ended"] as const)(
  "starts a fresh %s reauthorization attempt with the same identity",
  (state) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() =>
          db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
        );
        const original = yield* Effect.tryPromise(() => start(db));
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE connections SET state = ? WHERE user_id = ?")
            .bind(state, users[0])
            .run()
        );
        const next = yield* Effect.tryPromise(() => start(db));
        expect(next.connection.id).toBe(original.connection.id);
        if (next.type !== "continue_in_browser" || original.type !== "continue_in_browser") {
          throw new Error("Expected browser continuations");
        }
        expect(next.continuation.url).not.toBe(original.continuation.url);
      })
    )
);
it("refuses malformed and cross-origin starts before any lifecycle effect", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const malformed = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "../bancolombia" }))
      );
      expect(malformed.status).toBe(400);
      const crossOrigin = request(0, "/connections", "POST", { institutionId: "bancolombia" });
      crossOrigin.headers.set("origin", "https://attacker.example");
      expect((yield* Effect.tryPromise(() => send(db, crossOrigin))).status).toBe(403);
      const anonymous = request(0, "/connections");
      anonymous.headers.delete("cookie");
      expect((yield* Effect.tryPromise(() => send(db, anonymous))).status).toBe(401);
      const list = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => list.json())).toEqual({ data: [], next: [] });
    })
  ));
it("counts browser inspection and initiation against the same shared Audit budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 255)
    SELECT 'connection-audit-' || n, ?, ?, 'connections.listConnections', 'accepted', ? FROM seq`)
          .bind(users[0], sessions[0], DateTime.nowUnsafe().epochMilliseconds)
          .run()
      );
      const inspection = yield* Effect.tryPromise(() => send(db, request(0, "/institutions")));
      expect(inspection.status).toBe(200);
      const denied = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(denied.status).toBe(429);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connections").all())
      ).toMatchObject({ results: [] });
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_attempts").all())
      ).toMatchObject({
        results: [],
      });
    })
  ));
it("removes expired attempts after their bounded retention while retaining the stable Connection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connection_institution_gate SET enabled = 1").run()
      );
      const original = yield* Effect.tryPromise(() => start(db));
      if (original.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      vi.setSystemTime(original.continuation.expiresAt.epochMilliseconds + 86400000);
      // A trusted returning-browser fixture keeps the live credential separate from expired attempt state.
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE web_sessions SET idle_expires_at_ms = ? WHERE user_id = ?")
          .bind(DateTime.nowUnsafe().epochMilliseconds + 3600000, users[0])
          .run()
      );
      const returned = yield* Effect.tryPromise(() => start(db));
      expect(returned.connection.id).toBe(original.connection.id);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT status FROM connection_attempts").all())
      ).toMatchObject({
        results: [{ status: "pending" }],
      });
    })
  ));
