import { applyTestMigration, installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { executeCanonicalQuery, executeCanonicalWork } from "../canonical-operations/operations";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { ScopeMissing } from "../../src/shell/public-http/contract";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { BigDecimal, type Cause, DateTime, Effect, Option, Schema } from "effect";
import { repairDashboardProjection } from "../transactions/operations";
import { DashboardDocument, DashboardEdit } from "../../src/core/dashboard/contract";
import { prepareDashboard } from "./operations";
import { UserId } from "../../src/core/identity/contract";
import {
  OAuthClientId,
  OAuthConnectionId,
  OAuthCredentialId,
} from "../../src/core/oauth-agents/contract";
import { type OAuthCaller, oauthResource } from "../../src/shell/oauth-agents/contract";
import { Transaction } from "../../src/core/transactions/contract";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { resolveDashboardPeriod } from "../../src/core/dashboard/operations";
import { DashboardView } from "../../src/shell/dashboard/contract";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import coreWorker from "../core-worker";
import { UserTransactionCoordinator } from "../transactions/runtime";
import publicWorker from "../public-worker";

const users = ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000052"];
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
const databases = isolatedTestDatabases();
const bearer = (index: number): string => String(index + 1).repeat(43);
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));

const seedUser = ({
  db,
  user,
  index,
  current,
}: Readonly<{
  db: D1Database;
  user: string;
  index: number;
  current: number;
}>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
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

const setup = (initializeSchema = true): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());
    yield* Effect.tryPromise(() =>
      installTestSchema({
        db,
        sources: [
          ...new Bun.Glob("*.sql").scanSync({
            cwd: new URL("../migrations/", import.meta.url).pathname,
          }),
        ]
          .filter((name) => initializeSchema || name !== "0030_dashboard_initialization.sql")
          .sort()
          .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
      })
    );
    const current = DateTime.nowUnsafe().epochMilliseconds;
    yield* Effect.forEach(users, (user, index) => seedUser({ db, user, index, current }), {
      discard: true,
    });
    return db;
  });
afterAll(() => databases.dispose());

const seedPAT = (
  db: D1Database,
  input: Readonly<{ token: string; scope: "read" | "write" | "dashboard"; id: string }>
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
    VALUES (?, ?, ?, ?, 'Dashboard security fixture', ?, 7, ?, ?, ?, ?)`)
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

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());
const coordinatorByDatabase = new WeakMap<D1Database, Map<string, UserTransactionCoordinator>>();
const coordinatorObservers = new WeakMap<D1Database, (operation: string) => void>();
const send = (
  db: D1Database,
  credential: number | string,
  pathAndBody: string | Readonly<{ path: string; method: "POST" | "PUT"; body: object }>
): Promise<Response> => {
  vi.setSystemTime(DateTime.nowUnsafe().epochMilliseconds + 1000);
  return publicWorker.fetch(
    new Request(
      `https://api.fidyapp.com${typeof pathAndBody === "string" ? pathAndBody : pathAndBody.path}`,
      {
        method: typeof pathAndBody === "string" ? "GET" : pathAndBody.method,
        headers: {
          origin: "https://app.fidyapp.com",
          "cf-connecting-ip": "192.0.2.35",
          ...(typeof credential === "number"
            ? { cookie: `__Host-fidy_session=${bearer(credential)}` }
            : { authorization: `Bearer ${credential}`, "x-provider-id": users[0] ?? "" }),
          ...(typeof pathAndBody === "string" ? {} : { "content-type": "application/json" }),
        },
        ...(typeof pathAndBody === "string" ? {} : { body: JSON.stringify(pathAndBody.body) }),
      }
    ),
    {
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
                  const coordinators =
                    coordinatorByDatabase.get(db) ?? new Map<string, UserTransactionCoordinator>();
                  coordinatorByDatabase.set(db, coordinators);
                  let coordinator = coordinators.get(name);
                  if (coordinator === undefined) {
                    coordinator = new UserTransactionCoordinator(
                      {
                        id: { name },
                        storage: { setAlarm: (): Promise<void> => Promise.resolve() },
                      },
                      {
                        DB: db,
                        AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
                        HOSTED_AI_MODEL: approvedWorkersAiModel,
                      }
                    );
                    coordinators.set(name, coordinator);
                  }
                  const request = new Request(command);
                  const observer = Option.fromUndefinedOr(coordinatorObservers.get(db));
                  return Option.match(observer, {
                    onNone: () => coordinator.fetch(request),
                    onSome: (observe) =>
                      request
                        .clone()
                        .json()
                        .then((body) => {
                          const observed = Schema.decodeUnknownSync(
                            Schema.Struct({ work: Schema.Struct({ operation: Schema.String }) })
                          )(body);
                          const pending = coordinator.fetch(request);
                          observe(observed.work.operation);
                          return pending;
                        }),
                  });
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
    }
  );
};

const BatchFailure = Schema.Struct({
  error: Schema.Struct({
    operation: Schema.String,
    failedCallIndex: Schema.Finite,
    code: Schema.String,
  }),
});
const BatchDashboard = Schema.Struct({
  data: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        output: Schema.Struct({ data: Schema.Struct({ title: Schema.String }) }),
      })
    ),
  }),
});
const DocumentReply = Schema.Struct({ data: Schema.Struct({ title: Schema.String }) });
const batchCall = (operation: string, input: object, index: number): object => ({
  callId: `30000000-0000-4000-8000-00000000000${index}`,
  operation,
  input,
});
const batch = (db: D1Database, calls: ReadonlyArray<object>): Promise<Response> =>
  send(db, 0, { path: "/operations/atomic-batch", method: "POST", body: { calls } });
const initialize = (db: D1Database, user = 0): Promise<Response> =>
  send(db, user, { path: "/dashboard/initialize", method: "POST", body: {} });
const initializedSetup = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* setup();
    expect((yield* Effect.tryPromise(() => initialize(db))).status).toBe(200);
    return db;
  });
