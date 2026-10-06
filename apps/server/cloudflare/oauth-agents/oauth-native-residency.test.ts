import { readDiscovery } from "./discovery.test-fixture";
import { executeOAuthCanonicalWork } from "../canonical-operations/operations";
import {
  type Cause,
  Clock,
  Deferred,
  Effect,
  Option,
  Predicate,
  Redacted,
  Schema,
  Scope,
} from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { makeMcpResidency } from "../mcp/runtime";
import { OAuthMcpAdmission } from "../mcp/contract";
import { secretDigest } from "../secret-material/operations";
import { makeMutationCommitGate } from "./mutation-commit.test-fixture";
import { UserTransactionCoordinator } from "../transactions/runtime";
import publicWorker from "../public-worker";
import coreWorker from "../core-worker";

const decodeResponseJson = (response: Response): Promise<Schema.Json> =>
  response.json().then((body: unknown) => Schema.decodeUnknownSync(Schema.Json)(body));

// Native2025 residency: real OAuth/public/Core/User coordinator integration lives at this earned composition.
describe("native2025 residency integration", () => {
  const databases = isolatedTestDatabases();
  afterAll(() => databases.dispose());
  afterEach(() => vi.restoreAllMocks());
  const wait = Effect.tryPromise;
  const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
  const userId = "10000000-0000-4000-8000-000000000001";
  const connectionId = "20000000-0000-4000-8000-000000000001";
  const credentialId = "30000000-0000-4000-8000-000000000001";
  const clientId = "40000000-0000-4000-8000-000000000001";
  const resource = "https://api.fidyapp.com/mcp";
  const bearer = "a".repeat(43);
  const transaction = {
    payload: {
      money: { amount: "15000", currency: "COP" },
      direction: "outflow",
      occurredAt: "2026-10-03T12:00:00.000Z",
    },
  };
  const call = (index: number): Schema.Json => ({
    callId: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    operation: "transactions.createTransaction",
    input: transaction,
  });
  const ToolReply = Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optionalKey(Schema.Boolean),
      structuredContent: Schema.Json,
    }),
  });
  const Listed = Schema.Struct({
    result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  });

  type ReadGate = Readonly<{
    waiting: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
    settled: ReturnType<typeof Promise.withResolvers<void>>;
    starts: string[];
  }>;
  const gatedStatement = (
    statement: D1PreparedStatement,
    sql: string,
    gate: ReadGate
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key): unknown {
        if (key === "bind") {
          return (...values: unknown[]) => gatedStatement(target.bind(...values), sql, gate);
        }
        const member: unknown = Reflect.get(target, key);
        if (
          (key === "all" || key === "first") &&
          Predicate.isFunction(member) &&
          sql.includes("FROM budgets")
        ) {
          return (...args: unknown[]): Promise<unknown> => {
            gate.starts.push(sql);
            const run = (): Promise<unknown> => {
              const result: unknown = member.apply(target, args);
              return Promise.resolve(result);
            };
            if (gate.starts.length !== 1) return run();
            gate.waiting.resolve();
            return gate.release.promise.then(run).finally(gate.settled.resolve);
          };
        }
        return Predicate.isFunction(member) ? member.bind(target) : member;
      },
    });
  const privateSqlFailure = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key): unknown {
        if (key === "bind") {
          return (...values: unknown[]) => privateSqlFailure(target.bind(...values));
        }
        if (key === "all" || key === "first" || key === "run") {
          return () =>
            Promise.reject(new Error("PRIVATE_MCP_SQL_SENTINEL secret budget statement"));
        }
        const member: unknown = Reflect.get(target, key);
        return Predicate.isFunction(member) ? member.bind(target) : member;
      },
    });
  const witnessedAuthority = (
    statement: D1PreparedStatement,
    gate: ReadGate
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key): unknown {
        if (key === "bind") {
          return (...values: ReadonlyArray<unknown>): D1PreparedStatement =>
            witnessedAuthority(target.bind(...values), gate);
        }
        if (key === "first") {
          return (): Promise<unknown> =>
            target.first().then((row: unknown) => {
              gate.starts.push("retained-MCP-authority");
              if (gate.starts.length === 2) gate.waiting.resolve();
              return row;
            });
        }
        const member: unknown = Reflect.get(target, key);
        return Predicate.isFunction(member) ? member.bind(target) : member;
      },
    });
  type NativeFixture = Readonly<{
    db: D1Database;
    current: number;
    digest: Uint8Array;
    send: (body: Schema.Json, sessionId?: string, token?: string) => Promise<Response>;
    canonical: (work: Readonly<{ operation: string; input: Schema.Json }>) => Promise<Response>;
    restart: () => void;
    commit: ReturnType<typeof makeMutationCommitGate>["hold"];
    failBudgetRead: () => void;
    holdRead: () => ReadGate;
    holdRevocation: () => ReadGate;
    watchCallbackAuthority: () => ReadGate;
    revoke: () => Promise<Response>;
  }>;
  const fixture = (
    scopes: ReadonlyArray<string> = ["read", "write", "dashboard"]
  ): Effect.Effect<
    NativeFixture,
    Cause.UnknownError | Effect.Error<ReturnType<typeof secretDigest>>
  > =>
    Effect.gen(function* () {
      const database = yield* wait(() => databases.acquire());
      yield* wait(() =>
        installTestSchema({
          db: database,
          sources: Array.from(
            new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
          )
            .sort()
            .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
        })
      );
      const mutation = makeMutationCommitGate(database);
      let readGate: Option.Option<ReadGate> = Option.none();
      let revocationGate: Option.Option<ReadGate> = Option.none();
      let callbackWitness: Option.Option<ReadGate> = Option.none();
      let failBudget = false;
      const db = new Proxy(mutation.db, {
        get(target, key): unknown {
          if (key === "batch" && Option.isSome(revocationGate)) {
            const gate = revocationGate.value;
            revocationGate = Option.none();
            return (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
              gate.waiting.resolve();
              return gate.release.promise
                .then(() => target.batch(statements))
                .finally(() => {
                  gate.settled.resolve();
                });
            };
          }
          if (key === "prepare") {
            return (sql: string): D1PreparedStatement => {
              const statement = target.prepare(sql);
              if (Option.isSome(callbackWitness) && sql.includes("AS credentialExpiresAt")) {
                return witnessedAuthority(statement, callbackWitness.value);
              }
              if (failBudget && sql.includes("FROM budgets")) return privateSqlFailure(statement);
              return Option.isSome(readGate)
                ? gatedStatement(statement, sql, readGate.value)
                : statement;
            };
          }
          const member: unknown = Reflect.get(target, key);
          return Predicate.isFunction(member) ? member.bind(target) : member;
        },
      });
      const coordinators = new Map<string, UserTransactionCoordinator>();
      const environment = {
        DB: db,
        AI: {
          run: (): Promise<never> =>
            Promise.reject(new Error("Native residency must not invoke hosted inference.")),
        },
        RELEASE_GIT_SHA: "a".repeat(40),
        CONTRACT_DIGEST: "a".repeat(64),
        BROWSER_ORIGIN: "https://app.fidyapp.com",
        HOSTED_AI_MODEL: "",
        KAPSO_API_KEY: "",
        KAPSO_WEBHOOK_SECRET: "",
        WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
        CLOUDFLARE_ACCESS_ISSUER: "",
        CLOUDFLARE_ACCESS_AUDIENCE: "",
        WOMPI_ENVIRONMENT: "",
        WOMPI_PUBLIC_KEY: "",
        WOMPI_PRIVATE_KEY: "",
        WOMPI_INTEGRITY_SECRET: "",
        USER_TRANSACTION_COORDINATOR: {
          getByName: (name: string): Pick<Fetcher, "fetch"> => ({
            fetch: (incoming): Promise<Response> => {
              let owner = coordinators.get(name);
              if (owner === undefined) {
                owner = new UserTransactionCoordinator(
                  { id: { name }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
                  environment
                );
                coordinators.set(name, owner);
              }
              return owner.fetch(incoming instanceof Request ? incoming : new Request(incoming));
            },
          }),
        },
      };
      const current = yield* Clock.currentTimeMillis;
      const digest = yield* secretDigest({ purpose: "oauth-access", value: Redacted.make(bearer) });
      yield* wait(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
            )
            .bind(userId, current),
          db
            .prepare(
              "INSERT INTO onboarding_consent_records VALUES ('native-consent', ?, '{}', 'disclosure', 'decision', 1, 1)"
            )
            .bind(userId),
          db
            .prepare(
              "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES ('60000000-0000-4000-8000-000000000001','BCDF-GHJK',?,?,'consumed',?,?)"
            )
            .bind(digest, userId, current, current + 600000),
          db
            .prepare(
              "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES ('70000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001',?,?,?,?,?,?)"
            )
            .bind(
              userId,
              digest,
              current,
              current + 600000,
              current + 600000,
              current + 7776000000
            ),
          db
            .prepare(
              "INSERT INTO oauth_connections(id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms) VALUES (?,'90000000-0000-4000-8000-000000000001',?,?,'native-fixture','http://127.0.0.1/callback',?,?,?,?)"
            )
            .bind(
              connectionId,
              userId,
              clientId,
              resource,
              json([...scopes]),
              current,
              current + 60000
            ),
          db
            .prepare(
              "INSERT INTO oauth_grant_consents(id,connection_id,user_id,session_id,disclosure_revision,disclosure_text,accepted_at_ms) VALUES ('80000000-0000-4000-8000-000000000001',?,?,'70000000-0000-4000-8000-000000000001','disclosure','decision',?)"
            )
            .bind(connectionId, userId, current),
          db
            .prepare(
              "INSERT INTO oauth_access_credentials(id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES (?,?,?,?,?,?,?)"
            )
            .bind(
              credentialId,
              connectionId,
              userId,
              digest,
              current,
              current + 30000,
              json([...scopes])
            ),
        ])
      );
      const send = (body: Schema.Json, sessionId?: string, token = bearer): Promise<Response> =>
        publicWorker.fetch(
          new Request(resource, {
            method: "POST",
            body: json(body),
            headers: {
              "cf-connecting-ip": "198.51.100.10",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": "2025-11-25",
              ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
            },
          }),
          {
            RELEASE_GIT_SHA: environment.RELEASE_GIT_SHA,
            BROWSER_ORIGIN: environment.BROWSER_ORIGIN,
            LOCAL_CANONICAL_READ_BEARER: "",
            PAT_ADMISSION_KEY: "test-only-source-admission-key-32-bytes",
            CORE: {
              fetch: (incoming): Promise<Response> =>
                coreWorker.fetch(
                  incoming instanceof Request ? incoming : new Request(incoming),
                  environment
                ),
            },
          }
        );
      const invocationServices = yield* Effect.context<never>();
      const invocationMillis = (): Promise<number> =>
        Effect.runPromiseWith(invocationServices)(Clock.currentTimeMillis);
      return {
        db,
        send,
        current,
        digest,
        canonical: (work: Readonly<{ operation: string; input: Schema.Json }>): Promise<Response> =>
          invocationMillis().then((now) =>
            environment.USER_TRANSACTION_COORDINATOR.getByName(userId).fetch(
              new Request("https://coordinator.internal/oauth-canonical", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: json({
                  userId,
                  connectionId,
                  credentialId,
                  clientId,
                  resource,
                  digest: Array.from(digest),
                  deadlineMilliseconds: now + 3000,
                  operation: work.operation,
                  input: work.input,
                }),
              })
            )
          ),
        restart: (): void => coordinators.clear(),
        commit: mutation.hold,
        revoke: (): Promise<Response> =>
          invocationMillis().then((now) =>
            environment.USER_TRANSACTION_COORDINATOR.getByName(userId).fetch(
              new Request("https://coordinator.internal/oauth-revoke", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: json({
                  userId,
                  sessionId: "70000000-0000-4000-8000-000000000001",
                  connectionId,
                  deadlineAtMs: now + 3000,
                }),
              })
            )
          ),
        watchCallbackAuthority: (): ReadGate => {
          const gate: ReadGate = {
            waiting: Promise.withResolvers<void>(),
            release: Promise.withResolvers<void>(),
            settled: Promise.withResolvers<void>(),
            starts: [],
          };
          callbackWitness = Option.some(gate);
          return gate;
        },
        holdRevocation: (): ReadGate => {
          const gate: ReadGate = {
            waiting: Promise.withResolvers<void>(),
            release: Promise.withResolvers<void>(),
            settled: Promise.withResolvers<void>(),
            starts: [],
          };
          revocationGate = Option.some(gate);
          return gate;
        },
        failBudgetRead: (): void => {
          failBudget = true;
        },
        holdRead: (): ReadGate => {
          const gate: ReadGate = {
            waiting: Promise.withResolvers<void>(),
            release: Promise.withResolvers<void>(),
            settled: Promise.withResolvers<void>(),
            starts: [],
          };
          readGate = Option.some(gate);
          return gate;
        },
      };
    });
  const initializeBody = {
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "native-residency", version: "1" },
    },
  };
  const initialize = (
    send: (body: Schema.Json, sessionId?: string) => Promise<Response>
  ): Effect.Effect<string, Cause.UnknownError> =>
    Effect.gen(function* () {
      const response = yield* wait(() => send(initializeBody));
      expect(response.status).toBe(200);
      const id = response.headers.get("mcp-session-id");
      expect(id).not.toBeNull();
      yield* wait(() => response.text());
      const notified = yield* wait(() =>
        send({ jsonrpc: "2.0", method: "notifications/initialized" }, id ?? "")
      );
      expect(notified.status).toBe(202);
      yield* wait(() => notified.text());
      return id ?? "";
    });
  const tool = (id: string, name: string, args: Schema.Json = {}): Schema.Json => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  it("native residency preserves queries, mutations, atomic batches and sensitive child refusals through published ingress", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture();
        const session = yield* initialize(harness.send);
        const query = yield* wait(() =>
          harness.send(tool("query", "budgets.listBudgets"), session)
        );
        expect(query.status).toBe(200);
        expect(
          (yield* Schema.decodeUnknownEffect(ToolReply)(yield* wait(() => query.json()))).result
            .isError
        ).not.toBe(true);
        const mutation = yield* wait(() =>
          harness.send(tool("mutation", "transactions.createTransaction", transaction), session)
        );
        expect(
          (yield* Schema.decodeUnknownEffect(ToolReply)(yield* wait(() => mutation.json()))).result
            .isError
        ).not.toBe(true);
        const batch = yield* wait(() =>
          harness.send(
            tool("batch", "operations.executeAtomicBatch", {
              payload: { calls: [call(1), call(2)] },
            }),
            session
          )
        );
        expect(
          (yield* Schema.decodeUnknownEffect(ToolReply)(yield* wait(() => batch.json()))).result
            .isError
        ).not.toBe(true);
        expect(
          yield* wait(() =>
            harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(3);
        const sensitive = yield* wait(() =>
          harness.send(
            tool("sensitive", "operations.executeAtomicBatch", {
              payload: {
                calls: [
                  {
                    callId: "50000000-0000-4000-8000-000000000003",
                    operation: "memory.forget",
                    input: {},
                  },
                ],
              },
            }),
            session
          )
        );
        const refusal = yield* Schema.decodeUnknownEffect(ToolReply)(
          yield* wait(() => sensitive.json())
        );
        expect(refusal.result.isError).toBe(true);
        expect(json(refusal.result.structuredContent)).toContain("user_action_required");
        expect(json(refusal.result.structuredContent)).toContain(
          "Esta operación requiere una nueva confirmación nativa del cliente OAuth autorizado."
        );
        expect(
          yield* wait(() =>
            harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(3);
      })
    ));

  it("native residency bounds eight unread response owners and preserves stock repeated and batched initialize rejection", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture(["read"]);
        const session = yield* initialize(harness.send);
        const existing = yield* wait(() => harness.send(initializeBody, session));
        expect(existing.status).toBe(400);
        yield* wait(() => existing.text());
        const batched = yield* wait(() => harness.send([initializeBody, initializeBody], session));
        expect(batched.status).toBe(400);
        yield* wait(() => batched.text());
        const responses: Response[] = [];
        for (let index = 0; index < 8; index++) {
          responses.push(yield* wait(() => harness.send(initializeBody)));
        }
        expect(responses.every((response) => response.status === 200)).toBe(true);
        expect(
          new Set(responses.map((response) => response.headers.get("mcp-session-id"))).size
        ).toBe(8);
        const ninth = yield* wait(() => harness.send(initializeBody));
        expect(ninth.status).toBe(503);
        yield* wait(() => ninth.text());
        for (const response of responses) {
          yield* wait(() => response.body?.cancel() ?? Promise.resolve());
        }
        const reopened = yield* wait(() => harness.send(initializeBody));
        expect(reopened.status).toBe(200);
        yield* wait(() => reopened.text());
      })
    ));

  it("native residency keeps genuine lost-ID404 and explicit initialize then diagnostic query without replay", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture(["read"]);
        const old = yield* initialize(harness.send);
        harness.restart();
        const lost = yield* wait(() => harness.send(tool("lost", "budgets.listBudgets"), old));
        expect(lost.status).toBe(404);
        yield* wait(() => lost.text());
        const fresh = yield* initialize(harness.send);
        expect(fresh).not.toBe(old);
        const diagnostic = yield* wait(() =>
          harness.send(tool("diagnostic", "budgets.listBudgets"), fresh)
        );
        expect(diagnostic.status).toBe(200);
        expect(
          (yield* Schema.decodeUnknownEffect(ToolReply)(yield* wait(() => diagnostic.json())))
            .result.isError
        ).not.toBe(true);
        expect(
          yield* wait(() =>
            harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
      })
    ));

  it("native residency invalidates changed catalog and credential while refusing revoked authority", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture();
        const old = yield* initialize(harness.send);
        yield* wait(() =>
          harness.db
            .prepare("UPDATE oauth_access_credentials SET scopes_json = '[\"read\"]' WHERE id = ?")
            .bind(credentialId)
            .run()
        );
        const lost = yield* wait(() =>
          harness.send({ jsonrpc: "2.0", id: "list", method: "tools/list" }, old)
        );
        expect(lost.status).toBe(404);
        yield* wait(() => lost.text());
        const fresh = yield* initialize(harness.send);
        const listed = yield* wait(() =>
          harness.send({ jsonrpc: "2.0", id: "fresh-list", method: "tools/list" }, fresh)
        );
        const decoded = yield* Schema.decodeUnknownEffect(Listed)(yield* wait(() => listed.json()));
        expect(decoded.result.tools.map(({ name }) => name)).toEqual(
          [...readDiscovery, "operations.executeAtomicBatch"].sort()
        );
        const revokedAt = yield* Clock.currentTimeMillis;
        yield* wait(() =>
          harness.db
            .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
            .bind(revokedAt, connectionId)
            .run()
        );
        const revoked = yield* wait(() =>
          harness.send(tool("revoked", "budgets.listBudgets"), fresh)
        );
        expect(revoked.status).toBe(401);
        expect(
          yield* wait(() =>
            harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
      })
    ));

  it("native residency never extends initial credential expiry with a later retained expiry", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture(["read"]);
        const session = yield* initialize(harness.send);
        yield* wait(() =>
          harness.db
            .prepare("UPDATE oauth_access_credentials SET expires_at_ms = ? WHERE id = ?")
            .bind(harness.current + 50000, credentialId)
            .run()
        );
        const clock = vi.spyOn(Date, "now").mockReturnValue(harness.current + 30001);
        try {
          const lost = yield* wait(() =>
            harness.send({ jsonrpc: "2.0", id: "expired-owner", method: "tools/list" }, session)
          );
          expect(lost.status).toBe(404);
          yield* wait(() => lost.text());
          const fresh = yield* initialize(harness.send);
          expect(fresh).not.toBe(session);
        } finally {
          clock.mockRestore();
        }
      })
    ));

  it("native residency replacement credential cannot borrow a cached proof or extend its session", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture(["read"]);
        const session = yield* initialize(harness.send);
        const replacement = "b".repeat(43);
        const digest = yield* secretDigest({
          purpose: "oauth-access",
          value: Redacted.make(replacement),
        });
        yield* wait(() =>
          harness.db
            .prepare(
              "INSERT INTO oauth_access_credentials(id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES ('30000000-0000-4000-8000-000000000002',?,?,?,?,?,'[\"read\"]')"
            )
            .bind(connectionId, userId, digest, harness.current, harness.current + 50000)
            .run()
        );
        const refused = yield* wait(() =>
          harness.send(tool("replacement", "budgets.listBudgets"), session, replacement)
        );
        expect(refused.status).toBe(404);
        yield* wait(() => refused.text());
        const invalid = yield* wait(() =>
          harness.send(tool("anonymous", "budgets.listBudgets"), session, "c".repeat(43))
        );
        expect(invalid.status).toBe(401);
        expect(
          yield* wait(() =>
            harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
      })
    ));

  it("native residency refuses withdrawn Consent before cached tools can execute and hides native SQL failures", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture();
        const session = yield* initialize(harness.send);
        harness.failBudgetRead();
        const failed = yield* wait(() =>
          harness.send(tool("private-failure", "budgets.listBudgets"), session)
        );
        const text = yield* wait(() => failed.text());
        expect(text).not.toContain("PRIVATE_MCP_SQL_SENTINEL");
        expect(text).not.toContain("secret budget statement");
        expect(text).toContain("unavailable");
        const withdrawnAt = yield* Clock.currentTimeMillis;
        yield* wait(() =>
          harness.db
            .prepare(
              "INSERT INTO consent_user_revocations(id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('native-withdrawn',?,'native-consent','70000000-0000-4000-8000-000000000001',?)"
            )
            .bind(userId, withdrawnAt)
            .run()
        );
        const refused = yield* wait(() =>
          harness.send(tool("withdrawn", "transactions.createTransaction", transaction), session)
        );
        expect(refused.status).toBe(401);
        yield* wait(() => refused.text());
        expect(
          yield* wait(() =>
            harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(() =>
            harness.db
              .prepare("SELECT count(*) FROM canonical_request_leases")
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    ));

  it("native residency counts a retiring started atomic owner until SQL and streaming disposal finish", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture();
        const session = yield* initialize(harness.send);
        const gate = harness.commit();
        const running = harness.send(
          tool("retiring-atomic", "operations.executeAtomicBatch", {
            payload: { calls: [call(1), call(2)] },
          }),
          session
        );
        yield* wait(() => gate.waiting);
        const unread: Response[] = [];
        let settled = false;
        const observedSettlement = gate.settled.then(() => {
          settled = true;
        });
        try {
          for (let index = 0; index < 7; index++) {
            unread.push(yield* wait(() => harness.send(initializeBody)));
          }
          const replacement = "b".repeat(43);
          const digest = yield* secretDigest({
            purpose: "oauth-access",
            value: Redacted.make(replacement),
          });
          yield* wait(() =>
            harness.db
              .prepare(
                "INSERT INTO oauth_access_credentials(id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES ('30000000-0000-4000-8000-000000000002',?,?,?,?,?,?)"
              )
              .bind(
                connectionId,
                userId,
                digest,
                harness.current,
                harness.current + 50000,
                json(["read", "write", "dashboard"])
              )
              .run()
          );
          const full = yield* wait(() =>
            harness.send(tool("retire", "budgets.listBudgets"), session, replacement)
          );
          expect(full.status).toBe(503);
          yield* wait(() => full.text());
          expect(settled).toBe(false);
          expect(
            yield* wait(() =>
              harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
            )
          ).toBe(0);
          const released = unread.shift();
          yield* wait(() => released?.body?.cancel() ?? Promise.resolve());
          const lost = yield* wait(() =>
            harness.send(tool("lost-retiring", "budgets.listBudgets"), session, replacement)
          );
          expect(lost.status).toBe(404);
          yield* wait(() => lost.text());
          expect(settled).toBe(false);
          gate.release();
          yield* wait(() => observedSettlement);
          const response = yield* wait(() => running);
          yield* wait(() => response.text());
          expect(
            yield* wait(() =>
              harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
            )
          ).toBe(2);
        } finally {
          gate.release();
          for (const response of unread) {
            yield* wait(() => response.body?.cancel() ?? Promise.resolve());
          }
        }
      })
    ));

  it("native residency SDK callbacks use invocation Context and Clock, not initialization Context or whole CanonicalClock", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture(["read"]);
        const baseline = yield* wait(() =>
          harness.canonical({ operation: "budgets.listBudgets", input: {} })
        );
        expect(baseline.status).toBe(200);
        const output = yield* wait(() => baseline.text());
        const baseClock = yield* Clock.Clock;
        const clockAt = (current: number): Clock.Clock => ({
          currentTimeMillisUnsafe: () => current,
          currentTimeMillis: Effect.succeed(current),
          currentTimeNanosUnsafe: () => BigInt(current) * 1000000n,
          currentTimeNanos: Effect.succeed(BigInt(current) * 1000000n),
          monotonicTimeNanosUnsafe: () => baseClock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: baseClock.monotonicTimeNanos,
          sleep: (duration) => baseClock.sleep(duration),
        });
        const initialClock = clockAt(harness.current);
        const invocationClock = clockAt(harness.current + 1000);
        const observed: Array<Readonly<{ clock: Clock.Clock; current: number; deadline: number }>> =
          [];
        const module = makeMcpResidency({
          userId,
          db: harness.db,
          enqueueCanonicalWork: ({ admission }): Effect.Effect<Response> =>
            Effect.gen(function* () {
              observed.push({
                clock: yield* Clock.Clock,
                current: yield* Clock.currentTimeMillis,
                deadline: admission.deadlineMilliseconds,
              });
              return new Response(output, { headers: { "content-type": "application/json" } });
            }),
        });
        const native = (
          body: Schema.Json,
          clock: Clock.Clock,
          session?: string
        ): Effect.Effect<Response> =>
          module
            .handle({
              admission: Schema.decodeSync(OAuthMcpAdmission)({
                userId,
                connectionId,
                credentialId,
                clientId,
                resource,
                digest: Array.from(harness.digest),
                deadlineMilliseconds: harness.current + 5000,
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                  "mcp-protocol-version": "2025-11-25",
                  ...(session === undefined ? {} : { "mcp-session-id": session }),
                },
                body: Array.from(new TextEncoder().encode(json(body))),
              }),
              signal: new AbortController().signal,
            })
            .pipe(Effect.provideService(Clock.Clock, clock));
        try {
          const initialized = yield* native(initializeBody, initialClock);
          expect(initialized.status).toBe(200);
          const session = initialized.headers.get("mcp-session-id") ?? "";
          const initializedBody = yield* wait(() => initialized.json());
          expect(initializedBody).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
          expect(session).not.toBe("");
          const notified = yield* native(
            { jsonrpc: "2.0", method: "notifications/initialized" },
            invocationClock,
            session
          );
          expect(notified.status).toBe(202);
          const result = yield* native(
            tool("context-clock", "budgets.listBudgets"),
            invocationClock,
            session
          );
          expect(result.status).toBe(200);
          yield* wait(() => result.text());
          expect(observed).toHaveLength(1);
          expect(observed[0]?.clock).toBe(invocationClock);
          expect(observed[0]?.current).toBe(harness.current + 1000);
          expect(observed[0]?.deadline).toBe(harness.current + 4000);
        } finally {
          yield* module.dispose();
        }
      })
    ));

  it("native residency running and queued cancellation controls do not release predecessor or native SQL settlement", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture();
        const session = yield* initialize(harness.send);
        const gate = harness.commit();
        const first = harness.send(
          tool("running", "operations.executeAtomicBatch", {
            payload: { calls: [call(1), call(2)] },
          }),
          session
        );
        yield* wait(() => gate.waiting);
        try {
          const queued = harness.send(
            tool("queued", "transactions.createTransaction", transaction),
            session
          );
          for (let attempt = 0; attempt < 100; attempt++) {
            const total = yield* wait(() =>
              harness.db
                .prepare("SELECT count(*) FROM canonical_request_leases")
                .first<number>("count(*)")
            );
            if (total === 2) break;
            yield* Effect.yieldNow;
          }
          expect(
            yield* wait(() =>
              harness.db
                .prepare("SELECT count(*) FROM canonical_request_leases")
                .first<number>("count(*)")
            )
          ).toBe(2);
          const cancel = (requestId: string): Promise<Response> =>
            harness.send(
              { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } },
              session
            );
          const runningControl = yield* wait(() => cancel("running"));
          expect(runningControl.status).toBe(202);
          yield* wait(() => runningControl.text());
          const queuedControl = yield* wait(() => cancel("queued"));
          expect(queuedControl.status).toBe(202);
          yield* wait(() => queuedControl.text());
          let thirdFinished = false;
          const third = harness
            .canonical({ operation: "transactions.createTransaction", input: transaction })
            .then((response) => {
              thirdFinished = true;
              return response;
            });
          yield* Effect.yieldNow;
          expect(thirdFinished).toBe(false);
          expect(
            yield* wait(() =>
              harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
            )
          ).toBe(0);
          gate.release();
          yield* wait(() => gate.settled);
          const firstResponse = yield* wait(() => first);
          const queuedResponse = yield* wait(() => queued);
          // Stock queued-target transport failure is observable; never manufacture successful delivery.
          expect(queuedResponse.status).toBe(500);
          yield* wait(() => firstResponse.text());
          yield* wait(() => queuedResponse.text());
          const thirdResponse = yield* wait(() => third);
          expect(thirdResponse.status).toBe(201);
          yield* wait(() => thirdResponse.text());
          expect(
            yield* wait(() =>
              harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
            )
          ).toBe(3);
          expect(
            yield* wait(() =>
              harness.db
                .prepare("SELECT count(*) FROM canonical_request_leases")
                .first<number>("count(*)")
            )
          ).toBe(0);
        } finally {
          gate.release();
        }
      })
    ));

  const cleanupRevocation = (
    gate: ReadGate,
    revocation: Promise<Response>,
    queued: Option.Option<Promise<Schema.Json>>
  ): Effect.Effect<void, Cause.UnknownError> =>
    Effect.gen(function* () {
      gate.release.resolve();
      yield* wait(() => revocation);
      if (Option.isSome(queued)) {
        const settlement = queued.value;
        yield* wait(() => settlement);
      }
    });
  type SdkDisposalEvidence = Readonly<{
    progress: ReadonlyArray<string>;
    cleanupStarted: Deferred.Deferred<void>;
    cleanupRelease: Deferred.Deferred<void>;
    cleanupFinished: Deferred.Deferred<void>;
    disposalStarted: Deferred.Deferred<void>;
    disposalFinished: Deferred.Deferred<void>;
  }>;
  const settleNativeStatus = (
    response: Promise<Response>,
    status: 503 | 404 | 500
  ): Effect.Effect<void, Cause.UnknownError> =>
    Effect.gen(function* () {
      const current = yield* wait(() => response);
      expect(current.status).toBe(status);
      yield* wait(() => current.text());
    });
  const settleLateSdkResponse = (
    input: Readonly<{
      response: Promise<Response>;
      disposal: Promise<void>;
      progress: Array<string>;
    }>
  ): Effect.Effect<void, Cause.UnknownError> =>
    Effect.gen(function* () {
      const response = yield* wait(() => input.response);
      expect(response.status).toBe(500);
      input.progress.push(
        "genuine late native target500 received; body deliberately unread until public disposal completes"
      );
      yield* wait(() => input.disposal);
      input.progress.push(
        "public disposal completed with late target500 body still unread by caller"
      );
      yield* wait(() => response.text());
      input.progress.push("late native target500 body completion verified after public disposal");
    });
  const saveSdkDisposalEvidence = (
    input: SdkDisposalEvidence,
    phase: "before-cleanup" | "after-release" | "before-dispose" | "after-dispose" | "after-cleanup"
  ): Effect.Effect<void, Cause.UnknownError> =>
    Effect.gen(function* () {
      const snapshot = {
        phase,
        progress: [...input.progress],
        callbackLocalScopeFinalizerStarted: yield* Deferred.isDone(input.cleanupStarted),
        callbackLocalScopeCleanupReleased: yield* Deferred.isDone(input.cleanupRelease),
        callbackLocalScopeFinalizerFinished: yield* Deferred.isDone(input.cleanupFinished),
        publishedDisposalStarted: yield* Deferred.isDone(input.disposalStarted),
        publishedDisposalFinished: yield* Deferred.isDone(input.disposalFinished),
        qualification:
          "Callback-local test Scope is not the SDK owner Layer Scope; only public module dispose observes module shutdown.",
      };
      yield* Effect.logInfo({ checkpoint: "PUBLIC_SCOPE_DISPOSAL_DIAGNOSTIC", ...snapshot });
    });
  const cleanupSdkOwners = (
    input: Readonly<{
      modules: ReadonlyArray<ReturnType<typeof makeMcpResidency>>;
      release: Deferred.Deferred<void>;
      held: ReadonlyArray<Response>;
      pending: ReadonlyArray<Promise<Response>>;
      disposals: ReadonlyArray<Promise<void>>;
      evidence: SdkDisposalEvidence;
    }>
  ): Effect.Effect<void, Cause.UnknownError> =>
    Effect.gen(function* () {
      const { modules, release, held, pending, disposals, evidence } = input;
      yield* Deferred.succeed(release, undefined);
      yield* saveSdkDisposalEvidence(evidence, "after-release");
      for (const settlement of pending) {
        const response = yield* wait(() => settlement);
        if (!response.bodyUsed) {
          yield* wait(() => response.body?.cancel() ?? Promise.resolve());
        }
      }
      for (const response of held) {
        if (!response.bodyUsed) {
          yield* wait(() => response.body?.cancel() ?? Promise.resolve());
        }
      }
      yield* saveSdkDisposalEvidence(evidence, "before-dispose");
      for (const module of modules) {
        yield* module.dispose();
      }
      for (const disposal of disposals) {
        yield* wait(() => disposal);
      }
      yield* saveSdkDisposalEvidence(evidence, "after-dispose");
    });

  it("native residency essential successful OAuth revocation retires only related owners without a queued callback deadlock", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture();
        const peerConnection = "20000000-0000-4000-8000-000000000002";
        const peerBearer = "b".repeat(43);
        const peerDigest = yield* secretDigest({
          purpose: "oauth-access",
          value: Redacted.make(peerBearer),
        });
        yield* wait(() =>
          harness.db.batch([
            harness.db
              .prepare(
                "INSERT INTO oauth_connections(id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms,revoked_at_ms) SELECT ?, '90000000-0000-4000-8000-000000000002', user_id, client_id, claimed_client_name, redirect_uri, resource, scopes_json, approved_at_ms, expires_at_ms, revoked_at_ms FROM oauth_connections WHERE id = ?"
              )
              .bind(peerConnection, connectionId),
            harness.db
              .prepare(
                "INSERT INTO oauth_grant_consents SELECT '80000000-0000-4000-8000-000000000002', ?, user_id, session_id, disclosure_revision, disclosure_text, accepted_at_ms FROM oauth_grant_consents WHERE connection_id = ?"
              )
              .bind(peerConnection, connectionId),
            harness.db
              .prepare(
                "INSERT INTO oauth_access_credentials(id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES ('30000000-0000-4000-8000-000000000002',?,?,?,?,?,?)"
              )
              .bind(
                peerConnection,
                userId,
                peerDigest,
                harness.current,
                harness.current + 30000,
                json(["read", "write", "dashboard"])
              ),
          ])
        );
        const related = yield* initialize(harness.send);
        const peerSend = (body: Schema.Json, session?: string): Promise<Response> =>
          harness.send(body, session, peerBearer);
        const peer = yield* initialize(peerSend);
        const gate = harness.holdRevocation();
        const revocation = harness.revoke();
        let queued: Option.Option<Promise<Schema.Json>> = Option.none();
        // A cleanup rejection is a test defect, not a normalized protocol response.
        yield* Scope.addFinalizer(
          yield* Scope.Scope,
          Effect.suspend(() => cleanupRevocation(gate, revocation, queued)).pipe(Effect.orDie)
        );
        try {
          yield* wait(() => gate.waiting.promise);
          const callback = harness.watchCallbackAuthority();
          let queuedFinished = false;
          const settlement = harness
            .send(tool("essential-queued", "transactions.createTransaction", transaction), related)
            .then((response): Promise<Schema.Json> => {
              expect(response.status).toBe(200);
              return decodeResponseJson(response);
            })
            .then((body) => {
              queuedFinished = true;
              return body;
            });
          queued = Option.some(settlement);
          // Only admission and actual registered SDK callbacks execute this published projection.
          yield* wait(() => callback.waiting.promise);
          expect(callback.starts).toEqual(["retained-MCP-authority", "retained-MCP-authority"]);
          yield* Effect.sleep("10 millis");
          expect(queuedFinished).toBe(false);
          expect(
            yield* wait(() =>
              harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
            )
          ).toBe(0);
          gate.release.resolve();
          expect((yield* wait(() => revocation)).status).toBe(200);
          yield* wait(() => gate.settled.promise);
          const result = yield* Schema.decodeUnknownEffect(ToolReply)(
            yield* wait(() => settlement)
          );
          expect(result.result.isError).toBe(true);
          expect(
            (yield* wait(() =>
              harness.send(
                { jsonrpc: "2.0", id: "revoked", method: "tools/list", params: {} },
                related
              )
            )).status
          ).toBe(401);
          const unaffected = yield* wait(() =>
            peerSend({ jsonrpc: "2.0", id: "peer", method: "tools/list", params: {} }, peer)
          );
          expect(unaffected.status).toBe(200);
          const listed = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Schema.Unknown) }) })
          )(yield* wait(() => unaffected.json()));
          expect(listed.result.tools.length).toBeGreaterThan(0);
          expect(
            yield* wait(() =>
              harness.db
                .prepare("SELECT revoked_at_ms FROM oauth_connections WHERE id = ?")
                .bind(peerConnection)
                .first("revoked_at_ms")
            )
          ).toBeNull();
          expect(
            yield* wait(() =>
              harness.db
                .prepare("SELECT count(*) FROM oauth_connections WHERE revoked_at_ms IS NOT NULL")
                .first<number>("count(*)")
            )
          ).toBe(1);
          expect(
            yield* wait(() =>
              harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
            )
          ).toBe(0);
          expect(
            yield* wait(() =>
              harness.db
                .prepare("SELECT count(*) FROM canonical_request_leases")
                .first<number>("count(*)")
            )
          ).toBe(0);
        } finally {
          gate.release.resolve();
          yield* wait(() => revocation);
          if (Option.isSome(queued)) {
            const settlement = queued.value;
            yield* wait(() => settlement);
          }
        }
      }).pipe(Effect.scoped, Effect.timeout("10 seconds"))
    ));

  it("native residency essential Statement missing and foreign IDs share a private refusal without financial writes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture(["read"]);
        const foreignUser = "10000000-0000-4000-8000-000000000002";
        const foreignStatement = "50000000-0000-4000-8000-000000000099";
        yield* wait(() =>
          harness.db.batch([
            harness.db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
              )
              .bind(foreignUser, harness.current),
            harness.db
              .prepare(
                "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms,source_format) VALUES ('60000000-0000-4000-8000-000000000099',?,'PRIVATE_FOREIGN_STATEMENT_OBJECT',1,?,'available',?,?,'csv')"
              )
              .bind(foreignUser, "a".repeat(64), harness.current, harness.current + 86400000),
            harness.db
              .prepare(
                "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms,started_at_ms,completed_at_ms,input_rows,accepted_rows,needs_review_rows) VALUES (?,?,'70000000-0000-4000-8000-000000000099','60000000-0000-4000-8000-000000000099',?,'csv','statement-parser-v1','CO','es-CO','America/Bogota','completed',?,?,?,0,0,0)"
              )
              .bind(
                foreignStatement,
                foreignUser,
                harness.current,
                harness.current + 86400000,
                harness.current,
                harness.current
              ),
          ])
        );
        const session = yield* initialize(harness.send);
        const replies: Array<Schema.Json> = [];
        for (const id of ["50000000-0000-4000-8000-000000000098", foreignStatement]) {
          const response = yield* wait(() =>
            harness.send(
              tool("essential-statement", "ingestion.getStatementSubmission", { params: { id } }),
              session
            )
          );
          expect(response.status).toBe(200);
          const wire = yield* wait(() => response.text());
          expect(wire).not.toContain("PRIVATE_FOREIGN_STATEMENT_OBJECT");
          expect(wire).not.toContain(foreignUser);
          expect(wire).not.toContain(foreignStatement);
          const reply = yield* Schema.decodeUnknownEffect(ToolReply)(
            yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(wire)
          );
          expect(reply.result.isError).toBe(true);
          replies.push(reply.result.structuredContent);
        }
        expect(replies[1]).toEqual(replies[0]);
        expect(replies[0]).toMatchObject({ error: { code: "not_found" }, next: [] });
        expect(
          yield* wait(() =>
            harness.db
              .prepare("SELECT count(*) FROM statement_submissions WHERE user_id = ?")
              .bind(foreignUser)
              .first<number>("count(*)")
          )
        ).toBe(1);
        expect(
          yield* wait(() =>
            harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(() =>
            harness.db
              .prepare("SELECT count(*) FROM canonical_request_leases")
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    ));

  it("native residency essential actual SDK disposal waits for public Scope cleanup before replacement capacity", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* fixture(["read", "write"]);
        const seed = yield* wait(() =>
          harness.canonical({ operation: "transactions.createTransaction", input: transaction })
        );
        expect(seed.status).toBe(201);
        yield* wait(() => seed.text());
        const cleanupStarted = yield* Deferred.make<void>();
        const cleanupRelease = yield* Deferred.make<void>();
        const cleanupFinished = yield* Deferred.make<void>();
        const disposalStarted = yield* Deferred.make<void>();
        const disposalFinished = yield* Deferred.make<void>();
        const progress: Array<string> = [];
        const config: Parameters<typeof makeMcpResidency>[0] = {
          db: harness.db,
          userId,
          enqueueCanonicalWork: ({ admission: work, signal }) =>
            Effect.scoped(
              Effect.gen(function* () {
                progress.push(
                  "SDK callback entered; acquiring callback-local test Scope, not SDK owner Scope"
                );
                expect(work.operation).toBe("categories.listCategories");
                const scope = yield* Scope.Scope;
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(cleanupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(cleanupRelease)),
                    Effect.andThen(Deferred.succeed(cleanupFinished, undefined)),
                    Effect.uninterruptible
                  )
                );
                return yield* executeOAuthCanonicalWork({
                  confirmation: Option.none(),
                  db: harness.db,
                  bucket: Option.none(),
                  inference: Option.none(),
                  subject: {
                    userId: work.userId,
                    oauthConnectionId: work.connectionId,
                    credentialId: work.credentialId,
                    clientId: work.clientId,
                    resource: work.resource,
                    digest: new Uint8Array(work.digest),
                    requiredScope: Option.some("read"),
                  },
                  operation: work.operation,
                  input: work.input,
                  signal,
                  deadlineMilliseconds: work.deadlineMilliseconds,
                });
              })
            ),
        };
        const module = makeMcpResidency(config);
        const services = yield* Effect.context<never>();
        const modules = [module];
        const pendingDisposals: Array<Promise<void>> = [];
        const request = (
          owner: ReturnType<typeof makeMcpResidency>,
          body: Schema.Json,
          session?: string
        ): Promise<Response> => {
          const signal = new AbortController().signal;
          return Effect.runPromiseWith(services)(
            Effect.gen(function* () {
              const current = yield* Clock.currentTimeMillis;
              const admission = yield* Schema.decodeEffect(OAuthMcpAdmission)({
                userId,
                connectionId,
                credentialId,
                clientId,
                resource,
                digest: Array.from(harness.digest),
                deadlineMilliseconds: current + 3000,
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                  "mcp-protocol-version": "2025-11-25",
                  ...(session === undefined ? {} : { "mcp-session-id": session }),
                },
                body: Array.from(new TextEncoder().encode(json(body))),
              });
              return yield* owner.handle({ admission, signal });
            })
          );
        };
        const send = (body: Schema.Json, session?: string): Promise<Response> =>
          request(module, body, session);
        const held: Array<Response> = [];
        const pendingResponses: Array<Promise<Response>> = [];
        // The held Scope is callback-local, not the SDK layer Scope. Only public dispose completion
        // witnesses real module shutdown; this is not a proof of arbitrary eviction or crash recovery.
        const evidence = {
          progress,
          cleanupStarted,
          cleanupRelease,
          cleanupFinished,
          disposalStarted,
          disposalFinished,
        };
        yield* Scope.addFinalizer(
          yield* Scope.Scope,
          saveSdkDisposalEvidence(evidence, "before-cleanup").pipe(
            Effect.andThen(
              cleanupSdkOwners({
                modules,
                release: cleanupRelease,
                held,
                pending: pendingResponses,
                disposals: pendingDisposals,
                evidence,
              })
            ),
            Effect.andThen(saveSdkDisposalEvidence(evidence, "after-cleanup")),
            Effect.orDie
          )
        );
        {
          progress.push("WAIT successful native initialize and initialized notification");
          const session = yield* initialize(send);
          for (let index = 0; index < 7; index++) {
            const response = yield* wait(() =>
              send({
                jsonrpc: "2.0",
                id: index,
                method: "initialize",
                params: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  clientInfo: { name: "essential-scope", version: "1" },
                },
              })
            );
            expect(response.status).toBe(200);
            held.push(response);
          }
          const running = send(tool("essential-scope", "categories.listCategories"), session).then(
            (response) => {
              progress.push(`native target Response observed: ${response.status}`);
              return response;
            }
          );
          pendingResponses.push(running);
          progress.push(
            "initialize version/id and notification202 verified; seven unread owners added; WAIT callback-local Scope finalizer start"
          );
          yield* Deferred.await(cleanupStarted);
          progress.push(
            "callback-local Scope cleanup held; canonical query returned; WAIT SDK cancellation control"
          );
          expect(yield* Deferred.isDone(cleanupFinished)).toBe(false);
          const control = yield* wait(() =>
            send(
              {
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: {
                  requestId: "essential-scope",
                  reason: "Observe real SDK disposal with held Scope cleanup.",
                },
              },
              session
            )
          );
          expect(control.status).toBe(202);
          yield* wait(() => control.text());
          progress.push("control202 settled with callback-local cleanup held");
          yield* module.retireConnections(Option.some(connectionId));
          yield* settleNativeStatus(
            send({
              jsonrpc: "2.0",
              id: "ninth",
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "essential-scope", version: "1" },
              },
            }),
            503
          );
          expect(yield* Deferred.isDone(cleanupFinished)).toBe(false);
          progress.push("eight busy/retiring owners refuse ninth503 before cleanup release");
          const disposal = Effect.runPromiseWith(services)(
            Deferred.succeed(disposalStarted, undefined).pipe(
              Effect.andThen(module.dispose()),
              Effect.andThen(Deferred.succeed(disposalFinished, undefined)),
              Effect.asVoid
            )
          );
          pendingDisposals.push(disposal);
          yield* Deferred.await(disposalStarted);
          yield* settleNativeStatus(
            send({
              jsonrpc: "2.0",
              id: "closed",
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "essential-scope", version: "1" },
              },
            }),
            503
          );
          expect(yield* Deferred.isDone(disposalFinished)).toBe(false);
          expect(yield* Deferred.isDone(cleanupFinished)).toBe(false);
          progress.push(
            "published dispose started; admission closed503; disposal unfinished while cleanup held"
          );
          yield* Deferred.succeed(cleanupRelease, undefined);
          yield* settleLateSdkResponse({ response: running, disposal, progress });
          expect(yield* Deferred.isDone(cleanupFinished)).toBe(true);
          expect(yield* Deferred.isDone(disposalFinished)).toBe(true);
          progress.push(
            "cleanup completed, genuine target500/body settled, published disposal completed"
          );
          const freshModule = makeMcpResidency(config);
          modules.push(freshModule);
          const freshSend = (body: Schema.Json, id?: string): Promise<Response> =>
            request(freshModule, body, id);
          const freshSession = yield* initialize(freshSend);
          expect(freshSession).not.toBe(session);
          yield* settleNativeStatus(
            freshSend(
              { jsonrpc: "2.0", id: "disposed", method: "tools/list", params: {} },
              session
            ),
            404
          );
          expect(progress).toContain(
            "published dispose started; admission closed503; disposal unfinished while cleanup held"
          );
          expect(progress).toContain(
            "cleanup completed, genuine target500/body settled, published disposal completed"
          );
          expect(
            yield* wait(() =>
              harness.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
            )
          ).toBe(1);
          expect(
            yield* wait(() =>
              harness.db
                .prepare("SELECT count(*) FROM canonical_request_leases")
                .first<number>("count(*)")
            )
          ).toBe(0);
        }
      }).pipe(Effect.scoped, Effect.timeout("10 seconds"))
    ));
});