const count = (db: D1Database, table: "dashboard_documents" | "dashboard_audit"): Promise<number> =>
  db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`)
    .bind(users[0])
    .first<{ count: number }>()
    .then((row) => row?.count ?? -1);

const metricTotals = (
  response: Response
): Effect.Effect<ReadonlyArray<string>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    expect(response.status).toBe(200);
    const view = (yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
    )(yield* Effect.tryPromise(() => response.json()))).data;
    const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
      node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
    const metric = leaves(view.layout).find(
      (node) => node.kind === "leaf" && node.widget.widget.type === "custom-metric"
    );
    if (metric?.kind !== "leaf" || !("moneyGroups" in metric.widget.result)) {
      throw new Error("Expected custom metric");
    }
    return metric.widget.result.moneyGroups.map((group) => BigDecimal.format(group.outflow.amount));
  });

const listIds = (
  response: Response,
  widgetId: string
): Effect.Effect<ReadonlyArray<string>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    expect(response.status).toBe(200);
    const view = (yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
    )(yield* Effect.tryPromise(() => response.json()))).data;
    const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
      node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
    const list = leaves(view.layout).find(
      (node) => node.kind === "leaf" && node.widget.widget.id === widgetId
    );
    if (list?.kind !== "leaf" || !("transactions" in list.widget.result)) {
      throw new Error("Expected list results");
    }
    return list.widget.result.transactions.map((transaction) => transaction.id);
  });

it(
  "uninitialized queries observe absence for each User without creating domain state",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        for (const user of [0, 1]) {
          for (const path of ["/dashboard", "/dashboard/view"]) {
            const response = yield* Effect.tryPromise(() => send(db, user, path));
            expect(response.status).toBe(404);
            expect(yield* Effect.tryPromise(() => response.json())).toEqual({
              error: {
                code: "dashboard_uninitialized",
                message: "Initialize your Dashboard explicitly, then read it again.",
              },
              next: [],
            });
          }
        }
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT COUNT(*) AS count FROM dashboard_documents").first()
          )
        ).toEqual({ count: 0 });
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(2);
      })
    ),
  30_000
);

it(
  "unreadable Dashboard storage is unavailable, not an invitation to initialize",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() => db.prepare("DROP TABLE dashboard_documents").run());
        for (const path of ["/dashboard", "/dashboard/view"]) {
          const reply = yield* Effect.tryPromise(() => send(db, 0, path));
          expect(reply.status).toBe(503);
          expect(yield* Effect.tryPromise(() => reply.json())).toEqual({ status: "unavailable" });
        }
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
      })
    ),
  30_000
);

it(
  "read-only PAT queries preserve retained state and cannot create through mutation batches",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const token = `fin_${"q".repeat(8)}_${"q".repeat(43)}`;
        const id = "40000000-0000-4000-8000-000000000095";
        yield* seedPAT(db, { token, scope: "read", id });
        expect((yield* Effect.tryPromise(() => send(db, token, "/dashboard"))).status).toBe(404);
        expect((yield* Effect.tryPromise(() => send(db, token, "/dashboard/view"))).status).toBe(
          404
        );
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect((yield* Effect.tryPromise(() => initialize(db))).status).toBe(200);
        const retained = (): Promise<unknown> =>
          db
            .prepare("SELECT * FROM dashboard_documents ORDER BY user_id")
            .all()
            .then((rows) => rows.results);
        const before = yield* Effect.tryPromise(retained);
        for (const path of ["/dashboard", "/dashboard/view"]) {
          expect((yield* Effect.tryPromise(() => send(db, token, path))).status).toBe(200);
        }
        const subject = {
          id: sessions[0] ?? "",
          userId: users[0] ?? "",
          digest: yield* Effect.tryPromise(() => digest(bearer(0))),
        };
        for (const operation of ["dashboard.getDashboard", "dashboard.getDashboardView"] as const) {
          const hosted = yield* executeCanonicalQuery({
            db,
            subject,
            operation: CanonicalOperationId.make(operation),
            input: {},
            bucket: Option.none(),
          });
          expect(Option.getOrThrow(hosted).status).toBe(200);
          const absent = yield* executeCanonicalQuery({
            db,
            subject: {
              id: sessions[1] ?? "",
              userId: users[1] ?? "",
              digest: yield* Effect.tryPromise(() => digest(bearer(1))),
            },
            operation: CanonicalOperationId.make(operation),
            input: {},
            bucket: Option.none(),
          });
          expect(Option.getOrThrow(absent).status).toBe(404);
          const rejected = yield* Effect.tryPromise(() =>
            send(db, token, {
              path: "/operations/atomic-batch",
              method: "POST",
              body: { calls: [batchCall(operation, {}, 1)] },
            })
          );
          expect(rejected.status).toBe(400);
        }
        for (const call of [
          { path: "/dashboard/initialize", body: {} },
          { path: "/dashboard/edits", body: { op: "set-title", title: "Not allowed" } },
          {
            path: "/transactions",
            body: { money: { amount: "1", currency: "COP" }, direction: "outflow" },
          },
        ]) {
          expect(
            (yield* Effect.tryPromise(() => send(db, token, { ...call, method: "POST" }))).status
          ).toBe(403);
        }
        const foreign = yield* executeCanonicalQuery({
          db,
          subject: { ...subject, userId: Option.getOrThrow(Option.fromUndefinedOr(users[1])) },
          operation: CanonicalOperationId.make("dashboard.getDashboard"),
          input: {},
          bucket: Option.none(),
        });
        expect(Option.getOrThrow(foreign).status).toBe(401);
        const writeToken = `fin_${"w".repeat(8)}_${"u".repeat(43)}`;
        const writeId = "40000000-0000-4000-8000-000000000096";
        yield* seedPAT(db, { token: writeToken, scope: "write", id: writeId });
        const underScoped = yield* executeCanonicalQuery({
          db,
          subject: {
            patId: writeId,
            userId: subject.userId,
            digest: yield* Effect.tryPromise(() => digest(writeToken)),
            requiredScope: Option.none(),
          },
          operation: CanonicalOperationId.make("dashboard.getDashboardView"),
          input: {},
          bucket: Option.none(),
        });
        expect(Option.getOrThrow(underScoped).status).toBe(401);
        expect(yield* Effect.tryPromise(retained)).toEqual(before);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT COUNT(*) AS count FROM transactions").first()
          )
        ).toEqual({ count: 0 });
        const evidence = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT operation, outcome FROM pat_audit WHERE pat_id = ? ORDER BY rowid")
            .bind(id)
            .all()
        );
        expect(evidence.results.filter((row) => row.outcome === "accepted")).toEqual([
          { operation: "dashboard.getDashboard", outcome: "accepted" },
          { operation: "dashboard.getDashboardView", outcome: "accepted" },
          { operation: "dashboard.getDashboard", outcome: "accepted" },
          { operation: "dashboard.getDashboardView", outcome: "accepted" },
        ]);
      })
    ),
  30_000
);

it("preserves Dashboard input refusals through coordinated HTTP and hosted query execution", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* initializedSetup();
      const beforeAudit = yield* Effect.tryPromise(() => count(db, "dashboard_audit"));
      const credential = {
        id: sessions[0] ?? "",
        userId: users[0] ?? "",
        digest: yield* Effect.tryPromise(() => digest(bearer(0))),
      };
      for (const [operation, path] of [
        ["dashboard.getDashboard", "/dashboard"],
        ["dashboard.getDashboardView", "/dashboard/view"],
      ] as const) {
        for (const suffix of ["?unexpected=1", "?unexpected=1&unexpected=2"]) {
          const http = yield* Effect.tryPromise(() => send(db, 0, `${path}${suffix}`));
          expect(http.status).toBe(400);
          const hosted = Option.getOrThrow(
            yield* executeCanonicalQuery({
              db,
              subject: credential,
              operation: CanonicalOperationId.make(operation),
              input: { query: { unexpected: "1" } },
              bucket: Option.none(),
            })
          );
          expect(hosted.status).toBe(400);
          expect(yield* Effect.tryPromise(() => http.json())).toEqual(
            yield* Effect.tryPromise(() => hosted.json())
          );
        }
      }
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(beforeAudit);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT user_id, revision FROM dashboard_documents ORDER BY user_id").all()
        )).results
      ).toEqual([{ user_id: users[0], revision: 1 }]);
    })
  ));

it("rejects a substituted query target, mutation id or foreign User admission before Dashboard effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* initializedSetup();
      const coordinator = new UserTransactionCoordinator(
        {
          id: { name: users[0] ?? "" },
          storage: { setAlarm: (): Promise<void> => Promise.resolve() },
        },
        {
          DB: db,
          AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
          HOSTED_AI_MODEL: approvedWorkersAiModel,
        }
      );
      const beforeAudit = yield* Effect.tryPromise(() => count(db, "dashboard_audit"));
      for (const attack of [
        { index: 0, operation: "dashboard.getDashboard", target: "/transactions" },
        { index: 0, operation: "dashboard.getDashboard", target: "//attacker.test/dashboard" },
        { index: 0, operation: "dashboard.initializeDashboard", target: "/dashboard/initialize" },
        { index: 1, operation: "dashboard.getDashboard", target: "/dashboard" },
      ]) {
        const proof = yield* Effect.tryPromise(() => digest(bearer(attack.index)));
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          _tag: "WebSessionWork",
          userId: users[attack.index],
          sessionId: sessions[attack.index],
          digest: Array.from(proof),
          work: { _tag: "Query", operation: attack.operation, target: attack.target },
        });
        const response = yield* Effect.tryPromise(() =>
          coordinator.fetch(
            new Request("https://coordinator.internal/query", {
              method: "POST",
              body,
            })
          )
        );
        expect(response.status).toBe(503);
        expect(yield* Effect.tryPromise(() => response.json())).toEqual({ status: "unavailable" });
      }
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(beforeAudit);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT user_id, revision FROM dashboard_documents ORDER BY user_id").all()
        )).results
      ).toEqual([{ user_id: users[0], revision: 1 }]);
    })
  ));

type QueryFault = "revoked" | "withdrawn" | "audit-failed";
const assertQueryRefusal = Effect.fn(function* ({
  reply,
  http,
  pat,
  fault,
}: Readonly<{ reply: Response; http: boolean; pat: boolean; fault: QueryFault }>) {
  const noAuthority = http && (fault === "withdrawn" || (pat && fault === "revoked"));
  expect(reply.status).toBe(noAuthority ? 401 : 503);
  expect(yield* Effect.tryPromise(() => reply.json())).toEqual(
    noAuthority
      ? {
          error: {
            code: "unauthenticated",
            message: "Present a currently authorized credential and retry.",
          },
          next: [],
        }
      : { status: "unavailable" }
  );
});
const queryFault = ({
  db,
  fault,
  pat,
  patId,
}: Readonly<{
  db: D1Database;
  fault: QueryFault;
  pat: boolean;
  patId: string;
}>): Promise<unknown> => {
  if (fault === "revoked") {
    return pat
      ? db
          .prepare("UPDATE pats SET revoked_at_ms = ? WHERE id = ?")
          .bind(DateTime.nowUnsafe().epochMilliseconds, patId)
          .run()
      : db
          .prepare("UPDATE web_sessions SET hard_expires_at_ms = 0 WHERE id = ?")
          .bind(sessions[0])
          .run();
  }
  if (fault === "audit-failed") {
    return db
      .prepare(
        `CREATE TRIGGER refuse_query_audit BEFORE INSERT ON ${pat ? "pat_audit" : "dashboard_audit"} BEGIN SELECT RAISE(ABORT, 'test_unavailable'); END`
      )
      .run();
  }
  const current = DateTime.nowUnsafe().epochMilliseconds;
  const grant = "50000000-0000-4000-8000-000000000003";
  return db.batch([
    db
      .prepare(
        `INSERT INTO onboarding_consent_records (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES (?,?,'{}','disclosure','decision',?,?)`
      )
      .bind(grant, users[0], current, current),
    db
      .prepare(
        `INSERT INTO consent_user_revocations (id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES (?,?,?,?,?)`
      )
      .bind("50000000-0000-4000-8000-000000000004", users[0], grant, sessions[0], current),
  ]);
};

const queryReleaseFailure = Effect.fnUntraced(function* ({
  fault,
  pat,
  http,
  operation,
}: Readonly<{
  fault: QueryFault;
  pat: boolean;
  http: boolean;
  operation: "dashboard.getDashboard" | "dashboard.getDashboardView";
}>) {
  const db = yield* initializedSetup();
  expect((yield* Effect.tryPromise(() => initialize(db, 1))).status).toBe(200);
  const token = `fin_${"r".repeat(8)}_${"j".repeat(43)}`;
  const patId = "40000000-0000-4000-8000-000000000097";
  yield* seedPAT(db, { token, scope: "read", id: patId });
  const beforeDocuments = yield* Effect.tryPromise(() =>
    db.prepare("SELECT * FROM dashboard_documents ORDER BY user_id").all()
  );
  const beforeAudit = yield* Effect.tryPromise(() => count(db, "dashboard_audit"));
  let accountingPrepared = false;
  let injected = false;
  const guarded: D1Database = {
    prepare: (sql) => {
      if (sql.includes("INSERT INTO pat_audit") || sql.includes("INSERT INTO dashboard_audit")) {
        accountingPrepared = true;
      }
      return db.prepare(sql);
    },
    batch: <Row = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> => {
      if (accountingPrepared && !injected) {
        injected = true;
        return queryFault({ db, fault, pat, patId }).then(() => db.batch<Row>(statements));
      }
      return db.batch<Row>(statements);
    },
    exec: (sql) => db.exec(sql),
    withSession: (constraint) => db.withSession(constraint),
    dump: () => db.dump(),
  };
  const subject = pat
    ? {
        patId,
        userId: users[0] ?? "",
        digest: yield* Effect.tryPromise(() => digest(token)),
        requiredScope: Option.some("read" as const),
      }
    : {
        id: sessions[0] ?? "",
        userId: users[0] ?? "",
        digest: yield* Effect.tryPromise(() => digest(bearer(0))),
      };
  const reply = http
    ? yield* Effect.tryPromise(() =>
        send(
          guarded,
          pat ? token : 0,
          operation === "dashboard.getDashboard" ? "/dashboard" : "/dashboard/view"
        )
      )
    : Option.getOrThrow(
        yield* executeCanonicalQuery({
          db: guarded,
          subject,
          operation: CanonicalOperationId.make(operation),
          input: {},
          bucket: Option.none(),
        })
      );
  expect(injected).toBe(true);
  yield* assertQueryRefusal({ reply, http, pat, fault });
  expect(
    (yield* Effect.tryPromise(() =>
      db.prepare("SELECT * FROM dashboard_documents ORDER BY user_id").all()
    )).results
  ).toEqual(beforeDocuments.results);
  expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(beforeAudit);
  expect(
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT COUNT(*) AS count FROM pat_audit WHERE pat_id = ?").bind(patId).first()
    )
  ).toEqual({ count: 0 });
  expect(
    yield* Effect.tryPromise(() =>
      db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
    )
  ).toEqual({ last_used_at_ms: null });
});

for (const fault of ["revoked", "withdrawn", "audit-failed"] as const) {
  for (const caller of [
    { pat: false, http: false },
    { pat: false, http: true },
    { pat: true, http: false },
    { pat: true, http: true },
  ]) {
    for (const operation of ["dashboard.getDashboard", "dashboard.getDashboardView"] as const) {
      it(
        `withholds ${operation} and all accounting when ${caller.pat ? "PAT" : "WebSession"} ${fault} occurs at the ${caller.http ? "HTTP" : "published query seam"} release commit`,
        () => Effect.runPromise(queryReleaseFailure({ fault, ...caller, operation })),
        30_000
      );
    }
  }
}

it(
  "explicit initialization creates one valid document and preserves edits and revision on concurrent retries",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const initialize = (): Promise<Response> =>
          send(db, 0, { path: "/dashboard/initialize", method: "POST", body: {} });
        const replies = yield* Effect.tryPromise(() => Promise.all([initialize(), initialize()]));
        expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
        const documents = yield* Effect.forEach(replies, (reply) =>
          Effect.tryPromise(() => reply.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
              )
            )
          )
        );
        expect(documents[0]).toEqual(documents[1]);
        expect(documents[0].data.title).toBe("Tablero");
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(1);
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: "/dashboard/edits",
              method: "POST",
              body: { op: "set-title", title: "Keep my edits" },
            })
          )).status
        ).toBe(200);
        const stored = (): Promise<unknown> =>
          db
            .prepare("SELECT document_json, revision FROM dashboard_documents WHERE user_id = ?")
            .bind(users[0])
            .first();
        const before = yield* Effect.tryPromise(stored);
        const repeated = yield* Effect.tryPromise(() => Promise.all([initialize(), initialize()]));
        expect(repeated.map((reply) => reply.status)).toEqual([200, 200]);
        for (const reply of repeated) {
          const document = yield* Schema.decodeUnknownEffect(DocumentReply)(
            yield* Effect.tryPromise(() => reply.json())
          );
          expect(document.data.title).toBe("Keep my edits");
        }
        const batched = yield* Effect.tryPromise(() =>
          batch(db, [batchCall("dashboard.initializeDashboard", {}, 1)])
        );
        expect(batched.status).toBe(200);
        expect(
          (yield* Schema.decodeUnknownEffect(BatchDashboard)(
            yield* Effect.tryPromise(() => batched.json())
          )).data.results[0]?.output.data.title
        ).toBe("Keep my edits");
        expect(yield* Effect.tryPromise(stored)).toEqual(before);
        expect(before).toMatchObject({ revision: 2 });
      })
    ),
  30_000
);

it(
  "dashboard-scoped PAT initialization is attributable and read-only attempts cannot partially commit a batch",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const read = `fin_${"r".repeat(8)}_${"d".repeat(43)}`;
        const dashboard = `fin_${"d".repeat(8)}_${"e".repeat(43)}`;
        const dashboardId = "40000000-0000-4000-8000-000000000093";
        yield* seedPAT(db, {
          token: read,
          scope: "read",
          id: "40000000-0000-4000-8000-000000000094",
        });
        yield* seedPAT(db, { token: dashboard, scope: "dashboard", id: dashboardId });
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, read, {
              path: "/dashboard/initialize",
              method: "POST",
              body: {},
            })
          )).status
        ).toBe(403);
        const denied = yield* Effect.tryPromise(() =>
          send(db, read, {
            path: "/operations/atomic-batch",
            method: "POST",
            body: {
              calls: [batchCall("dashboard.initializeDashboard", {}, 2)],
            },
          })
        );
        expect(denied.status).toBe(403);
        expect(
          (yield* Schema.decodeUnknownEffect(ScopeMissing)(
            yield* Effect.tryPromise(() => denied.json())
          )).error
        ).toMatchObject({ code: "scope_missing" });
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
        const accepted = yield* Effect.tryPromise(() =>
          send(db, dashboard, {
            path: "/dashboard/initialize",
            method: "POST",
            body: {},
          })
        );
        expect(accepted.status).toBe(200);
        const initial = yield* Effect.tryPromise(() => accepted.json());
        const repeated = yield* Effect.tryPromise(() =>
          send(db, dashboard, {
            path: "/operations/atomic-batch",
            method: "POST",
            body: {
              calls: [batchCall("dashboard.initializeDashboard", {}, 3)],
            },
          })
        );
        expect(repeated.status).toBe(200);
        const results = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              results: Schema.Array(Schema.Struct({ output: Schema.Json })),
            }),
          })
        )(yield* Effect.tryPromise(() => repeated.json()));
        expect(results.data.results[0]?.output).toEqual(initial);
        const evidence = yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT user_id, pat_id, operation, outcome FROM pat_audit WHERE operation = 'dashboard.initializeDashboard' AND outcome = 'accepted' ORDER BY rowid"
            )
            .all()
        );
        expect(evidence.results).toEqual(
          [0, 1].map(() => ({
            user_id: users[0],
            pat_id: dashboardId,
            operation: "dashboard.initializeDashboard",
            outcome: "accepted",
          }))
        );
      })
    ),
  30_000
);

it(
  "write and dashboard PAT scopes remain independent for individual mutations and later batch children",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const scope of ["write", "dashboard"] as const) {
          const db = yield* setup();
          const token = `fin_${"a".repeat(8)}_${"b".repeat(43)}`;
          yield* seedPAT(db, { token, scope, id: "40000000-0000-4000-8000-000000000097" });
          const transaction = {
            payload: {
              money: { amount: "25.02", currency: "COP" },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt: "2026-01-01T12:00:00.000Z",
            },
          };
          const forbidden =
            scope === "write"
              ? { path: "/dashboard/initialize", method: "POST" as const, body: {} }
              : { path: "/transactions", method: "POST" as const, body: transaction.payload };
          expect((yield* Effect.tryPromise(() => send(db, token, forbidden))).status).toBe(403);
          const calls =
            scope === "write"
              ? [
                  batchCall("transactions.createTransaction", transaction, 1),
                  batchCall("dashboard.initializeDashboard", {}, 2),
                ]
              : [
                  batchCall("dashboard.initializeDashboard", {}, 1),
                  batchCall("transactions.createTransaction", transaction, 2),
                ];
          const denied = yield* Effect.tryPromise(() =>
            send(db, token, {
              path: "/operations/atomic-batch",
              method: "POST",
              body: { calls },
            })
          );
          expect(denied.status).toBe(403);
          expect(
            (yield* Schema.decodeUnknownEffect(ScopeMissing)(
              yield* Effect.tryPromise(() => denied.json())
            )).error
          ).toMatchObject({ code: "scope_missing" });
          expect(
            yield* Effect.tryPromise(() =>
              db.prepare("SELECT COUNT(*) AS count FROM transactions").first()
            )
          ).toEqual({ count: 0 });
          expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
          expect(
            yield* Effect.tryPromise(() =>
              db
                .prepare("SELECT COUNT(*) AS count FROM pat_audit WHERE outcome = 'accepted'")
                .first()
            )
          ).toEqual({ count: 0 });
        }
      })
    ),
  30_000
);

it(
  "a foreign User credential is refused before individual or batch initialization, without revealing or changing either document",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: "/dashboard/edits",
              method: "POST",
              body: { op: "set-title", title: "Private User A" },
            })
          )).status
        ).toBe(200);
        const snapshot = (): Promise<unknown> =>
          db
            .prepare("SELECT * FROM dashboard_documents ORDER BY user_id")
            .all()
            .then((rows) => rows.results);
        const before = yield* Effect.tryPromise(snapshot);
        const foreignDigest = yield* Effect.tryPromise(() => digest(bearer(1)));
        const ownerDigest = yield* Effect.tryPromise(() => digest(bearer(0)));
        const subjects = [
          { userId: users[0] ?? "", id: sessions[1] ?? "", digest: foreignDigest },
          { userId: users[1] ?? "", id: sessions[0] ?? "", digest: ownerDigest },
        ];
        const operation = CanonicalOperationId.make("dashboard.initializeDashboard");
        for (const subject of subjects) {
          for (const work of [
            { _tag: "Call" as const, operation, input: {} },
            {
              _tag: "Batch" as const,
              calls: [batchCall("dashboard.initializeDashboard", {}, 1)] as const,
            },
          ]) {
            const response = yield* executeCanonicalWork({
              db,
              bucket: Option.none(),
              subject,
              current: DateTime.nowUnsafe().epochMilliseconds,
              work,
              hostedFence: Option.none(),
              oauthConfirmation: Option.none(),
              inference: Option.none(),
            });
            expect(response.status).not.toBe(200);
            expect(yield* Effect.tryPromise(() => response.text())).not.toContain("Private User A");
            expect(yield* Effect.tryPromise(snapshot)).toEqual(before);
          }
        }
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(1);
        // The real User B may initialize only B's document, including through the public batch.
        const other = yield* Effect.tryPromise(() =>
          send(db, 1, {
            path: "/operations/atomic-batch",
            method: "POST",
            body: { calls: [batchCall("dashboard.initializeDashboard", {}, 2)] },
          })
        );
        expect(other.status).toBe(200);
        expect(
          (yield* Schema.decodeUnknownEffect(BatchDashboard)(
            yield* Effect.tryPromise(() => other.json())
          )).data.results[0]?.output.data.title
        ).toBe("Tablero");
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(1);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT revision FROM dashboard_documents WHERE user_id = ?")
              .bind(users[1])
              .first()
          )
        ).toEqual({ revision: 1 });
      })
    ),
  30_000
);

it(
  "initialization obeys document-child collision policy and rolls back when required evidence cannot commit",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const collision = yield* Effect.tryPromise(() =>
          batch(db, [
            batchCall("dashboard.initializeDashboard", {}, 1),
            batchCall(
              "dashboard.applyDashboardEdit",
              { payload: { op: "set-title", title: "Collision" } },
              2
            ),
          ])
        );
        expect(collision.status).toBe(400);
        expect(
          (yield* Schema.decodeUnknownEffect(BatchFailure)(
            yield* Effect.tryPromise(() => collision.json())
          )).error
        ).toMatchObject({ code: "validation_failed", failedCallIndex: 1 });
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        yield* Effect.tryPromise(() =>
          db
            .prepare(`CREATE TRIGGER refuse_initialization_audit BEFORE INSERT ON dashboard_audit
      WHEN NEW.operation = 'dashboard.initializeDashboard' BEGIN SELECT RAISE(ABORT, 'test_unavailable'); END`)
            .run()
        );
        const before = yield* Effect.tryPromise(() => count(db, "dashboard_audit"));
        const responses = [
          yield* Effect.tryPromise(() =>
            send(db, 0, { path: "/dashboard/initialize", method: "POST", body: {} })
          ),
          yield* Effect.tryPromise(() =>
            batch(db, [batchCall("dashboard.initializeDashboard", {}, 3)])
          ),
        ];
        expect(responses.map((response) => response.status)).toEqual([503, 503]);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(before);
      })
    ),
  30_000
);

it(
  "initialization rechecks PAT authority at commit for individual and atomic-batch execution",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const batched of [false, true]) {
          const db = yield* setup();
          const token = `fin_${"d".repeat(8)}_${"g".repeat(43)}`;
          const id = "40000000-0000-4000-8000-000000000095";
          yield* seedPAT(db, { token, scope: "dashboard", id });
          let prepared = false;
          let revoked = false;
          // Revoke through the real binding after owner preparation, immediately before its commit.
          const guarded: D1Database = {
            prepare: (sql) => {
              if (sql.includes("INSERT INTO dashboard_documents")) prepared = true;
              return db.prepare(sql);
            },
            batch: <Row = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> => {
              if (prepared && !revoked) {
                revoked = true;
                return db
                  .prepare("UPDATE pats SET revoked_at_ms = ? WHERE id = ?")
                  .bind(DateTime.nowUnsafe().epochMilliseconds, id)
                  .run()
                  .then(() => db.batch<Row>(statements));
              }
              return db.batch<Row>(statements);
            },
            exec: (sql) => db.exec(sql),
            withSession: (constraint) => db.withSession(constraint),
            dump: () => db.dump(),
          };
          const response = yield* Effect.tryPromise(() =>
            send(
              guarded,
              token,
              batched
                ? {
                    path: "/operations/atomic-batch",
                    method: "POST",
                    body: {
                      calls: [batchCall("dashboard.initializeDashboard", {}, 1)],
                    },
                  }
                : { path: "/dashboard/initialize", method: "POST", body: {} }
            )
          );
          expect(revoked).toBe(true);
          expect(response.status).not.toBe(200);
          expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
          expect(
            yield* Effect.tryPromise(() =>
              db.prepare("SELECT COUNT(*) AS count FROM pat_audit").first()
            )
          ).toEqual({ count: 0 });
          expect(
            yield* Effect.tryPromise(() =>
              db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(id).first()
            )
          ).toEqual({ last_used_at_ms: null });
        }
      })
    ),
  30_000
);

it(
  "withdrawn Consent refuses initialization and batch siblings without domain effects or success evidence",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const token = `fin_${"d".repeat(8)}_${"h".repeat(43)}`;
        yield* seedPAT(db, {
          token,
          scope: "dashboard",
          id: "40000000-0000-4000-8000-000000000096",
        });
        const current = DateTime.nowUnsafe().epochMilliseconds;
        const grant = "50000000-0000-4000-8000-000000000001";
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(`INSERT INTO onboarding_consent_records
        (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
        VALUES (?,?,'{}','disclosure','decision',?,?)`)
              .bind(grant, users[0], current, current),
            db
              .prepare(`INSERT INTO consent_user_revocations (id,user_id,grant_record_id,session_id,occurred_at_ms)
        VALUES (?,?,?,?,?)`)
              .bind("50000000-0000-4000-8000-000000000002", users[0], grant, sessions[0], current),
          ])
        );
        for (const credential of [token, 0]) {
          for (const batched of [false, true]) {
            const response = yield* Effect.tryPromise(() =>
              send(
                db,
                credential,
                batched
                  ? {
                      path: "/operations/atomic-batch",
                      method: "POST",
                      body: { calls: [batchCall("dashboard.initializeDashboard", {}, 1)] },
                    }
                  : { path: "/dashboard/initialize", method: "POST", body: {} }
              )
            );
            expect(response.status).toBe(typeof credential === "string" ? 403 : 401);
            if (typeof credential === "string") {
              expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
                error: { code: "user_action_required" },
              });
            }
          }
        }
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT COUNT(*) AS count FROM pat_audit").first()
          )
        ).toEqual({ count: 0 });
      })
    ),
  30_000
);

it(
  "extending initialization evidence preserves retained audits, append-only policy, retention and daily limits",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup(false);
        expect((yield* Effect.tryPromise(() => send(db, 0, "/dashboard"))).status).toBe(404);
        const evidence = (): Promise<unknown> =>
          db
            .prepare("SELECT * FROM dashboard_audit ORDER BY id")
            .all()
            .then((rows) => rows.results);
        const before = yield* Effect.tryPromise(evidence);
        yield* Effect.tryPromise(() =>
          applyTestMigration({
            db,
            source: new URL("../migrations/0030_dashboard_initialization.sql", import.meta.url),
          })
        );
        expect(yield* Effect.tryPromise(evidence)).toEqual(before);
        for (const sql of [
          "UPDATE dashboard_audit SET outcome = 'rejected'",
          "DELETE FROM dashboard_audit",
        ]) {
          expect(
            Option.isNone(yield* Effect.tryPromise(() => db.prepare(sql).run()).pipe(Effect.option))
          ).toBe(true);
          expect(yield* Effect.tryPromise(evidence)).toEqual(before);
        }
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, { path: "/dashboard/initialize", method: "POST", body: {} })
          )).status
        ).toBe(200);
        yield* Effect.tryPromise(() =>
          db
            .prepare(`INSERT INTO dashboard_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
      WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 254)
      SELECT printf('audit-%d', n), ?, ?, 'dashboard.initializeDashboard', 'accepted', ? FROM sequence`)
            .bind(users[0], sessions[0], DateTime.nowUnsafe().epochMilliseconds)
            .run()
        );
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, { path: "/dashboard/initialize", method: "POST", body: {} })
          )).status
        ).toBe(429);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(256);
        for (const path of ["/dashboard", "/dashboard/view"]) {
          expect((yield* Effect.tryPromise(() => send(db, 0, path))).status).toBe(429);
        }
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(256);
        // A permit for B cannot delete A's evidence, and cutoff equality is retained.
        const maximum = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT MAX(occurred_at_ms) AS time FROM dashboard_audit")
            .first<{ time: number }>()
        );
        const cutoff = maximum?.time ?? 0;
        yield* Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO audit_retention_permits VALUES (?, ?)")
            .bind(users[1], cutoff + 1)
            .run()
        );
        expect(
          Option.isNone(
            yield* Effect.tryPromise(() => db.prepare("DELETE FROM dashboard_audit").run()).pipe(
              Effect.option
            )
          )
        ).toBe(true);
        yield* Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO audit_retention_permits VALUES (?, ?)")
            .bind(users[0], cutoff)
            .run()
        );
        expect(
          Option.isNone(
            yield* Effect.tryPromise(() =>
              db.prepare("DELETE FROM dashboard_audit WHERE occurred_at_ms = ?").bind(cutoff).run()
            ).pipe(Effect.option)
          )
        ).toBe(true);
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE audit_retention_permits SET cutoff_ms = ? WHERE user_id = ?")
            .bind(cutoff + 1, users[0])
            .run()
        );
        yield* Effect.tryPromise(() =>
          db.prepare("DELETE FROM dashboard_audit WHERE user_id = ?").bind(users[0]).run()
        );
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
      })
    ),
  30_000
);

it(
  "a first invalid or missing Dashboard edit records only its refusal and never persists a document",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const invalid = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: { op: "set-title", title: "" },
          })
        );
        expect(invalid.status).toBe(400);
        const missing = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: {
              op: "remove-widget",
              widgetId: "30000000-0000-4000-8000-000000000099",
            },
          })
        );
        expect(missing.status).toBe(404);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        const rows = yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT operation, outcome FROM dashboard_audit WHERE user_id = ? ORDER BY rowid"
            )
            .bind(users[0])
            .all()
        );
        expect(rows.results).toEqual([
          { operation: "dashboard.applyDashboardEdit", outcome: "rejected" },
          { operation: "dashboard.applyDashboardEdit", outcome: "rejected" },
        ]);
      })
    ),
  30_000
);

it(
  "persists one Dashboard child through the public atomic batch and rolls back a failed sibling",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const rejected = yield* Effect.tryPromise(() =>
          batch(db, [
            batchCall("dashboard.initializeDashboard", {}, 1),
            batchCall(
              "dashboard.applyDashboardEdit",
              {
                payload: {
                  op: "remove-widget",
                  widgetId: "30000000-0000-4000-8000-000000000099",
                },
              },
              2
            ),
          ])
        );
        expect(rejected.status).toBe(400);
        expect(
          (yield* Schema.decodeUnknownEffect(BatchFailure)(
            yield* Effect.tryPromise(() => rejected.json())
          )).error
        ).toMatchObject({
          operation: "dashboard.applyDashboardEdit",
          failedCallIndex: 1,
          code: "not_found",
        });
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(1);
        const accepted = yield* Effect.tryPromise(() =>
          batch(db, [batchCall("dashboard.initializeDashboard", {}, 3)])
        );
        expect(accepted.status).toBe(200);
        expect(
          (yield* Schema.decodeUnknownEffect(BatchDashboard)(
            yield* Effect.tryPromise(() => accepted.json())
          )).data.results[0]?.output.data.title
        ).toBe("Tablero");
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(1);
        const repeated = yield* Effect.tryPromise(() =>
          batch(db, [
            batchCall("dashboard.initializeDashboard", {}, 4),
            batchCall(
              "dashboard.applyDashboardEdit",
              { payload: { op: "set-title", title: "Collision" } },
              5
            ),
          ])
        );
        expect(repeated.status).toBe(400);
        expect(
          (yield* Schema.decodeUnknownEffect(BatchFailure)(
            yield* Effect.tryPromise(() => repeated.json())
          )).error
        ).toMatchObject({
          failedCallIndex: 1,
          code: "validation_failed",
        });
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(2);
      })
    ),
  30_000
);

it(
  "keeps Dashboard read and edit scopes distinct inside atomic batches",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const token = `fin_${"r".repeat(8)}_${"c".repeat(43)}`;
        yield* seedPAT(db, { token, scope: "read", id: "30000000-0000-4000-8000-000000000071" });
        const denied = yield* Effect.tryPromise(() =>
          send(db, token, {
            path: "/operations/atomic-batch",
            method: "POST",
            body: {
              calls: [
                batchCall(
                  "dashboard.applyDashboardEdit",
                  { payload: { op: "set-title", title: "Not allowed" } },
                  1
                ),
              ],
            },
          })
        );
        expect(denied.status).toBe(403);
        expect(
          (yield* Schema.decodeUnknownEffect(ScopeMissing)(
            yield* Effect.tryPromise(() => denied.json())
          )).error.code
        ).toBe("scope_missing");
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
        const allowed = yield* Effect.tryPromise(() =>
          send(db, token, {
            path: "/operations/atomic-batch",
            method: "POST",
            body: {
              calls: [batchCall("dashboard.getDashboard", {}, 2)],
            },
          })
        );
        expect(allowed.status).toBe(400);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
      })
    ),
  30_000
);

it(
  "does not report a skipped Dashboard revision as a successful edit",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const created = yield* Effect.tryPromise(() => initialize(db));
        expect(created.status).toBe(200);
        yield* Effect.tryPromise(() =>
          db
            .prepare(`CREATE TRIGGER ignore_dashboard_update BEFORE UPDATE ON dashboard_documents
    BEGIN SELECT RAISE(IGNORE); END`)
            .run()
        );
        const response = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: {
              op: "set-title",
              title: "Not written",
            },
          })
        );
        expect(response.status).not.toBe(200);
        const documentResponse4 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
        expect(
          (yield* Schema.decodeUnknownEffect(DocumentReply)(
            yield* Effect.tryPromise(() => documentResponse4.json())
          )).data.title
        ).toBe("Tablero");
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(2);
      })
    ),
  30_000
);

it(
  "rolls back a Dashboard child when a later owner's guarded audit aborts the D1 batch",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() =>
          db
            .prepare(`CREATE TRIGGER reject_budget_success BEFORE INSERT ON budget_audit
    WHEN NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test_budget_unavailable'); END`)
            .run()
        );
        const reply = yield* Effect.tryPromise(() =>
          batch(db, [
            batchCall("dashboard.initializeDashboard", {}, 8),
            batchCall(
              "budgets.createBudget",
              {
                payload: {
                  categoryId: "10000000-0000-4000-8000-000000000001",
                  cap: { amount: "50000", currency: "COP" },
                },
              },
              9
            ),
          ])
        );
        expect(reply.status).toBe(503);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
        const budget = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM budgets WHERE user_id = ?")
            .bind(users[0])
            .first<{ count: number }>()
        );
        expect(budget?.count).toBe(0);
      })
    ),
  30_000
);

it(
  "rolls back explicit Dashboard initialization when its success Audit cannot commit",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() =>
          db
            .prepare(`CREATE TRIGGER reject_dashboard_success BEFORE INSERT ON dashboard_audit
    WHEN NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test_audit_unavailable'); END`)
            .run()
        );
        const reply = yield* Effect.tryPromise(() =>
          batch(db, [batchCall("dashboard.initializeDashboard", {}, 6)])
        );
        expect(reply.status).toBe(503);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
      })
    ),
  30_000
);

it(
  "a first valid edit commits the default and edit in the same unit for individual and batch callers",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const edited = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: {
              op: "set-title",
              title: "Individual",
            },
          })
        );
        expect(edited.status).toBe(200);
        expect(
          (yield* Schema.decodeUnknownEffect(DocumentReply)(
            yield* Effect.tryPromise(() => edited.json())
          )).data.title
        ).toBe("Individual");
        const second = yield* Effect.tryPromise(() =>
          batch(db, [
            batchCall(
              "dashboard.applyDashboardEdit",
              {
                payload: {
                  op: "set-title",
                  title: "Batch",
                },
              },
              7
            ),
          ])
        );
        expect(second.status).toBe(200);
        expect(
          (yield* Schema.decodeUnknownEffect(BatchDashboard)(
            yield* Effect.tryPromise(() => second.json())
          )).data.results[0]?.output.data.title
        ).toBe("Batch");
        const documentResponse5 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
        expect(
          (yield* Schema.decodeUnknownEffect(DocumentReply)(
            yield* Effect.tryPromise(() => documentResponse5.json())
          )).data.title
        ).toBe("Batch");
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(1);
      })
    ),
  30_000
);

it(
  "creates a valid DashboardDocument for each User without sharing later edits",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const first = yield* Effect.tryPromise(() => initialize(db));
        expect(first.status).toBe(200);
        const body = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
        )(yield* Effect.tryPromise(() => first.json()));
        const document = body.data;
        expect(document.title).toBe("Tablero");
        const edited = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: {
              op: "set-title",
              title: "Mi tablero",
            },
          })
        );
        expect(edited.status).toBe(200);
        expect((yield* Effect.tryPromise(() => send(db, 1, "/dashboard"))).status).toBe(404);
        const other = yield* Effect.tryPromise(() => initialize(db, 1));
        expect(other.status).toBe(200);
        const otherBody = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
        )(yield* Effect.tryPromise(() => other.json()));
        expect(otherBody.data.title).toBe("Tablero");
        const documentResponse6 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
        const after = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
        )(yield* Effect.tryPromise(() => documentResponse6.json()));
        expect(after.data.title).toBe("Mi tablero");
      })
    ),
  30_000
);

it(
  "rejects a malformed layout edit without replacing the authenticated User's document",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const before = (yield* Effect.tryPromise(() => initialize(db))).status;
        expect(before).toBe(200);
        const invalid = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: {
              op: "add-widget",
              at: "top",
              widget: {
                id: "10000000-0000-4000-8000-000000000081",
                type: "transaction-list",
                limit: 0,
              },
            },
          })
        );
        expect(invalid.status).toBe(400);
        const documentResponse7 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
        const document = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
        )(yield* Effect.tryPromise(() => documentResponse7.json()));
        expect(document.data.title).toBe("Tablero");
        expect(document.data.layout.kind).toBe("split");
      })
    ),
  30_000
);

it(
  "does not treat a corrupt retained Dashboard as an absent document",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        expect((yield* Effect.tryPromise(() => send(db, 0, "/dashboard"))).status).toBe(200);
        const before = yield* Effect.tryPromise(() => count(db, "dashboard_audit"));
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE dashboard_documents SET document_json = ? WHERE user_id = ?")
            .bind("{}", users[0])
            .run()
        );
        const edit = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: { op: "set-title", title: "Do not reset" },
          })
        );
        expect(edit.status).toBe(503);
        expect((yield* Effect.tryPromise(() => send(db, 0, "/dashboard"))).status).toBe(503);
        expect((yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"))).status).toBe(503);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(before);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT document_json FROM dashboard_documents WHERE user_id = ?")
              .bind(users[0])
              .first<{ document_json: string }>()
          )
        ).toMatchObject({ document_json: "{}" });
      })
    ),
  30_000
);

it(
  "cannot remove another User's Widget using a known WidgetId",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const documentResponse8 = yield* Effect.tryPromise(() => initialize(db));
        const owned = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
        )(yield* Effect.tryPromise(() => documentResponse8.json()))).data;
        const widgets = (node: DashboardDocument["layout"]): ReadonlyArray<string> =>
          node.kind === "leaf"
            ? [node.widget.id]
            : node.children.flatMap((child) => widgets(child.node));
        const foreignId = widgets(owned.layout)[0];
        expect(foreignId).toBeDefined();
        const refused = yield* Effect.tryPromise(() =>
          send(db, 1, {
            path: "/dashboard/edits",
            method: "POST",
            body: {
              op: "remove-widget",
              widgetId: foreignId,
            },
          })
        );
        expect(refused.status).toBe(404);
        const documentResponse9 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
        const after = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
        )(yield* Effect.tryPromise(() => documentResponse9.json()))).data;
        expect(widgets(after.layout)).toEqual(widgets(owned.layout));
      })
    ),
  30_000
);

it(
  "renders an empty validated DashboardView with current User context",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const result = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(result.status).toBe(200);
        const body = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => result.json()));
        expect(body.data.context).toMatchObject({
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
        });
        expect(body.data.layout.kind).toBe("split");
      })
    ),
  30_000
);

it(
  "finds a recent Transaction by its captured notes in a configured list Widget",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const documentResponse10 = yield* Effect.tryPromise(() => initialize(db));
        const document = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
        )(yield* Effect.tryPromise(() => documentResponse10.json()))).data;
        const leaves = (
          node: DashboardDocument["layout"]
        ): ReadonlyArray<DashboardDocument["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
        const list = leaves(document.layout).find(
          (node) => node.kind === "leaf" && node.widget.type === "transaction-list"
        );
        if (list?.kind !== "leaf" || list.widget.type !== "transaction-list") {
          throw new Error("Missing list");
        }
        const edited = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: {
              op: "update-widget",
              widget: { ...list.widget, search: "private note" },
            },
          })
        );
        expect(edited.status).toBe(200);
        const created = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount: "1.01", currency: "COP" },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
              notes: "private note Café",
            },
          })
        );
        expect(created.status).toBe(201);
        const viewResponse11 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        const view = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => viewResponse11.json()))).data;
        const viewLeaves = (
          node: DashboardView["layout"]
        ): ReadonlyArray<DashboardView["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => viewLeaves(child.node));
        const row = viewLeaves(view.layout).find(
          (node) => node.kind === "leaf" && node.widget.widget.id === list.widget.id
        );
        if (row?.kind !== "leaf" || !("transactions" in row.widget.result)) {
          throw new Error("Missing list result");
        }
        expect(row.widget.result.transactions).toHaveLength(1);
        const accented = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: { op: "update-widget", widget: { ...list.widget, search: "CAFÉ" } },
          })
        );
        expect(accented.status).toBe(200);
        const viewResponse12 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse12, list.widget.id)).toHaveLength(1);
        const twoCharacters = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: { op: "update-widget", widget: { ...list.widget, search: "fé" } },
          })
        );
        expect(twoCharacters.status).toBe(200);
        const viewResponse13 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse13, list.widget.id)).toHaveLength(1);
        const oneCharacter = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/dashboard/edits",
            method: "POST",
            body: { op: "update-widget", widget: { ...list.widget, search: "é" } },
          })
        );
        expect(oneCharacter.status).toBe(200);
        const viewResponse14 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse14, list.widget.id)).toHaveLength(1);
        const captured = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({ id: Transaction.fields.id }),
          })
        )(yield* Effect.tryPromise(() => created.json()))).data;
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: `/transactions/${captured.id}`,
              method: "PUT",
              body: { expectedRevision: 0, changes: { notes: "unrelated" } },
            })
          )).status
        ).toBe(200);
        const viewResponse15 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse15, list.widget.id)).toEqual([]);
      })
    ),
  30_000
);

it(
  "projects the current User's Budget with exact outflow spend and remaining Money",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const budget = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/budgets",
            method: "POST",
            body: {
              categoryId: "10000000-0000-4000-8000-000000000001",
              cap: { amount: "100.00", currency: "COP" },
            },
          })
        );
        expect(budget.status).toBe(201);
        const captured = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount: "25.02", currency: "COP" },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            },
          })
        );
        expect(captured.status).toBe(201);
        const viewResponse = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(viewResponse.status).toBe(200);
        const view = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => viewResponse.json()))).data;
        const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
        const bar = leaves(view.layout).find(
          (node) => node.kind === "leaf" && node.widget.widget.type === "budget-bar"
        );
        if (
          bar?.kind !== "leaf" ||
          !("availability" in bar.widget.result) ||
          bar.widget.result.availability !== "available"
        ) {
          throw new Error("Missing Budget bar");
        }
        expect(BigDecimal.format(bar.widget.result.spent.amount)).toBe("25.02");
        if (bar.widget.result.status.type !== "under") throw new Error("Expected remaining Budget");
        expect(BigDecimal.format(bar.widget.result.status.remaining.amount)).toBe("74.98");
      })
    ),
  30_000
);

it(
  "denies under-scoped and revoked PAT Dashboard work without modifying a document",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const readToken = `fin_${"r".repeat(8)}_${"a".repeat(43)}`;
        const writeToken = `fin_${"w".repeat(8)}_${"b".repeat(43)}`;
        const readId = "40000000-0000-4000-8000-000000000091";
        yield* seedPAT(db, { token: readToken, scope: "read", id: readId });
        yield* seedPAT(db, {
          token: writeToken,
          scope: "write",
          id: "40000000-0000-4000-8000-000000000092",
        });
        expect(
          (yield* Effect.tryPromise(() => send(db, writeToken, "/dashboard/view"))).status
        ).toBe(403);
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, readToken, {
              path: "/dashboard/edits",
              method: "POST",
              body: {
                op: "set-title",
                title: "Foreign title",
              },
            })
          )).status
        ).toBe(403);
        const before = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM dashboard_documents WHERE user_id = ?")
            .bind(users[0])
            .first<{ count: number }>()
        );
        expect(before?.count).toBe(1);
        expect(
          (yield* Effect.tryPromise(() => send(db, readToken, "/dashboard/view"))).status
        ).toBe(200);
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE pats SET revoked_at_ms = ? WHERE id = ?")
            .bind(DateTime.nowUnsafe().epochMilliseconds, readId)
            .run()
        );
        expect(
          (yield* Effect.tryPromise(() => send(db, readToken, "/dashboard/view"))).status
        ).not.toBe(200);
        const documentResponse16 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
        const document = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
        )(yield* Effect.tryPromise(() => documentResponse16.json()))).data;
        expect(document.title).toBe("Tablero");
      })
    ),
  30_000
);

it(
  "a stale Dashboard read is replaced by current canonical facts after a Transaction correction",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const created = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount: "10.01", currency: "COP" },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            },
          })
        );
        expect(created.status).toBe(201);
        const { data: transaction } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
        )(yield* Effect.tryPromise(() => created.json()));
        const before = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(before.status).toBe(200);
        const correction = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: `/transactions/${transaction.id}`,
            method: "PUT",
            body: { expectedRevision: 0, changes: { money: { amount: "25.02", currency: "COP" } } },
          })
        );
        expect(correction.status).toBe(200);
        const after = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(after.status).toBe(200);
        const view = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => after.json()))).data;
        const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
        const metric = leaves(view.layout).find(
          (node) => node.kind === "leaf" && node.widget.widget.type === "custom-metric"
        );
        expect(metric?.kind).toBe("leaf");
        if (metric?.kind !== "leaf" || !("moneyGroups" in metric.widget.result)) {
          throw new Error("Expected metric");
        }
        expect(
          metric.widget.result.moneyGroups.map((group) => BigDecimal.format(group.outflow.amount))
        ).toEqual(["25.02"]);
      })
    ),
  30_000
);

it(
  "reinterprets maintained UTC contributions immediately after a User IANA time-zone change",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const now = DateTime.nowUnsafe();
        const zones = (yield* Effect.forEach(["Pacific/Kiritimati", "America/Bogota"], (name) =>
          Effect.map(Schema.decodeEffect(IanaTimeZone)(name), (timeZone) => ({
            name,
            from: resolveDashboardPeriod({ now, period: "this-month", timeZone }).from
              .epochMilliseconds,
          }))
        )).sort((left, right) => left.from - right.from);
        const earlier = zones[0];
        const later = zones[1];
        if (earlier === undefined || later === undefined || earlier.from === later.from) {
          throw new Error("Expected distinct IANA month boundaries");
        }
        const occurredAt = DateTime.formatIso(DateTime.makeUnsafe(earlier.from + 60_000));
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: "/transactions",
              method: "POST",
              body: {
                money: { amount: "3.04", currency: "COP" },
                categoryId: "10000000-0000-4000-8000-000000000001",
                direction: "outflow",
                occurredAt,
              },
            })
          )).status
        ).toBe(201);

        const projected = (
          zone: string
        ): Effect.Effect<ReadonlyArray<string>, Cause.UnknownError | Schema.SchemaError> =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() =>
              db.prepare("UPDATE users SET time_zone = ? WHERE id = ?").bind(zone, users[0]).run()
            );
            return yield* metricTotals(
              yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"))
            );
          });
        expect(yield* projected(earlier.name)).toEqual(["3.04"]);
        expect(yield* projected(later.name)).toEqual([]);
        expect(yield* projected(earlier.name)).toEqual(["3.04"]);
      })
    ),
  30_000
);

it(
  "updates the next Dashboard view after linking, correcting, and unlinking effective Transactions",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const responses = yield* Effect.tryPromise(() =>
          Promise.all(
            [0, 1].map(() =>
              send(db, 0, {
                path: "/transactions",
                method: "POST",
                body: {
                  money: { amount: "7", currency: "COP" },
                  categoryId: "10000000-0000-4000-8000-000000000001",
                  direction: "outflow",
                  occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
                },
              })
            )
          )
        );
        expect(responses.map((response) => response.status)).toEqual([201, 201]);
        const bodies = yield* Effect.tryPromise(() =>
          Promise.all(responses.map((response) => response.json()))
        );
        const ids = yield* Effect.forEach(bodies, (body) =>
          Effect.map(
            Schema.decodeUnknownEffect(
              Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
            )(body),
            (decoded) => decoded.data.id
          )
        );
        const first = [...ids].sort()[0];
        const second = [...ids].sort()[1];
        if (first === undefined || second === undefined) throw new Error("Missing Transactions");

        const total = (): Effect.Effect<string, Cause.UnknownError | Schema.SchemaError> =>
          Effect.gen(function* () {
            return (yield* metricTotals(
              yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"))
            )).join(",");
          });
        expect(yield* total()).toBe("14");
        const pair = { firstTransactionId: first, secondTransactionId: second };
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, { path: "/transactions/link", method: "POST", body: pair })
          )).status
        ).toBe(200);
        expect(yield* total()).toBe("7");
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: `/transactions/${first}`,
              method: "PUT",
              body: { expectedRevision: 0, changes: { money: { amount: "9", currency: "COP" } } },
            })
          )).status
        ).toBe(200);
        expect(yield* total()).toBe("9");
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, { path: "/transactions/unlink", method: "POST", body: pair })
          )).status
        ).toBe(200);
        expect(yield* total()).toBe("16");
      })
    ),
  30_000
);

it(
  "retains exact decimal Money above SQLite's precise numeric range",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const time = DateTime.formatIso(DateTime.nowUnsafe());
        yield* Effect.tryPromise(() =>
          db
            .prepare(`INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    VALUES ('30000000-0000-4000-8000-000000000011', ?, '9007199254740993', 'COP', 'outflow', ?, ?, ?),
      ('30000000-0000-4000-8000-000000000012', ?, '9007199254740994', 'COP', 'outflow', ?, ?, ?)`)
            .bind(
              users[0],
              "10000000-0000-4000-8000-000000000001",
              time,
              time,
              users[0],
              "10000000-0000-4000-8000-000000000001",
              time,
              time
            )
            .run()
        );
        const viewResponse18 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* metricTotals(viewResponse18)).toEqual(["18014398509481987"]);
      })
    ),
  30_000
);

it(
  "keeps exact Currency totals beyond a small fixed Transaction window",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        // Spread retained records over days to respect the canonical 100-writes-per-day limit.
        yield* Effect.tryPromise(() =>
          db
            .prepare(`INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    WITH RECURSIVE sequence(number) AS (SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 4100)
    SELECT printf('30000000-0000-4000-8000-%012d', number), ?, '0.01', 'COP', 'outflow', ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', date('now', '-' || CAST(number / 90 AS INTEGER) || ' days'))
    FROM sequence`)
            .bind(
              users[0],
              "10000000-0000-4000-8000-000000000001",
              DateTime.formatIso(DateTime.nowUnsafe())
            )
            .run()
        );
        const reply = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(reply.status).toBe(200);
        const view = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => reply.json()))).data;
        const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
        const metric = leaves(view.layout).find(
          (node) => node.kind === "leaf" && node.widget.widget.type === "custom-metric"
        );
        if (metric?.kind !== "leaf" || !("moneyGroups" in metric.widget.result)) {
          throw new Error("Missing metric");
        }
        expect(
          BigDecimal.format(
            metric.widget.result.moneyGroups[0]?.outflow.amount ?? BigDecimal.make(0n, 0)
          )
        ).toBe("41");
      })
    ),
  60_000
);

it(
  "returns exact totals beyond 8,192 effective Transactions",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        expect((yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"))).status).toBe(200);
        // Bypass only the fixture's daily capture quota to exercise the read work budget.
        yield* Effect.tryPromise(() =>
          db.prepare("DROP TRIGGER transaction_manual_daily_budget").run()
        );
        yield* Effect.tryPromise(() =>
          db
            .prepare(`INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, notes, occurred_at, created_at)
    WITH RECURSIVE sequence(number) AS (SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 8193)
    SELECT printf('30000000-0000-4000-8000-%012d', number), ?, '0.01', 'COP', 'outflow',
      CASE WHEN number = 1 THEN '10000000-0000-4000-8000-000000000002' ELSE ? END,
      CASE WHEN number = 1 THEN 'Rare Café note' ELSE NULL END, ?, ?
    FROM sequence`)
            .bind(
              users[0],
              "10000000-0000-4000-8000-000000000001",
              DateTime.formatIso(DateTime.nowUnsafe()),
              DateTime.formatIso(DateTime.nowUnsafe())
            )
            .run()
        );
        const viewResponse19 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* metricTotals(viewResponse19)).toEqual(["81.93"]);
        const documentResponse20 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
        const document = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.toCodecJson(DashboardDocument),
          })
        )(yield* Effect.tryPromise(() => documentResponse20.json()))).data;
        const leaves = (
          node: DashboardDocument["layout"]
        ): ReadonlyArray<DashboardDocument["layout"]> =>
          node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
        const list = leaves(document.layout).find(
          (node) => node.kind === "leaf" && node.widget.type === "transaction-list"
        );
        if (list?.kind !== "leaf" || list.widget.type !== "transaction-list") {
          throw new Error("Expected list Widget");
        }
        const rareCategory = {
          ...list.widget,
          categories: ["10000000-0000-4000-8000-000000000002"],
        };
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: "/dashboard/edits",
              method: "POST",
              body: { op: "update-widget", widget: rareCategory },
            })
          )).status
        ).toBe(200);
        const viewResponse21 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse21, list.widget.id)).toEqual([
          "30000000-0000-4000-8000-000000000001",
        ]);
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, 0, {
              path: "/dashboard/edits",
              method: "POST",
              body: { op: "update-widget", widget: { ...rareCategory, search: "CAFÉ" } },
            })
          )).status
        ).toBe(200);
        const viewResponse22 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* listIds(viewResponse22, list.widget.id)).toEqual([
          "30000000-0000-4000-8000-000000000001",
        ]);
        // A damaged projection cannot become a stale financial view while its private repair proceeds.
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "UPDATE dashboard_projection_digit SET digit_sum = digit_sum + 5 WHERE user_id = ? AND position = 0"
            )
            .bind(users[0])
            .run()
        );
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE dashboard_projection_state SET readiness = 'dirty' WHERE user_id = ?")
            .bind(users[0])
            .run()
        );
        expect((yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"))).status).toBe(503);
        const repair = (
          remaining: number
        ): Effect.Effect<boolean, Effect.Error<ReturnType<typeof repairDashboardProjection>>> =>
          remaining <= 0
            ? Effect.succeed(false)
            : Effect.flatMap(repairDashboardProjection({ db, userId: users[0] ?? "" }), (status) =>
                status === "ready" ? Effect.succeed(true) : repair(remaining - 1)
              );
        expect(yield* repair(35)).toBe(false);
        // Bypass the fixture's daily capture admission limit to simulate a concurrent committed
        // effective Transaction during the private rebuild; both use the same D1 maintenance triggers.
        const time = DateTime.formatIso(DateTime.nowUnsafe());
        yield* Effect.tryPromise(() =>
          db
            .prepare(`INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    VALUES ('30000000-0000-4000-8000-000000009999', ?, '0.02', 'COP', 'outflow', ?, ?, ?)`)
            .bind(users[0], "10000000-0000-4000-8000-000000000001", time, time)
            .run()
        );
        expect((yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"))).status).toBe(503);
        expect(yield* repair(80)).toBe(true);
        const viewResponse23 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(yield* metricTotals(viewResponse23)).toEqual(["81.95"]);
      })
    ),
  60_000
);

it(
  "reads newly committed Transactions as exact separate Currency groups without another User's facts",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* initializedSetup();
        const occurredAt = DateTime.formatIso(DateTime.nowUnsafe());
        const capture = (index: number, amount: string, currency: string): Promise<Response> =>
          send(db, index, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount, currency },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt,
            },
          });
        expect((yield* Effect.tryPromise(() => capture(0, "1.01", "COP"))).status).toBe(201);
        expect((yield* Effect.tryPromise(() => capture(0, "2.02", "COP"))).status).toBe(201);
        expect((yield* Effect.tryPromise(() => capture(0, "5.50", "USD"))).status).toBe(201);
        expect((yield* Effect.tryPromise(() => capture(1, "999", "COP"))).status).toBe(201);
        const reply = yield* Effect.tryPromise(() => send(db, 0, "/dashboard/view"));
        expect(reply.status).toBe(200);
        const body = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
        )(yield* Effect.tryPromise(() => reply.json()));
        const leaves = (
          node: DashboardView["layout"]
        ): ReadonlyArray<Extract<DashboardView["layout"], { kind: "leaf" }>["widget"]> =>
          node.kind === "leaf"
            ? [node.widget]
            : node.children.flatMap((child) => leaves(child.node));
        const metric = leaves(body.data.layout).find(
          (leaf) => leaf.widget.type === "custom-metric"
        );
        if (metric === undefined || !("moneyGroups" in metric.result)) {
          throw new Error("Expected a custom metric");
        }
        expect(
          metric.result.moneyGroups.map((group) => [
            group.currency,
            BigDecimal.format(group.outflow.amount),
          ])
        ).toEqual([
          ["COP", "3.03"],
          ["USD", "5.5"],
        ]);
      })
    ),
  30_000
);

it.each(["/dashboard/view", "/dashboard/view?"])(
  "keeps one exact day chart at %s when a concurrent Correction moves a Transaction between buckets",
  (viewPath) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const zone = IanaTimeZone.make("America/Bogota");
        const period = resolveDashboardPeriod({
          now: DateTime.nowUnsafe(),
          period: "last-7-days",
          timeZone: zone,
        });
        const first = DateTime.add(period.from, { hours: 1 });
        const second = DateTime.add(first, { days: 1 });
        const localDate = (date: DateTime.Utc): string =>
          DateTime.formatIsoDate(DateTime.setZone(date, DateTime.zoneMakeNamedUnsafe(zone)));
        const document = yield* Schema.decodeEffect(DashboardDocument)({
          title: "Tablero",
          layout: {
            kind: "leaf",
            widget: {
              id: "30000000-0000-4000-8000-000000000099",
              type: "spending-chart",
              groupBy: "day",
              period: "last-7-days",
            },
          },
        });
        const encodedDocument = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(DashboardDocument))
        )(document);
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO dashboard_documents (user_id, document_json, revision) VALUES (?, ?, 1)"
            )
            .bind(users[0], encodedDocument)
            .run()
        );
        const captured = yield* Effect.tryPromise(() =>
          send(db, 0, {
            path: "/transactions",
            method: "POST",
            body: {
              money: { amount: "10", currency: "COP" },
              categoryId: "10000000-0000-4000-8000-000000000001",
              direction: "outflow",
              occurredAt: DateTime.formatIso(first),
            },
          })
        );
        expect(captured.status).toBe(201);
        const { data: transaction } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
        )(yield* Effect.tryPromise(() => captured.json()));

        const firstBucketRead = Promise.withResolvers<void>();
        const releaseView = Promise.withResolvers<void>();
        const correctionQueued = Promise.withResolvers<void>();
        let paused = false;
        const coordinatedOperations = new Set<string>();
        const aggregateStatements = new WeakSet<D1PreparedStatement>();
        const markAggregate = (statement: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(statement, {
            get(target, property, receiver): unknown {
              if (property === "bind") {
                return (...values: ReadonlyArray<unknown>): D1PreparedStatement => {
                  const bound = target.bind(...values);
                  aggregateStatements.add(bound);
                  return bound;
                };
              }
              return Reflect.get(target, property, receiver);
            },
          });
        // Pause the external D1 response after one real aggregate batch has read its old contribution.
        const delayed: D1Database = {
          prepare: (sql) =>
            sql.includes("FROM dashboard_projection_bucket")
              ? markAggregate(db.prepare(sql))
              : db.prepare(sql),
          batch: <Row = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
            db.batch<Row>(statements).then((results) => {
              if (!paused && statements.some((statement) => aggregateStatements.has(statement))) {
                paused = true;
                firstBucketRead.resolve();
                return releaseView.promise.then(() => results);
              }
              return results;
            }),
          exec: (sql) => db.exec(sql),
          withSession: (constraint) => db.withSession(constraint),
          dump: () => db.dump(),
        };
        const observe = (operation: string): void => {
          coordinatedOperations.add(operation);
          if (operation === "transactions.updateTransaction") correctionQueued.resolve();
        };
        coordinatorObservers.set(delayed, observe);
        const pendingView = send(delayed, 0, viewPath);
        yield* Effect.tryPromise(() => firstBucketRead.promise);
        const correction = send(delayed, 0, {
          path: `/transactions/${transaction.id}`,
          method: "PUT",
          body: { expectedRevision: 0, changes: { occurredAt: DateTime.formatIso(second) } },
        });
        try {
          // A coordinated Correction waits behind the view; an uncoordinated view permits its commit.
          // Both schedules attempt the same public Correction before the next calendar bucket is read.
          if (coordinatedOperations.has("dashboard.getDashboardView")) {
            yield* Effect.tryPromise(() => correctionQueued.promise);
          } else {
            expect((yield* Effect.tryPromise(() => correction)).status).toBe(200);
          }
        } finally {
          releaseView.resolve();
        }
        const chart = (
          reply: Response
        ): Effect.Effect<
          ReadonlyArray<Readonly<{ date: string; amount: string }>>,
          Schema.SchemaError | Cause.UnknownError
        > =>
          Effect.gen(function* () {
            expect(reply.status).toBe(200);
            const { data: view } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ data: Schema.toCodecJson(DashboardView) })
            )(yield* Effect.tryPromise(() => reply.json()));
            if (view.layout.kind !== "leaf" || !("buckets" in view.layout.widget.result)) {
              throw new Error("Expected day chart");
            }
            return view.layout.widget.result.buckets.map((bucket) => {
              if (bucket.key.kind !== "day") throw new Error("Expected local day");
              return {
                date: bucket.key.date,
                amount: BigDecimal.format(
                  bucket.moneyGroups[0]?.outflow.amount ?? BigDecimal.make(0n, 0)
                ),
              };
            });
          });
        expect(yield* chart(yield* Effect.tryPromise(() => pendingView))).toEqual([
          { date: localDate(first), amount: "10" },
        ]);
        expect((yield* Effect.tryPromise(() => correction)).status).toBe(200);
        coordinatorObservers.delete(delayed);
        expect(yield* chart(yield* Effect.tryPromise(() => send(delayed, 0, viewPath)))).toEqual([
          { date: localDate(second), amount: "10" },
        ]);
      })
    ),
  30_000
);

const dashboardOAuthSubject = (db: D1Database): Effect.Effect<OAuthCaller, Cause.UnknownError> =>
  Effect.gen(function* () {
    const current = DateTime.nowUnsafe().epochMilliseconds;
    const subject: OAuthCaller = {
      userId: UserId.make(users[0] ?? ""),
      oauthConnectionId: OAuthConnectionId.make("98800000-0000-4000-8000-000000000011"),
      credentialId: OAuthCredentialId.make("98800000-0000-4000-8000-000000000012"),
      clientId: OAuthClientId.make("98800000-0000-4000-8000-000000000013"),
      resource: oauthResource,
      digest: yield* Effect.tryPromise(() => digest("dashboard-oauth-fixture")),
      requiredScope: Option.some("dashboard"),
    };
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(`INSERT INTO onboarding_consent_records
          (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms)
          VALUES ('dashboard-onboarding', ?, '{}', 'fixture-disclosure', 'fixture-decision', ?, ?)`)
          .bind(subject.userId, current, current),
        db
          .prepare(`INSERT INTO oauth_connections
        (id, request_id, user_id, client_id, claimed_client_name, redirect_uri, resource, scopes_json, approved_at_ms, expires_at_ms)
        VALUES (?, ?, ?, ?, 'Dashboard fixture', 'https://client.example/callback', ?, '["dashboard"]', ?, ?)`)
          .bind(
            subject.oauthConnectionId,
            "dashboard-request",
            subject.userId,
            subject.clientId,
            subject.resource,
            current,
            current + 600000
          ),
        db
          .prepare(`INSERT INTO oauth_grant_consents
        (id, connection_id, user_id, session_id, disclosure_revision, disclosure_text, accepted_at_ms)
        VALUES ('dashboard-consent', ?, ?, ?, 'fixture', 'fixture', ?)`)
          .bind(subject.oauthConnectionId, subject.userId, sessions[0], current),
        db
          .prepare(`INSERT INTO oauth_access_credentials
        (id, connection_id, user_id, digest, issued_at_ms, expires_at_ms, scopes_json)
        VALUES (?, ?, ?, ?, ?, ?, '["dashboard"]')`)
          .bind(
            subject.credentialId,
            subject.oauthConnectionId,
            subject.userId,
            subject.digest,
            current,
            current + 600000
          ),
      ])
    );
    return subject;
  });

const disclosureWidgetA = "98800000-0000-4000-8000-000000000021";
const disclosureWidgetB = "98800000-0000-4000-8000-000000000022";
const disclosureWidgetC = "98800000-0000-4000-8000-000000000023";
const changedWidget = {
  id: disclosureWidgetC,
  type: "transaction-list",
  limit: 7,
  search: "Compra exacta",
};
const disclosureEdits = [
  {
    edit: { op: "set-title", title: "Mi nuevo tablero" },
    effect: 'Cambiar el título del Dashboard a "Mi nuevo tablero".',
  },
  {
    edit: { op: "remove-widget", widgetId: disclosureWidgetA },
    effect: `Eliminar del Dashboard el widget ${disclosureWidgetA}.`,
  },
  {
    edit: {
      op: "move-widget",
      widgetId: disclosureWidgetA,
      at: { besideWidget: disclosureWidgetB, axis: "column", side: "after" },
    },
    effect: `Mover el widget ${disclosureWidgetA} después del widget ${disclosureWidgetB}, en columna, sin cambiar su configuración.`,
  },
  {
    edit: { op: "swap-widgets", widgetId: disclosureWidgetA, withWidgetId: disclosureWidgetB },
    effect: `Intercambiar las posiciones de los widgets ${disclosureWidgetA} y ${disclosureWidgetB}.`,
  },
  {
    edit: {
      op: "resize-region",
      widgetIds: [disclosureWidgetA],
      size: { kind: "ratio", ratio: "one-third" },
    },
    effect: `Cambiar el tamaño de la región con los widgets [${disclosureWidgetA}] a proporción 1/3 respecto a sus regiones hermanas.`,
  },
  {
    edit: {
      op: "resize-region",
      widgetIds: [disclosureWidgetA],
      size: { kind: "weight", weight: 2.5 },
    },
    effect: `Cambiar el tamaño de la región con los widgets [${disclosureWidgetA}] a peso relativo 2.5.`,
  },
  {
    edit: { op: "add-widget", widget: changedWidget, at: "bottom" },
    effect: `Añadir el widget {"id":"${disclosureWidgetC}","type":"transaction-list","limit":7,"search":"Compra exacta"} al final del Dashboard.`,
  },
  {
    edit: { op: "update-widget", widget: { ...changedWidget, id: disclosureWidgetA } },
    effect: `Reemplazar toda la configuración del widget ${disclosureWidgetA}, sin moverlo, por {"id":"${disclosureWidgetA}","type":"transaction-list","limit":7,"search":"Compra exacta"}.`,
  },
];

it.each(disclosureEdits)(
  "OAuth disclosure describes the exact $edit.op without unrelated Dashboard content",
  ({ edit, effect }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const subject = yield* dashboardOAuthSubject(db);
        const document = yield* Schema.decodeEffect(DashboardDocument)({
          title: "Título privado no modificado",
          layout: {
            kind: "split",
            axis: "row",
            children: [
              {
                weight: 1,
                node: {
                  kind: "leaf",
                  widget: { id: disclosureWidgetA, type: "transaction-list", limit: 10 },
                },
              },
              {
                weight: 1,
                node: {
                  kind: "leaf",
                  widget: {
                    id: disclosureWidgetB,
                    type: "transaction-list",
                    limit: 10,
                    search: "Búsqueda privada no modificada",
                  },
                },
              },
            ],
          },
        });
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(DashboardDocument))
        )(document);
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO dashboard_documents (user_id, document_json, revision) VALUES (?, ?, 4)"
            )
            .bind(subject.userId, encoded)
            .run()
        );
        const prepared = yield* prepareDashboard({
          work: { db, subject, current: DateTime.nowUnsafe().epochMilliseconds },
          operation: "dashboard.applyDashboardEdit",
          edit: Option.some(yield* Schema.decodeUnknownEffect(DashboardEdit)(edit)),
        });
        expect(prepared._tag).toBe("Prepared");
        if (prepared._tag !== "Prepared") throw new Error("Expected Dashboard preparation");
        const review = Option.getOrThrow(prepared.mutation.oauthReview);
        expect(review.effect).toBe(effect);
        expect(review.effect).not.toContain(document.title);
        expect(review.effect).not.toContain("Búsqueda privada no modificada");
        expect(review.revision).toContain(encoded.replaceAll('"', '\\"'));
        yield* Effect.tryPromise(() => db.batch([...review.guards]));
        // A changed retained document at the same revision must still invalidate the exact snapshot.
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE dashboard_documents SET document_json = ? WHERE user_id = ?")
            .bind(encoded.replace("Título privado", "Título cambiado"), subject.userId)
            .run()
        );
        expect(
          Option.isNone(
            yield* Effect.tryPromise(() =>
              db.batch([...review.guards, ...prepared.mutation.statements])
            ).pipe(Effect.option)
          )
        ).toBe(true);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT revision FROM dashboard_documents WHERE user_id = ?")
              .bind(subject.userId)
              .first()
          )
        ).toEqual({ revision: 4 });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT COUNT(*) AS count FROM pat_audit WHERE oauth_connection_id = ?")
              .bind(subject.oauthConnectionId)
              .first()
          )
        ).toEqual({ count: 0 });
      })
    ),
  30_000
);

it(
  "OAuth first-edit disclosure and revision remain stable across preparation without creating a document",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const subject = yield* dashboardOAuthSubject(db);
        const reviews = [];
        for (const elapsed of [0, 1000]) {
          const prepared = yield* prepareDashboard({
            work: { db, subject, current: DateTime.nowUnsafe().epochMilliseconds + elapsed },
            operation: "dashboard.applyDashboardEdit",
            edit: Option.some(
              yield* Schema.decodeEffect(DashboardEdit)({ op: "set-title", title: "Primer cambio" })
            ),
          });
          if (prepared._tag !== "Prepared") throw new Error("Expected Dashboard preparation");
          const review = Option.getOrThrow(prepared.mutation.oauthReview);
          reviews.push({ effect: review.effect, revision: review.revision });
        }
        expect(reviews).toEqual([
          {
            effect:
              'Inicializar el Dashboard predeterminado y aplicar este cambio: Cambiar el título del Dashboard a "Primer cambio".',
            revision: '{"_tag":"Absent"}',
          },
          {
            effect:
              'Inicializar el Dashboard predeterminado y aplicar este cambio: Cambiar el título del Dashboard a "Primer cambio".',
            revision: '{"_tag":"Absent"}',
          },
        ]);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
      })
    ),
  30_000
);
