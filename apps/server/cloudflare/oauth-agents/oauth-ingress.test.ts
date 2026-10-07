import { operationCatalog } from "../../src/shell/api";
import {
  discoveryCases,
  excludedAccountSecurityDiscovery,
  readDiscovery,
  sensitiveDiscovery,
} from "./discovery.test-fixture";
import {
  executeCanonicalWork,
  executeOAuthCanonicalWork,
  installedCanonicalOperations,
} from "../canonical-operations/operations";
import { allowancePeriod } from "../../src/core/quotas/operations";
import { categoryIds } from "../../src/core/categories/contract";
import { PATScopes } from "../../src/core/tokens/contract";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import {
  type Cause,
  Clock,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Redacted,
  Schema,
  Scope,
} from "effect";
import { deepStrictEqual } from "node:assert";
import { nativeHostBridgeFile, runNativeHostFixture } from "./native-host.test-fixture";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { applyTestMigration, installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import { authenticateOAuth, executeOAuthRefresh } from "./operations";
import { OAuthRefreshAdmission } from "./contract";
import { handleMcpRequest, makeMcpResidency } from "../mcp/runtime";
import { OAuthMcpAdmission } from "../mcp/contract";
import { secretDigest } from "../secret-material/operations";
import { handleOAuthRequest } from "./runtime";
import { reviewRequest } from "./internal/review";
import { manageConnections } from "./internal/management";
import { BootstrapUnavailable } from "./internal/bootstrap";
import { makeMutationCommitGate } from "./mutation-commit.test-fixture";
import { OAuthReviewChoice } from "../../src/shell/oauth-agents/contract";
import { makeAudit } from "../../src/shell/audit/runtime";
import { dailyAuditCount, recordOAuthCall } from "../../src/shell/audit/operations";
import { liveOAuthAuthority } from "../../src/shell/oauth-agents/operations";
import { prepareOwnedStatement } from "../database/operations";
import { browseTransactions } from "../transactions/operations";
import { UserTransactionCoordinator } from "../transactions/runtime";
import publicWorker from "../public-worker";
import coreWorker from "../core-worker";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
afterEach(() => vi.restoreAllMocks());
class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}
const decodeResponseJson = (response: Response): Promise<Schema.Json> =>
  response.json().then((body: unknown) => Schema.decodeUnknownSync(Schema.Json)(body));
const wait = <A>(promise: Promise<A>): Effect.Effect<A, TestFailure> =>
  Effect.tryPromise({ try: () => promise, catch: (cause) => new TestFailure({ cause }) });
type QueryGate = Readonly<{
  waiting: ReturnType<typeof Promise.withResolvers<void>>;
  release: ReturnType<typeof Promise.withResolvers<void>>;
  scheduled: string[];
}>;
const pauseBudgetRead = (
  statement: D1PreparedStatement,
  sql: string,
  gate: QueryGate
): D1PreparedStatement =>
  new Proxy(statement, {
    get: (target, key): unknown => {
      if (key === "bind") {
        return (...values: unknown[]): D1PreparedStatement =>
          pauseBudgetRead(target.bind(...values), sql, gate);
      }
      const method: unknown = Reflect.get(target, key);
      if (!Predicate.isFunction(method)) return method;
      return (...args: unknown[]): unknown => {
        if (key === "all" && sql.includes("FROM budgets WHERE") && gate.scheduled.length === 0) {
          gate.scheduled.push("held");
          gate.waiting.resolve();
          return gate.release.promise.then(() => {
            const result: unknown = Reflect.apply(method, target, args);
            return result;
          });
        }
        if (gate.scheduled.length > 0) gate.scheduled.push(sql);
        const result: unknown = Reflect.apply(method, target, args);
        return result;
      };
    },
  });
type Harness = Readonly<{
  disableInference: () => void;
  holdMutationCommit: () => Readonly<{
    waiting: Promise<void>;
    settled: Promise<void>;
    release: () => void;
  }>;
  holdBudgetRead: () => Readonly<{
    waiting: Promise<void>;
    release: () => void;
    scheduled: () => ReadonlyArray<string>;
  }>;
  db: D1Database;
  send: (path: string, init?: RequestInit) => Promise<Response>;
  coordinate: (userId: string, payload: Schema.Json) => Promise<Response>;
  refreshCoordinate: (userId: string, payload: Schema.Json) => Promise<Response>;
  revokeCoordinate: (userId: string, payload: Schema.Json) => Promise<Response>;
  restartCoordinators: () => void;
  interceptQueryResponse: (
    intercept: (input: Readonly<{ request: Request; response: Response }>) => Promise<Response>
  ) => void;
  holdRefresh: () => Readonly<{
    waiting: Promise<void>;
    settled: Promise<void>;
    release: () => void;
  }>;
}>;
const setup = (auditMigration = true): Effect.Effect<Harness, TestFailure> =>
  Effect.gen(function* () {
    const db = yield* wait(databases.acquire());
    const sources = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
    )
      .sort((left, right) => left.localeCompare(right))
      .filter((name) => auditMigration || name !== "0037_oauth_shared_audit_budget.sql")
      .map((name) => new URL(`../migrations/${name}`, import.meta.url));
    if (auditMigration) yield* wait(installTestSchema({ db, sources }));
    else for (const source of sources) yield* wait(applyTestMigration({ db, source }));
    const coordinators = new Map<string, UserTransactionCoordinator>();
    let queryGate: Option.Option<QueryGate> = Option.none();
    const mutationCommit = makeMutationCommitGate(db);
    const queryDb = new Proxy(mutationCommit.db, {
      get: (target, key): unknown => {
        if (key === "prepare") {
          return (sql: string): D1PreparedStatement =>
            Option.match(queryGate, {
              onNone: () => target.prepare(sql),
              onSome: (gate) => pauseBudgetRead(target.prepare(sql), sql, gate),
            });
        }
        const member: unknown = Reflect.get(target, key);
        return Predicate.isFunction(member) ? member.bind(target) : member;
      },
    });
    let queryResponseIntercept: Option.Option<
      (input: Readonly<{ request: Request; response: Response }>) => Promise<Response>
    > = Option.none();
    let refreshGate: Option.Option<
      Readonly<{
        waiting: ReturnType<typeof Promise.withResolvers<void>>;
        settled: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }>
    > = Option.none();
    const environment = {
      DB: queryDb,
      RELEASE_GIT_SHA: "a".repeat(40),
      CONTRACT_DIGEST: "a".repeat(64),
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      HOSTED_AI_MODEL: String(approvedWorkersAiModel),
      AI: {
        run: (): Promise<never> =>
          Promise.reject(new Error("Bootstrap must not purchase inference")),
      },
      USER_TRANSACTION_COORDINATOR: {
        getByName: (name: string): Pick<Fetcher, "fetch"> => ({
          fetch: (incoming): Promise<Response> => {
            const request = incoming instanceof Request ? incoming : new Request(incoming);
            const run = (): Promise<Response> => {
              let coordinator = coordinators.get(name);
              if (coordinator === undefined) {
                coordinator = new UserTransactionCoordinator(
                  { id: { name }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
                  environment
                );
                coordinators.set(name, coordinator);
              }
              return coordinator.fetch(request);
            };
            const intercept = queryResponseIntercept;
            if (new URL(request.url).pathname === "/oauth-canonical" && Option.isSome(intercept)) {
              return run().then((response) => intercept.value({ request, response }));
            }
            const gate = refreshGate;
            if (new URL(request.url).pathname !== "/oauth-refresh" || Option.isNone(gate)) {
              return run();
            }
            gate.value.waiting.resolve();
            return gate.value.release.promise.then(run).finally(gate.value.settled.resolve);
          },
        }),
      },
      KAPSO_API_KEY: "",
      KAPSO_WEBHOOK_SECRET: "",
      WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
      CLOUDFLARE_ACCESS_ISSUER: "",
      CLOUDFLARE_ACCESS_AUDIENCE: "",
      WOMPI_ENVIRONMENT: "",
      WOMPI_PUBLIC_KEY: "",
      WOMPI_PRIVATE_KEY: "",
      WOMPI_INTEGRITY_SECRET: "",
    };
    const send = (path: string, init: RequestInit = {}): Promise<Response> =>
      publicWorker.fetch(
        new Request(`https://api.fidyapp.com${path}`, {
          ...init,
          headers: new Headers({
            "cf-connecting-ip": "198.51.100.10",
            ...Object.fromEntries(new Headers(init.headers)),
          }),
        }),
        {
          BROWSER_ORIGIN: environment.BROWSER_ORIGIN,
          LOCAL_CANONICAL_READ_BEARER: "",
          PAT_ADMISSION_KEY: "test-only-source-admission-key-32-bytes",
          RELEASE_GIT_SHA: environment.RELEASE_GIT_SHA,
          // A service binding consumes the forwarded request; it does not tee its body.
          CORE: {
            fetch: (incoming) =>
              coreWorker.fetch(
                incoming instanceof Request ? incoming : new Request(incoming),
                environment
              ),
          },
        }
      );
    return {
      db: queryDb,
      send,
      holdMutationCommit: mutationCommit.hold,
      disableInference: () => {
        environment.HOSTED_AI_MODEL = "";
      },
      restartCoordinators: () => coordinators.clear(),
      holdBudgetRead: () => {
        const gate: QueryGate = {
          waiting: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
          scheduled: [],
        };
        queryGate = Option.some(gate);
        return {
          waiting: gate.waiting.promise,
          release: gate.release.resolve,
          scheduled: () => gate.scheduled.slice(1),
        };
      },
      interceptQueryResponse: (intercept) => {
        queryResponseIntercept = Option.some(intercept);
      },
      holdRefresh: () => {
        const gate = {
          waiting: Promise.withResolvers<void>(),
          settled: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
        };
        refreshGate = Option.some(gate);
        return {
          waiting: gate.waiting.promise,
          settled: gate.settled.promise,
          release: gate.release.resolve,
        };
      },
      revokeCoordinate: (userId, payload) =>
        environment.USER_TRANSACTION_COORDINATOR.getByName(userId).fetch(
          new Request("https://coordinator.internal/oauth-revoke", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: Schema.encodeSync(Schema.fromJsonString(Schema.Json))(payload),
          })
        ),
      refreshCoordinate: (userId, payload) =>
        environment.USER_TRANSACTION_COORDINATOR.getByName(userId).fetch(
          new Request("https://coordinator.internal/oauth-refresh", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: Schema.encodeSync(Schema.fromJsonString(Schema.Json))(payload),
          })
        ),
      coordinate: (userId, payload) =>
        environment.USER_TRANSACTION_COORDINATOR.getByName(userId).fetch(
          new Request("https://coordinator.internal/oauth-canonical", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: Schema.encodeSync(Schema.fromJsonString(Schema.Json))(payload),
          })
        ),
    };
  });
const sessionForUser = (
  input: Readonly<{ db: D1Database; index: number; userIndex: number }>
): Effect.Effect<string, TestFailure> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const user = `${input.userIndex}0000000-0000-4000-8000-000000000001`;
    const pairing = `${input.index}0000000-0000-4000-8000-000000000002`;
    const session = `${input.index}0000000-0000-4000-8000-000000000003`;
    const bearer = String(input.index).repeat(43);
    const digest = new Uint8Array(
      yield* wait(crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)))
    );
    yield* wait(
      input.db.batch([
        input.db
          .prepare(
            "INSERT OR IGNORE INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(user, current),
        input.db
          .prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES (?,?,?,?,'consumed',?,?)"
          )
          .bind(pairing, `BCDF-GHJ${input.index}`, digest, user, current, current + 600000),
        input.db
          .prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)"
          )
          .bind(
            session,
            pairing,
            user,
            digest,
            current,
            current + 600000,
            current + 600000,
            current + 7776000000
          ),
      ])
    );
    return `__Host-fidy_session=${bearer}`;
  });
const sessionFor = (
  input: Readonly<{ db: D1Database; index: number }>
): Effect.Effect<string, TestFailure> => sessionForUser({ ...input, userIndex: input.index });
const authorizationQuery = (
  send: Harness["send"]
): Effect.Effect<URLSearchParams, TestFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const registered = yield* wait(
      send("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"client_name":"<img src=x onerror=alert(1)>","redirect_uris":["http://127.0.0.1/callback"],"grant_types":["authorization_code","refresh_token"]}',
      })
    );
    const client = yield* Schema.decodeUnknownEffect(Schema.Struct({ client_id: Schema.String }))(
      yield* wait(registered.json())
    );
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:3456/callback",
      response_type: "code",
      resource: "https://api.fidyapp.com/mcp",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    return query;
  });
const startReview = (
  send: Harness["send"]
): Effect.Effect<string, TestFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const query = yield* authorizationQuery(send);
    const started = yield* wait(send(`/oauth/authorize?${query}`));
    expect(started.status).toBe(302);
    return new URL(started.headers.get("location") ?? "").pathname.split("/").at(-1) ?? "";
  });
const sendFrom =
  (send: Harness["send"], index: number): Harness["send"] =>
  (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", `198.51.100.${index + 1}`);
    return send(path, { ...init, headers });
  };
const clockAt = (
  live: Clock.Clock,
  current: number,
  read: () => number = () => current
): Clock.Clock => ({
  currentTimeMillisUnsafe: read,
  currentTimeMillis: Effect.sync(read),
  currentTimeNanosUnsafe: () => BigInt(current) * 1000000n,
  currentTimeNanos: Effect.succeed(BigInt(current) * 1000000n),
  monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: live.monotonicTimeNanos,
  sleep: (duration) => live.sleep(duration),
});
const assertReleased = (db: D1Database): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    expect(
      yield* wait(
        db
          .prepare(
            "SELECT count(*) FROM resource_admission_events WHERE policy_key = 'oauth.concurrent.v1' AND released_at_epoch_ms IS NULL"
          )
          .first<number>("count(*)")
      )
    ).toBe(0);
  });
type HeldBody = Readonly<{
  body: ReadableStream<Uint8Array>;
  reading: Promise<void>;
  release: () => void;
}>;
const heldBody = (): HeldBody => {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller): Promise<void> => {
        reading.resolve();
        return release.promise.then(() => controller.close());
      },
    },
    { highWaterMark: 0 }
  );
  return { body, reading: reading.promise, release: release.resolve };
};
type FixtureHeaders = Readonly<{ origin: string; cookie: string; "content-type": string }>;
const reviewedFixture = (
  scopes: ReadonlyArray<string> = ["read"],
  lifetimeDays = 7,
  auditMigration = true
): Effect.Effect<
  Harness & Readonly<{ query: URLSearchParams; choice: string; headers: FixtureHeaders }>,
  TestFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const harness = yield* setup(auditMigration);
    const query = yield* authorizationQuery(harness.send);
    query.set("scope", scopes.join(" "));
    const started = yield* wait(harness.send(`/oauth/authorize?${query}`));
    const requestId =
      new URL(started.headers.get("location") ?? "").pathname.split("/").at(-1) ?? "";
    const cookie = yield* sessionFor({ db: harness.db, index: 1 });
    yield* wait(
      harness.db
        .prepare(
          "INSERT INTO onboarding_consent_records VALUES ('grant-test', ?, '{}', 'disclosure', 'decision', 1, 1)"
        )
        .bind("10000000-0000-4000-8000-000000000001")
        .run()
    );
    const headers = {
      origin: "https://app.fidyapp.com",
      cookie,
      "content-type": "application/json",
    };
    const review = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ reviewedAt: Schema.DateTimeUtcFromString })
    )(
      yield* wait(
        (yield* wait(harness.send(`/web/oauth/review?requestId=${requestId}`, { headers }))).json()
      )
    );
    const choice = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
      requestId,
      scopes: [...scopes],
      lifetimeDays,
      reviewedAt: DateTime.formatIso(review.reviewedAt),
      expiresAt: DateTime.formatIso(DateTime.add(review.reviewedAt, { days: lifetimeDays })),
    });
    return { ...harness, query, choice, headers };
  });
const approvedFixture = (
  scopes: ReadonlyArray<string> = ["read"],
  lifetimeDays = 7,
  auditMigration = true
): Effect.Effect<
  Harness & Readonly<{ connectionId: string; body: URLSearchParams; headers: FixtureHeaders }>,
  TestFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const { choice, query, headers, ...harness } = yield* reviewedFixture(
      scopes,
      lifetimeDays,
      auditMigration
    );
    const approved = yield* wait(
      harness.send("/web/oauth/connect", { method: "POST", headers, body: choice })
    );
    expect(approved.status).toBe(200);
    const connected = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ connectionId: Schema.String, callback: Schema.String })
    )(yield* wait(approved.json()));
    const callback = new URL(connected.callback);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      client_id: query.get("client_id") ?? "",
      redirect_uri: query.get("redirect_uri") ?? "",
      resource: "https://api.fidyapp.com/mcp",
      code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });
    return { ...harness, connectionId: connected.connectionId, body, headers };
  });
const exchangeFixture = (
  fixture: Readonly<{ send: Harness["send"]; body: URLSearchParams }>
): Promise<Response> =>
  fixture.send("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: fixture.body.toString(),
  });
const mcpFixture = (
  input: Readonly<
    { send: Harness["send"]; bearer: string } & (
      | { method: "tools/list" }
      | { method: "tools/call"; name: string; args: Schema.Json }
    )
  >,
  retryKey: Option.Option<Schema.Json> = Option.none()
): Promise<Response> =>
  input.send("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": input.method,
      ...(input.method === "tools/list" ? {} : { "mcp-name": input.name }),
    },
    body: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
      jsonrpc: "2.0",
      id: 1,
      method: input.method,
      params: {
        ...(input.method === "tools/list" ? {} : { name: input.name, arguments: input.args }),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          ...Option.match(retryKey, {
            onNone: () => ({}),
            onSome: (retryKey) => ({ "co.fidy/retryKey": retryKey }),
          }),
        },
      },
    }),
  });
const nativeConfirmationCall = (
  fixture: Readonly<{ send: Harness["send"]; bearer: string }>,
  params: Schema.Json,
  name = "budgets.deleteBudget"
): Promise<Response> =>
  fixture.send("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        ...Schema.decodeUnknownSync(Schema.JsonObject)(params),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
        },
      },
    }),
  });

it("reviews an exact Budget deletion natively and consumes client acceptance with its mutation once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const bearer = token.access_token;
      const created = yield* wait(
        mcpFixture({
          ...fixture,
          bearer,
          method: "tools/call",
          name: "budgets.createBudget",
          args: {
            payload: { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } },
          },
        })
      );
      const creation = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
          }),
        })
      )(yield* wait(created.json()));
      const id = creation.result.structuredContent.data.id;
      const args = { params: { id } };
      const review = yield* wait(
        nativeConfirmationCall(
          { ...fixture, bearer },
          { name: "budgets.deleteBudget", arguments: args }
        )
      );
      const pending = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({ requestState: Schema.String, inputRequests: Schema.JsonObject }),
        })
      )(yield* wait(review.json()));
      expect(pending.result.inputRequests).toMatchObject({
        review: {
          method: "elicitation/create",
          params: {
            mode: "form",
            requestedSchema: { required: ["confirm"], properties: { confirm: { default: false } } },
          },
        },
      });
      expect(pending.result.inputRequests["review"]).toBeDefined();
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(id)
            .first<number>("count(*)")
        )
      ).toBe(1);
      const resume = {
        name: "budgets.deleteBudget",
        arguments: args,
        requestState: pending.result.requestState,
        inputResponses: { review: { action: "accept", content: { confirm: true } } },
      };
      const accepted = yield* wait(nativeConfirmationCall({ ...fixture, bearer }, resume));
      expect(yield* wait(accepted.json())).toMatchObject({ result: { isError: false } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(id)
            .first<number>("count(*)")
        )
      ).toBe(0);
      const replay = yield* wait(nativeConfirmationCall({ ...fixture, bearer }, resume));
      expect(yield* wait(replay.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
            )
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

const pendingBudgetDeletion = (
  scopes: ReadonlyArray<string> = ["read", "write"]
): Effect.Effect<
  Readonly<{
    db: D1Database;
    send: Harness["send"];
    bearer: string;
    id: string;
    reference: string;
    connectionId: string;
    holdMutationCommit: Harness["holdMutationCommit"];
    call: (response: Schema.Json, argumentsOverride?: Schema.Json) => Promise<Response>;
  }>,
  TestFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const fixture = yield* approvedFixture(scopes);
    const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
      yield* wait((yield* wait(exchangeFixture(fixture))).json())
    );
    const bearer = token.access_token;
    const created = yield* wait(
      mcpFixture({
        ...fixture,
        bearer,
        method: "tools/call",
        name: "budgets.createBudget",
        args: {
          payload: { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } },
        },
      })
    );
    const creation = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        result: Schema.Struct({
          structuredContent: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
        }),
      })
    )(yield* wait(created.json()));
    const id = creation.result.structuredContent.data.id;
    const args = { params: { id } };
    const review = yield* wait(
      nativeConfirmationCall(
        { ...fixture, bearer },
        { name: "budgets.deleteBudget", arguments: args }
      )
    );
    const pending = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ result: Schema.Struct({ requestState: Schema.String }) })
    )(yield* wait(review.json()));
    const call = (
      response: Schema.Json,
      argumentsOverride: Schema.Json = args
    ): Promise<Response> =>
      nativeConfirmationCall(
        { ...fixture, bearer },
        {
          name: "budgets.deleteBudget",
          arguments: argumentsOverride,
          requestState: pending.result.requestState,
          inputResponses: { review: response },
        }
      );
    return { ...fixture, bearer, id, call, reference: pending.result.requestState };
  });
const explicitNativeAccept = { action: "accept", content: { confirm: true } };

const refusingNativeResponses: ReadonlyArray<Schema.Json> = [
  { action: "decline" },
  { action: "cancel" },
  { action: "accept", content: { confirm: false } },
  { action: "accept" },
  { action: "accept", content: {} },
  { action: "accept", content: { confirm: "true" } },
];
it.each(refusingNativeResponses)(
  "refuses native response %j without deleting the reviewed Budget or recording acceptance",
  (response) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion();
        const declined = yield* wait(fixture.call(response));
        expect(yield* wait(declined.json())).toMatchObject({ result: { isError: true } });
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM budgets WHERE id = ?")
              .bind(fixture.id)
              .first<number>("count(*)")
          )
        ).toBe(1);
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
              )
              .first<number>("count(*)")
          )
        ).toBe(0);
        const later = yield* wait(fixture.call(explicitNativeAccept));
        expect(yield* wait(later.json())).toMatchObject({ result: { isError: true } });
      })
    )
);

it("rejects changed canonical input and stale Budget revisions without consuming a valid intent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const changed = yield* wait(
        fixture.call(explicitNativeAccept, { params: { id: fixture.id }, confirm: true })
      );
      expect(yield* wait(changed.json())).toMatchObject({ result: { isError: true } });
      yield* wait(
        fixture.db.prepare("UPDATE budgets SET cap = '2000' WHERE id = ?").bind(fixture.id).run()
      );
      const stale = yield* wait(fixture.call(explicitNativeAccept));
      expect(yield* wait(stale.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT cap FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<string>("cap")
        )
      ).toBe("2000");
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
            .bind(fixture.reference)
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

it("rejects expired native intents and bounds outstanding intents per User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const current = yield* Clock.currentTimeMillis;
      yield* wait(
        fixture.db
          .prepare(
            "UPDATE oauth_operation_intents SET created_at_ms = ?, expires_at_ms = ? WHERE reference = ?"
          )
          .bind(current - 300001, current - 1, fixture.reference)
          .run()
      );
      const expired = yield* wait(fixture.call(explicitNativeAccept));
      expect(yield* wait(expired.json())).toMatchObject({ result: { isError: true } });
      for (let index = 0; index < 5; index += 1) {
        const review = yield* wait(
          nativeConfirmationCall(fixture, {
            name: "budgets.deleteBudget",
            arguments: { params: { id: fixture.id } },
          })
        );
        expect(yield* wait(review.json())).toHaveProperty("result.requestState");
      }
      const overflow = yield* wait(
        nativeConfirmationCall(fixture, {
          name: "budgets.deleteBudget",
          arguments: { params: { id: fixture.id } },
        })
      );
      expect(yield* wait(overflow.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_operation_intents")
            .first<number>("count(*)")
        )
      ).toBe(5);
    })
  ));

it("rolls back native intent consumption with failed Audit and allows only one concurrent successful deletion", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      yield* wait(
        fixture.db
          .prepare(
            "CREATE TRIGGER fail_native_audit BEFORE INSERT ON pat_audit WHEN NEW.operation = 'budgets.deleteBudget' AND NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test_native_audit_failure'); END"
          )
          .run()
      );
      const failed = yield* wait(fixture.call(explicitNativeAccept));
      expect(yield* wait(failed.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
            .bind(fixture.reference)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(1);
      yield* wait(fixture.db.prepare("DROP TRIGGER fail_native_audit").run());
      const raced = yield* wait(
        Promise.all([fixture.call(explicitNativeAccept), fixture.call(explicitNativeAccept)])
      );
      const replies = yield* wait(Promise.all(raced.map((reply) => reply.json())));
      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ result: Schema.Struct({ isError: Schema.Boolean }) }))
      )(replies);
      expect(parsed.filter(({ result }) => !result.isError)).toHaveLength(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
            )
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

it("resumes the original legacy native tool call after server-requested form acceptance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const headers = {
        authorization: `Bearer ${fixture.bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const initialized = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: { ...headers, accept: "text/event-stream, application/json" },
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: "init-native-review",
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: { elicitation: { form: {} } },
              clientInfo: { name: "native-form-fixture", version: "1" },
            },
          }),
        })
      );
      const session = initialized.headers.get("mcp-session-id") ?? "";
      // Codex's legacy transport consumes the initialization frame and cancels that HTTP body;
      // this completed response must not retire the independently retained native session.
      const initializedReader = Option.getOrThrow(Option.fromNullOr(initialized.body)).getReader();
      yield* wait(initializedReader.read());
      yield* wait(initializedReader.cancel());
      const sessionHeaders = {
        ...headers,
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": session,
      };
      const notified = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: sessionHeaders,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        })
      );
      expect(notified.status).toBe(202);
      yield* wait(notified.text());
      const invoked = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: {
            ...sessionHeaders,
            "mcp-method": "tools/call",
            "mcp-name": "budgets.deleteBudget",
          },
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: "delete-legacy",
            method: "tools/call",
            params: { name: "budgets.deleteBudget", arguments: { params: { id: fixture.id } } },
          }),
        })
      );
      expect(invoked.headers.get("content-type")).toContain("text/event-stream");
      const reader = Option.getOrThrow(Option.fromNullOr(invoked.body)).getReader();
      const requested = yield* wait(reader.read());
      const requestedBytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(requested.value);
      const data =
        new TextDecoder()
          .decode(requestedBytes)
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length) ?? "";
      const form = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            id: Schema.Union([Schema.String, Schema.Finite]),
            method: Schema.Literal("elicitation/create"),
          })
        )
      )(data);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(1);
      yield* Effect.sleep("6 seconds");
      const replied = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: sessionHeaders,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: form.id,
            result: explicitNativeAccept,
          }),
        })
      );
      yield* wait(replied.text());
      const completion = yield* wait(reader.read());
      const completionBytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(
        completion.value
      );
      const completedData =
        new TextDecoder()
          .decode(completionBytes)
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length) ?? "";
      const result = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            id: Schema.Literal("delete-legacy"),
            result: Schema.Struct({ isError: Schema.Boolean }),
          })
        )
      )(completedData);
      expect(result.result.isError).toBe(false);
      yield* wait(reader.cancel());
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("reviews the complete ordered sensitive batch and commits all children once, not a substituted batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const name = "operations.executeAtomicBatch";
      const calls: ReadonlyArray<Schema.Json> = [
        {
          callId: "20000000-0000-4000-8000-000000000031",
          operation: "budgets.deleteBudget",
          input: { params: { id: fixture.id } },
        },
        {
          callId: "20000000-0000-4000-8000-000000000032",
          operation: "categories.createKeywordRule",
          input: { payload: { keyword: "native batch", categoryId: categoryIds.mercado } },
        },
      ];
      const args = { payload: { calls } };
      const review = yield* wait(nativeConfirmationCall(fixture, { name, arguments: args }, name));
      const pending = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ result: Schema.Struct({ requestState: Schema.String }) })
      )(yield* wait(review.json()));
      const resume = (argumentsOverride: Schema.Json): Promise<Response> =>
        nativeConfirmationCall(
          fixture,
          {
            name,
            arguments: argumentsOverride,
            requestState: pending.result.requestState,
            inputResponses: { review: explicitNativeAccept },
          },
          name
        );
      const changed = yield* wait(resume({ payload: { calls: [...calls].reverse() } }));
      expect(yield* wait(changed.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM keyword_rules").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(1);
      const accepted = yield* wait(resume(args));
      expect(yield* wait(accepted.json())).toMatchObject({ result: { isError: false } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM keyword_rules WHERE keyword = 'native batch'")
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<number>("count(*)")
        )
      ).toBe(0);
      const replay = yield* wait(resume(args));
      expect(yield* wait(replay.json())).toMatchObject({ result: { isError: true } });
    })
  ));

it("reviews and applies an exact Budget update without accepting a changed cap", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const name = "budgets.updateBudget";
      const args = {
        params: { id: fixture.id },
        payload: { categoryId: categoryIds.mercado, cap: { amount: "2500", currency: "COP" } },
      };
      const review = yield* wait(nativeConfirmationCall(fixture, { name, arguments: args }, name));
      const pending = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ result: Schema.Struct({ requestState: Schema.String }) })
      )(yield* wait(review.json()));
      const changed = yield* wait(
        nativeConfirmationCall(
          fixture,
          {
            name,
            arguments: {
              ...args,
              payload: { ...args.payload, cap: { amount: "9999", currency: "COP" } },
            },
            requestState: pending.result.requestState,
            inputResponses: { review: explicitNativeAccept },
          },
          name
        )
      );
      expect(yield* wait(changed.json())).toMatchObject({ result: { isError: true } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT cap FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<string>("cap")
        )
      ).toBe("1000");
      const resumed = yield* wait(
        nativeConfirmationCall(
          fixture,
          {
            name,
            arguments: args,
            requestState: pending.result.requestState,
            inputResponses: { review: explicitNativeAccept },
          },
          name
        )
      );
      expect(yield* wait(resumed.json())).toMatchObject({ result: { isError: false } });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT cap FROM budgets WHERE id = ?")
            .bind(fixture.id)
            .first<string>("cap")
        )
      ).toBe("2500");
    })
  ));

it.each(["single", "batch"] as const)(
  "rechecks live authority while consuming native evidence in the protected %s unit",
  (unit) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const changed of ["grant", "consent", "scope"] as const) {
          const fixture = yield* pendingBudgetDeletion();
          const name = unit === "single" ? "budgets.deleteBudget" : "operations.executeAtomicBatch";
          const calls: ReadonlyArray<Schema.Json> = [
            {
              callId: "20000000-0000-4000-8000-000000000033",
              operation: "budgets.deleteBudget",
              input: { params: { id: fixture.id } },
            },
            {
              callId: "20000000-0000-4000-8000-000000000034",
              operation: "categories.createKeywordRule",
              input: { payload: { keyword: "held native unit", categoryId: categoryIds.mercado } },
            },
          ];
          const args: Schema.Json =
            unit === "single" ? { params: { id: fixture.id } } : { payload: { calls } };
          const review = yield* wait(
            nativeConfirmationCall(fixture, { name, arguments: args }, name)
          );
          const pending = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ result: Schema.Struct({ requestState: Schema.String }) })
          )(yield* wait(review.json()));
          const held = fixture.holdMutationCommit();
          const accepted = nativeConfirmationCall(
            fixture,
            {
              name,
              arguments: args,
              requestState: pending.result.requestState,
              inputResponses: { review: explicitNativeAccept },
            },
            name
          );
          yield* wait(held.waiting);
          if (changed === "grant") {
            yield* wait(
              fixture.db
                .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
                .bind(yield* Clock.currentTimeMillis, fixture.connectionId)
                .run()
            );
          }
          if (changed === "consent") {
            yield* revokeFixtureConsent(fixture.db);
          }
          if (changed === "scope") {
            yield* wait(
              fixture.db
                .prepare("UPDATE oauth_access_credentials SET scopes_json = '[\"read\"]'")
                .run()
            );
          }
          held.release();
          const response = yield* wait(accepted);
          yield* wait(held.settled);
          expect(yield* wait(response.json()), changed).toMatchObject({
            result: { isError: true },
          });
          expect(
            yield* wait(
              fixture.db
                .prepare("SELECT count(*) FROM budgets WHERE id = ?")
                .bind(fixture.id)
                .first<number>("count(*)")
            )
          ).toBe(1);
          expect(
            yield* wait(
              fixture.db.prepare("SELECT count(*) FROM keyword_rules").first<number>("count(*)")
            )
          ).toBe(0);
          expect(
            yield* wait(
              fixture.db
                .prepare(
                  "SELECT count(*) FROM pat_audit WHERE operation = 'budgets.deleteBudget' AND outcome = 'accepted'"
                )
                .first<number>("count(*)")
            )
          ).toBe(0);
          expect(
            yield* wait(
              fixture.db
                .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
                .bind(pending.result.requestState)
                .first<number>("count(*)")
            )
          ).toBe(1);
        }
      })
    )
);

const nativePeer = (
  fixture: Pick<NativeFixture, "send" | "db">,
  userIndex: 1 | 2
): Effect.Effect<
  Readonly<{ bearer: string; connectionId: string }>,
  TestFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const query = yield* authorizationQuery(fixture.send);
    query.set("scope", "read write");
    const started = yield* wait(fixture.send(`/oauth/authorize?${query}`));
    const requestId =
      new URL(started.headers.get("location") ?? "").pathname.split("/").at(-1) ?? "";
    const cookie = yield* sessionForUser({ db: fixture.db, index: userIndex + 7, userIndex });
    yield* wait(
      fixture.db
        .prepare(
          "INSERT OR IGNORE INTO onboarding_consent_records VALUES (?, ?, '{}', 'disclosure', 'decision', 1, 1)"
        )
        .bind(`native-peer-${userIndex}`, `${userIndex}0000000-0000-4000-8000-000000000001`)
        .run()
    );
    const headers = {
      origin: "https://app.fidyapp.com",
      cookie,
      "content-type": "application/json",
    };
    const reviewed = yield* wait(
      fixture.send(`/web/oauth/review?requestId=${requestId}`, { headers })
    );
    const disclosure = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ reviewedAt: Schema.DateTimeUtcFromString })
    )(yield* wait(reviewed.json()));
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
      requestId,
      scopes: ["read", "write"],
      lifetimeDays: 7,
      reviewedAt: DateTime.formatIso(disclosure.reviewedAt),
      expiresAt: DateTime.formatIso(DateTime.add(disclosure.reviewedAt, { days: 7 })),
    });
    const connected = yield* wait(
      fixture.send("/web/oauth/connect", { method: "POST", headers, body })
    );
    const approved = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ connectionId: Schema.String, callback: Schema.String })
    )(yield* wait(connected.json()));
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: query.get("client_id") ?? "",
      code: new URL(approved.callback).searchParams.get("code") ?? "",
      code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      redirect_uri: query.get("redirect_uri") ?? "",
      resource: "https://api.fidyapp.com/mcp",
    });
    const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
      yield* wait((yield* wait(exchangeFixture({ send: fixture.send, body: tokenBody }))).json())
    );
    return { bearer: token.access_token, connectionId: approved.connectionId };
  });
it.each([1, 2] as const)(
  "does not lend native intent authority to another connection of User %s",
  (userIndex) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion();
        const peer = yield* nativePeer(fixture, userIndex);
        expect(peer.connectionId).not.toBe(fixture.connectionId);
        const refused = yield* wait(
          nativeConfirmationCall(
            { send: fixture.send, bearer: peer.bearer },
            {
              name: "budgets.deleteBudget",
              arguments: { params: { id: fixture.id } },
              requestState: fixture.reference,
              inputResponses: { review: explicitNativeAccept },
            }
          )
        );
        expect(yield* wait(refused.json())).toMatchObject({ result: { isError: true } });
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM budgets WHERE id = ?")
              .bind(fixture.id)
              .first<number>("count(*)")
          )
        ).toBe(1);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
              .bind(fixture.reference)
              .first<number>("count(*)")
          )
        ).toBe(1);
        const original = yield* wait(fixture.call(explicitNativeAccept));
        expect(yield* wait(original.json())).toMatchObject({ result: { isError: false } });
      })
    )
);

const nativeOwnerJourneys = [
  "categories.updateKeywordRule",
  "categories.deleteKeywordRule",
  "memory.revise",
  "memory.forget",
  "dashboard.applyDashboardEdit",
  "transactions.updateTransaction",
  "insights.markInsightRead",
  "insights.dismissInsight",
  "insights.markInsightDelivered",
] as const;
type NativeOwnerJourney = (typeof nativeOwnerJourneys)[number];
type NativeFixture = Effect.Success<ReturnType<typeof pendingBudgetDeletion>>;
const ownerArgs = (input: Schema.Json): Schema.Json => input;
const insightJourneyArgs = (
  fixture: NativeFixture,
  name: NativeOwnerJourney
): Effect.Effect<Schema.Json, TestFailure> =>
  Effect.gen(function* () {
    const id = "40000000-0000-4000-8000-000000000988";
    yield* wait(
      fixture.db
        .prepare(
          "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) VALUES(?,?,'weekly-summary','40000000-0000-4000-8000-000000000001',1,'CO','es-CO','America/Bogota','2026-10-03T12:00:00.000Z','[]')"
        )
        .bind(id, "10000000-0000-4000-8000-000000000001")
        .run()
    );
    return name === "insights.markInsightDelivered"
      ? ownerArgs({
          params: { id },
          payload: {
            sentAt: "2026-10-03T12:00:00.000Z",
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "synthetic-native-delivery",
          },
        })
      : ownerArgs({ params: { id } });
  });
const ownerJourneyArgs = (
  fixture: NativeFixture,
  name: NativeOwnerJourney
): Effect.Effect<Schema.Json, TestFailure> =>
  Effect.gen(function* () {
    const ordinary = (operation: string, args: Schema.Json): Promise<Response> =>
      mcpFixture({
        send: fixture.send,
        bearer: fixture.bearer,
        method: "tools/call",
        name: operation,
        args,
      });
    if (name.startsWith("categories.")) {
      const created = yield* wait(
        ordinary("categories.createKeywordRule", {
          payload: { keyword: "original native rule", categoryId: categoryIds.mercado },
        })
      );
      expect(yield* wait(created.json())).toMatchObject({ result: { isError: false } });
      const id = yield* wait(
        fixture.db.prepare("SELECT id FROM keyword_rules LIMIT 1").first<string>("id")
      );
      return name === "categories.deleteKeywordRule"
        ? ownerArgs({ params: { id } })
        : ownerArgs({
            params: { id },
            payload: { keyword: "replacement native rule", categoryId: categoryIds.restaurantes },
          });
    }
    if (name.startsWith("memory.")) {
      const created = yield* wait(
        ordinary("memory.remember", { payload: { text: "I plan monthly spending." } })
      );
      expect(yield* wait(created.json())).toMatchObject({ result: { isError: false } });
      const id = yield* wait(
        fixture.db.prepare("SELECT id FROM memories LIMIT 1").first<string>("id")
      );
      return name === "memory.forget"
        ? ownerArgs({ params: { id } })
        : ownerArgs({ params: { id }, payload: { text: "I plan weekly spending." } });
    }
    if (name === "dashboard.applyDashboardEdit") {
      const initialized = yield* wait(ordinary("dashboard.initializeDashboard", {}));
      expect(yield* wait(initialized.json())).toMatchObject({ result: { isError: false } });
      return ownerArgs({ payload: { op: "set-title", title: "Revisión nativa" } });
    }
    if (name === "transactions.updateTransaction") {
      const created = yield* wait(ordinary("transactions.createTransaction", transactionArguments));
      expect(yield* wait(created.json())).toMatchObject({ result: { isError: false } });
      const id = yield* wait(
        fixture.db.prepare("SELECT id FROM transactions LIMIT 1").first<string>("id")
      );
      return ownerArgs({
        params: { id },
        payload: { expectedRevision: 0, changes: { counterparty: "Corregida" } },
      });
    }
    return yield* insightJourneyArgs(fixture, name);
  });
it.each(nativeOwnerJourneys)(
  "native OAuth confirmation reaches the canonical owner for %s",
  (name) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* pendingBudgetDeletion(["write", "dashboard"]);
        const args = yield* ownerJourneyArgs(fixture, name);
        const review = yield* wait(
          nativeConfirmationCall(fixture, { name, arguments: args }, name)
        );
        const pending = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            result: Schema.Struct({
              requestState: Schema.String,
              inputRequests: Schema.Struct({
                review: Schema.Struct({
                  params: Schema.Struct({ message: Schema.NonEmptyString }),
                }),
              }),
            }),
          })
        )(yield* wait(review.json()));
        const accepted = yield* wait(
          nativeConfirmationCall(
            fixture,
            {
              name,
              arguments: args,
              requestState: pending.result.requestState,
              inputResponses: { review: explicitNativeAccept },
            },
            name
          )
        );
        expect(yield* wait(accepted.json())).toMatchObject({ result: { isError: false } });
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM pat_audit WHERE operation = ? AND outcome = 'accepted'"
              )
              .bind(name)
              .first<number>("count(*)")
          )
        ).toBe(1);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_operation_intents WHERE reference = ?")
              .bind(pending.result.requestState)
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);

it.skipIf(Option.isNone(nativeHostBridgeFile))(
  "serves the real confirmation seam to pinned native hosts",
  () => Effect.runPromise(runNativeHostFixture(pendingBudgetDeletion)),
  600000
);

const approveAgain = (
  fixture: Readonly<{ send: Harness["send"]; body: URLSearchParams; headers: FixtureHeaders }>
): Effect.Effect<
  Readonly<{ connectionId: string; body: URLSearchParams }>,
  TestFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const query = new URLSearchParams({
      client_id: fixture.body.get("client_id") ?? "",
      redirect_uri: fixture.body.get("redirect_uri") ?? "",
      response_type: "code",
      resource: "https://api.fidyapp.com/mcp",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const started = yield* wait(fixture.send(`/oauth/authorize?${query}`));
    const requestId =
      new URL(started.headers.get("location") ?? "").pathname.split("/").at(-1) ?? "";
    const review = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ reviewedAt: Schema.DateTimeUtcFromString })
    )(
      yield* wait(
        (yield* wait(
          fixture.send(`/web/oauth/review?requestId=${requestId}`, { headers: fixture.headers })
        )).json()
      )
    );
    const choice = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
      requestId,
      scopes: ["read"],
      lifetimeDays: 7,
      reviewedAt: DateTime.formatIso(review.reviewedAt),
      expiresAt: DateTime.formatIso(DateTime.add(review.reviewedAt, { days: 7 })),
    });
    const approved = yield* wait(
      fixture.send("/web/oauth/connect", { method: "POST", headers: fixture.headers, body: choice })
    );
    const replacement = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ connectionId: Schema.String, callback: Schema.String })
    )(yield* wait(approved.json()));
    const body = new URLSearchParams(fixture.body);
    body.set("code", new URL(replacement.callback).searchParams.get("code") ?? "");
    return { connectionId: replacement.connectionId, body };
  });
const authenticatedHistoryFixture = Effect.fn(function* (auditMigration: boolean = true) {
  const fixture = yield* approvedFixture(["read", "write"], 7, auditMigration);
  const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
    yield* wait((yield* wait(exchangeFixture(fixture))).json())
  );
  const current = yield* Clock.currentTimeMillis;
  const caller = yield* authenticateOAuth({
    db: fixture.db,
    current,
    request: new Request("https://api.fidyapp.com/mcp", {
      headers: { authorization: `Bearer ${token.access_token}` },
    }),
  });
  if (Option.isNone(caller)) {
    return yield* new TestFailure({ cause: "fixture OAuth authentication failed" });
  }
  const subject = caller.value.subject;
  const read = (db: D1Database = fixture.db): Effect.Effect<Response> =>
    browseTransactions({
      db,
      selection: {
        subject,
        request: new Request("https://core.internal/transactions"),
        search: false,
        id: Option.none(),
      },
    });
  const audit = (
    id: string,
    operation = "transactions.listTransactions",
    outcome: "accepted" | "rejected" = "accepted"
  ): D1PreparedStatement =>
    prepareOwnedStatement({
      db: fixture.db,
      statement: recordOAuthCall({
        authority: liveOAuthAuthority({ subject, current }),
        id,
        current,
        operation: CanonicalOperationId.make(operation),
        outcome,
      }),
    });
  return { ...fixture, current, subject, read, audit };
});

it("upgrades retained OAuth Audit evidence into the shared budget and atomically refuses work above 256", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* authenticatedHistoryFixture(false);
      const { db, subject, current } = fixture;
      yield* wait(fixture.audit("retained-oauth").run());
      expect(
        yield* wait(
          db
            .prepare("SELECT count(*) FROM canonical_audit_usage WHERE user_id = ?")
            .bind(subject.userId)
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(yield* wait(dailyAuditCount({ db, userId: subject.userId, current }))).toBe(1);
      yield* wait(
        applyTestMigration({
          db,
          source: new URL("../migrations/0037_oauth_shared_audit_budget.sql", import.meta.url),
        })
      );
      expect(yield* wait(dailyAuditCount({ db, userId: subject.userId, current }))).toBe(1);
      // Native fixture rows establish the threshold, including refused work and the excluded envelope.
      yield* wait(
        db.batch([
          fixture.audit("batch-envelope", "operations.executeAtomicBatch"),
          ...Array.from({ length: 254 }, (_, index) =>
            fixture.audit(
              `budget-${index}`,
              "transactions.listTransactions",
              index % 2 === 0 ? "rejected" : "accepted"
            )
          ),
        ])
      );
      expect(yield* wait(dailyAuditCount({ db, userId: subject.userId, current }))).toBe(255);
      expect((yield* fixture.read()).status).toBe(200);
      const refused = yield* fixture.read();
      expect(refused.status).toBe(429);
      expect(yield* wait(refused.json())).toMatchObject({ error: { code: "rate_limited" } });
      yield* wait(db.exec("CREATE TABLE fixture_rollback (value INTEGER)"));
      yield* wait(
        expect(
          db.batch([
            db.prepare("INSERT INTO fixture_rollback VALUES (1)"),
            fixture.audit("overflow"),
          ])
        ).rejects.toThrow("transaction_audit_limit")
      );
      expect(
        yield* wait(db.prepare("SELECT count(*) FROM fixture_rollback").first<number>("count(*)"))
      ).toBe(0);
      expect(yield* wait(dailyAuditCount({ db, userId: subject.userId, current }))).toBe(256);
      expect(
        yield* wait(
          db
            .prepare("SELECT count(*) FROM pat_audit WHERE id = 'retained-oauth'")
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

it("preserves mixed PAT and OAuth attribution, exclusions, User isolation and half-open UTC days", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* authenticatedHistoryFixture();
      const { db, subject, current } = fixture;
      const start = Math.floor(current / 86_400_000) * 86_400_000;
      yield* wait(
        db
          .prepare(
            "INSERT INTO pats (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) VALUES ('mixed-pat',?,'abcdefgh',?,'Fixture','[\"read\"]',7,?,?,?,'mixed-request')"
          )
          .bind(subject.userId, new Uint8Array(32), current, current, current + 60_000)
          .run()
      );
      const plain = {
        at: current,
        pat: Option.none<string>(),
        connection: Option.none<string>(),
        credential: Option.none<string>(),
        user: String(subject.userId),
      };
      const row = ({
        id,
        operation,
        at,
        pat,
        connection,
        credential,
        user,
      }: Readonly<{
        id: string;
        operation: string;
        at: number;
        pat: Option.Option<string>;
        connection: Option.Option<string>;
        credential: Option.Option<string>;
        user: string;
      }>): D1PreparedStatement =>
        db
          .prepare(
            "INSERT INTO pat_audit (id,user_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id) VALUES (?,?,?,'accepted',?,?,?,?)"
          )
          .bind(
            id,
            user,
            operation,
            at,
            Option.getOrNull(pat),
            Option.getOrNull(connection),
            Option.getOrNull(credential)
          );
      yield* sessionForUser({ db, index: 8, userIndex: 8 });
      const peer = "80000000-0000-4000-8000-000000000001";
      yield* wait(
        db.batch([
          fixture.audit("mixed-oauth"),
          row({
            ...plain,
            id: "mixed-pat-read",
            operation: "transactions.listTransactions",
            pat: Option.some("mixed-pat"),
          }),
          row({
            ...plain,
            id: "management",
            operation: "pats.createPAT",
            pat: Option.some("mixed-pat"),
          }),
          row({ ...plain, id: "metadata", operation: "pats.listPATs" }),
          row({ ...plain, id: "recurring", operation: "recurring.listRecurringSeries" }),
          row({ ...plain, id: "unattributed", operation: "transactions.listTransactions" }),
          row({
            ...plain,
            id: "partial-connection",
            operation: "transactions.listTransactions",
            connection: Option.some(subject.oauthConnectionId),
          }),
          row({
            ...plain,
            id: "partial-credential",
            operation: "transactions.listTransactions",
            credential: Option.some(subject.credentialId),
          }),
          fixture.audit("excluded-envelope", "operations.executeAtomicBatch"),
          row({
            ...plain,
            id: "previous-day",
            operation: "transactions.listTransactions",
            at: start - 1,
            connection: Option.some(subject.oauthConnectionId),
            credential: Option.some(subject.credentialId),
          }),
          row({
            ...plain,
            id: "next-day",
            operation: "transactions.listTransactions",
            at: start + 86_400_000,
            connection: Option.some(subject.oauthConnectionId),
            credential: Option.some(subject.credentialId),
          }),
          row({ ...plain, id: "peer-metadata", operation: "pats.listPATs", user: peer }),
        ])
      );
      expect(yield* wait(dailyAuditCount({ db, userId: subject.userId, current }))).toBe(4);
      expect(yield* wait(dailyAuditCount({ db, userId: subject.userId, current: start - 1 }))).toBe(
        1
      );
      expect(
        yield* wait(dailyAuditCount({ db, userId: subject.userId, current: start + 86_400_000 }))
      ).toBe(1);
      expect(yield* wait(dailyAuditCount({ db, userId: peer, current }))).toBe(1);
      expect(
        yield* wait(
          db
            .prepare(
              "SELECT count(*) FROM canonical_audit_usage WHERE user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?"
            )
            .bind(subject.userId, start, start + 86_400_000)
            .first<number>("count(*)")
        )
      ).toBe(4);
    })
  ));

it("keeps the OAuth history caller scope open until its started native query and Audit batch settles", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* authenticatedHistoryFixture();
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let batches = 0;
      const held = new Proxy(fixture.db, {
        get: (target, key): unknown => {
          if (key === "batch") {
            return (statements: D1PreparedStatement[]) => {
              batches += 1;
              const started = target.batch(statements);
              ready.resolve();
              return started.then((results) => release.promise.then(() => results));
            };
          }
          const value: unknown = Reflect.get(target, key);
          return Predicate.isFunction(value) ? value.bind(target) : value;
        },
      });
      yield* Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const child = yield* fixture
          .read(held)
          .pipe(Effect.ensuring(Deferred.succeed(closed, undefined)), Effect.forkScoped);
        yield* wait(ready.promise);
        const interruption = yield* Fiber.interrupt(child).pipe(
          Effect.andThen(Deferred.succeed(interrupted, undefined)),
          Effect.forkScoped
        );
        yield* Effect.sleep("30 millis");
        expect(yield* Deferred.isDone(closed)).toBe(false);
        expect(yield* Deferred.isDone(interrupted)).toBe(false);
        release.resolve();
        yield* Fiber.join(interruption);
        const exit = yield* Fiber.await(child);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(batches).toBe(1);
        expect(
          yield* wait(
            dailyAuditCount({
              db: fixture.db,
              userId: fixture.subject.userId,
              current: fixture.current,
            })
          )
        ).toBe(1);
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())), Effect.scoped);
    })
  ));

it("resamples OAuth authority at canonical commit using the invocation Clock while preserving native expiry guards", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* authenticatedHistoryFixture();
      const expires = fixture.current + 60_000;
      yield* wait(
        fixture.db
          .prepare("UPDATE oauth_access_credentials SET expires_at_ms = ? WHERE id = ?")
          .bind(expires, fixture.subject.credentialId)
          .run()
      );
      const live = yield* Clock.Clock;
      const invoke = (clock: Clock.Clock): Effect.Effect<Response> =>
        executeCanonicalWork({
          db: fixture.db,
          subject: fixture.subject,
          current: fixture.current,
          bucket: Option.none(),
          inference: Option.none(),
          hostedFence: Option.none(),
          oauthConfirmation: Option.none(),
          work: {
            _tag: "Call",
            operation: CanonicalOperationId.make("transactions.createTransaction"),
            input: transactionArguments,
          },
        }).pipe(Effect.provideService(Clock.Clock, clock));
      const expired = yield* invoke(clockAt(live, expires));
      expect(expired.status).toBe(401);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          dailyAuditCount({
            db: fixture.db,
            userId: fixture.subject.userId,
            current: fixture.current,
          })
        )
      ).toBe(0);
      const healthy = yield* invoke(clockAt(live, fixture.current));
      expect(healthy.status).toBe(201);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          dailyAuditCount({
            db: fixture.db,
            userId: fixture.subject.userId,
            current: fixture.current,
          })
        )
      ).toBe(1);
    })
  ));

it("resamples OAuth authority after a native canonical abort before classifying its refusal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* authenticatedHistoryFixture();
      const expires = fixture.current + 60_000;
      yield* wait(
        fixture.db
          .prepare("UPDATE oauth_access_credentials SET expires_at_ms = ? WHERE id = ?")
          .bind(expires, fixture.subject.credentialId)
          .run()
      );
      yield* wait(
        fixture.db.exec(
          "CREATE TRIGGER fixture_commit_abort BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'fixture_commit_abort'); END"
        )
      );
      let instant = fixture.current;
      let batches = 0;
      const aborted = new Proxy(fixture.db, {
        get: (target, key): unknown => {
          if (key === "batch") {
            return (statements: D1PreparedStatement[]) => {
              batches += 1;
              return target.batch(statements).catch((cause: unknown) => {
                instant = expires;
                throw cause;
              });
            };
          }
          const value: unknown = Reflect.get(target, key);
          return Predicate.isFunction(value) ? value.bind(target) : value;
        },
      });
      const live = yield* Clock.Clock;
      const clock = clockAt(live, fixture.current, () => instant);
      const response = yield* executeCanonicalWork({
        db: aborted,
        subject: fixture.subject,
        current: fixture.current,
        bucket: Option.none(),
        inference: Option.none(),
        hostedFence: Option.none(),
        oauthConfirmation: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("transactions.createTransaction"),
          input: transactionArguments,
        },
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(401);
      expect(batches).toBe(1);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          dailyAuditCount({
            db: fixture.db,
            userId: fixture.subject.userId,
            current: fixture.current,
          })
        )
      ).toBe(0);
    })
  ));

it("counts fully attributed OAuth reads in the shared User Audit budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const userId = yield* wait(
        fixture.db
          .prepare("SELECT user_id FROM oauth_connections WHERE id = ?")
          .bind(fixture.connectionId)
          .first<string>("user_id")
      );
      if (userId === null) throw new Error("Fixture connection missing");
      const current = yield* Clock.currentTimeMillis;
      const before = yield* wait(dailyAuditCount({ db: fixture.db, userId, current }));
      for (let index = 0; index < 3; index += 1) {
        const response = yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "transactions.listTransactions",
            args: { query: {} },
          })
        );
        expect(response.status).toBe(200);
        expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
      }
      expect(yield* wait(dailyAuditCount({ db: fixture.db, userId, current }))).toBe(before + 3);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ? AND oauth_credential_id IS NOT NULL AND pat_id IS NULL AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(3);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM canonical_audit_usage WHERE user_id = ?")
            .bind(userId)
            .first<number>("count(*)")
        )
      ).toBe(before + 3);
    })
  ));

it("creates a Transaction through the ordinary OAuth mutation with one protected Audit and no PAT accounting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "transactions.createTransaction",
          args: {
            payload: {
              money: { amount: "15000", currency: "COP" },
              direction: "outflow",
              occurredAt: "2026-10-03T12:00:00.000Z",
            },
          },
        })
      );
      const body = yield* wait(response.json());
      expect(body).toMatchObject({
        result: {
          isError: false,
          structuredContent: { data: { money: { amount: "15000", currency: "COP" } }, next: [] },
        },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ? AND operation = 'transactions.createTransaction' AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM pats").first<number>("count(*)"))
      ).toBe(0);
    })
  ));
const transactionArguments = {
  payload: {
    money: { amount: "15000", currency: "COP" },
    direction: "outflow",
    occurredAt: "2026-10-03T12:00:00.000Z",
  },
};
const transactionChildren = [
  {
    callId: "20000000-0000-4000-8000-000000000001",
    operation: "transactions.createTransaction",
    input: transactionArguments,
  },
  {
    callId: "20000000-0000-4000-8000-000000000002",
    operation: "transactions.createTransaction",
    input: transactionArguments,
  },
] as const;
it("commits an authorized OAuth atomic batch with exact correlated results and one Audit per child", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: { payload: { calls: transactionChildren } },
        })
      );
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            isError: Schema.Boolean,
            structuredContent: Schema.Json,
            content: Schema.Array(
              Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
            ),
          }),
        })
      )(yield* wait(response.json()));
      expect(result.result.isError).toBe(false);
      expect(result.result.structuredContent).toMatchObject({
        data: {
          results: transactionChildren.map(({ callId, operation }) => ({
            callId,
            operation,
            output: { data: { money: { amount: "15000", currency: "COP" } }, next: [] },
          })),
        },
        next: [],
      });
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
          result.result.content[0]?.text ?? "null"
        )
      ).toEqual(result.result.structuredContent);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ? AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(2);
    })
  ));
it("preserves the canonical owner's invalid ordinary OAuth mutation refusal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "transactions.createTransaction",
          args: { payload: { money: { amount: "-1", currency: "COP" } } },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            error: { code: "validation_failed", message: "Invalid Transaction input." },
            next: [],
          },
        },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT operation, outcome FROM pat_audit").all())
      ).toMatchObject({
        results: [{ operation: "transactions.createTransaction", outcome: "rejected" }],
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

const assertAttributedBatchRefusal = (
  db: D1Database,
  value: unknown,
  failure: string
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    if (failure !== "invalid" && failure !== "sensitive") return;
    const operation =
      failure === "invalid" ? "transactions.createTransaction" : "budgets.deleteBudget";
    expect(value).toMatchObject({
      result: {
        structuredContent: {
          error: {
            code: failure === "invalid" ? "validation_failed" : "user_action_required",
            failedCallIndex: 1,
            operation,
          },
        },
      },
    });
    expect(yield* wait(db.prepare("SELECT operation, outcome FROM pat_audit").all())).toMatchObject(
      { results: [{ operation, outcome: "rejected" }] }
    );
  });

it.each(["invalid", "collision", "owner-collision", "hidden", "sensitive", "audit"])(
  "refuses an OAuth batch with %s work without partial domain effects or successful accounting",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const scopes = failure === "owner-collision" ? ["write", "dashboard"] : ["write"];
        const fixture = yield* approvedFixture(scopes);
        const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        let second: Schema.Json = transactionChildren[1];
        if (failure === "invalid") {
          second = {
            ...transactionChildren[1],
            input: { payload: { money: { amount: "-1", currency: "COP" } } },
          };
        }
        if (failure === "collision") {
          second = { ...transactionChildren[1], callId: transactionChildren[0].callId };
        }
        if (failure === "hidden") {
          second = {
            ...transactionChildren[1],
            operation: "dashboard.initializeDashboard",
            input: {},
          };
        }
        if (failure === "sensitive") {
          second = {
            ...transactionChildren[1],
            operation: "budgets.deleteBudget",
            input: { params: { id: "30000000-0000-4000-8000-000000000001" } },
          };
        }
        if (failure === "audit") {
          yield* wait(
            fixture.db
              .prepare(
                "CREATE TRIGGER skip_oauth_mutation_audit BEFORE INSERT ON pat_audit WHEN NEW.outcome = 'accepted' BEGIN SELECT RAISE(IGNORE); END"
              )
              .run()
          );
        }
        const response = yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "operations.executeAtomicBatch",
            args: {
              payload: {
                calls:
                  failure === "owner-collision"
                    ? transactionChildren.map((child) => ({
                        ...child,
                        operation: "dashboard.initializeDashboard",
                        input: {},
                      }))
                    : [transactionChildren[0], second],
              },
            },
          })
        );
        const value = yield* wait(response.json());
        expect(value).toMatchObject({
          result: { isError: true, structuredContent: { next: [] } },
        });
        yield* assertAttributedBatchRefusal(fixture.db, value, failure);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM dashboard_documents").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM pat_audit WHERE outcome = 'accepted'")
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);
it.each(["empty", "oversized", "unattributed"])(
  "keeps %s OAuth batch failures at the canonical envelope boundary",
  (shape) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture(["write"]);
        const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        let calls: ReadonlyArray<Schema.Json> = [];
        if (shape === "oversized") calls = Array.from({ length: 13 }, () => transactionChildren[0]);
        if (shape === "unattributed") calls = [{}];
        const response = yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "operations.executeAtomicBatch",
            args: { payload: { calls } },
          })
        );
        const value = yield* wait(response.json());
        expect(value).toMatchObject({
          result: {
            isError: true,
            structuredContent: { error: { code: "validation_failed" }, next: [] },
          },
        });
        expect(
          yield* wait(fixture.db.prepare("SELECT operation, outcome FROM pat_audit").all())
        ).toMatchObject({
          results: [{ operation: "operations.executeAtomicBatch", outcome: "rejected" }],
        });
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);
it("rejects read-only and cross-User mutation admissions at the authoritative coordinator without domain effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const admitted = yield* authenticateOAuth({
        db: fixture.db,
        current: yield* Clock.currentTimeMillis,
        request: new Request("https://api.fidyapp.com/mcp", {
          headers: { authorization: `Bearer ${token.access_token}` },
        }),
      });
      if (Option.isNone(admitted)) return yield* Effect.die("Expected live fixture authority");
      const caller = admitted.value.subject;
      const admission = yield* Schema.encodeEffect(OAuthCanonicalAdmission)({
        userId: caller.userId,
        connectionId: caller.oauthConnectionId,
        credentialId: caller.credentialId,
        clientId: caller.clientId,
        resource: caller.resource,
        digest: Array.from(caller.digest),
        deadlineMilliseconds: (yield* Clock.currentTimeMillis) + 5000,
        operation: CanonicalOperationId.make("transactions.createTransaction"),
        input: transactionArguments,
      });
      const denied = yield* wait(fixture.coordinate(caller.userId, admission));
      expect(denied.status).toBe(403);
      expect(yield* wait(denied.json())).toMatchObject({ error: { code: "scope_missing" } });
      const peer = "10000000-0000-4000-8000-000000000002";
      expect((yield* wait(fixture.coordinate(peer, admission))).status).toBe(503);
      expect((yield* wait(fixture.coordinate(peer, { ...admission, userId: peer }))).status).toBe(
        401
      );
      const batch = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: { payload: { calls: transactionChildren } },
        })
      );
      expect(yield* wait(batch.json())).toMatchObject({
        result: { isError: true, structuredContent: { error: { code: "scope_missing" } } },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE outcome = 'accepted'")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("settles concurrent OAuth batches once per child and never retries ambiguous mutation delivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      fixture.interceptQueryResponse(() =>
        Promise.resolve(new Response("undecodable-delivery", { status: 200 }))
      );
      const responses = yield* wait(
        Promise.all(
          [1, 2].map(() =>
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "operations.executeAtomicBatch",
              args: { payload: { calls: transactionChildren } },
            })
          )
        )
      );
      for (const response of responses) {
        expect(yield* wait(response.json())).toMatchObject({
          result: {
            isError: true,
            structuredContent: { error: { code: "unavailable" }, next: [] },
          },
        });
      }
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(4);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE outcome = 'accepted' AND oauth_connection_id = ?"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(4);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM canonical_request_leases")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("keeps Memory and Dashboard owner construction independent of read scope and refuses unverified sensitive effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write", "dashboard"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                {
                  callId: "20000000-0000-4000-8000-000000000001",
                  operation: "memory.remember",
                  input: { payload: { text: "I plan my monthly spending in COP." } },
                },
                {
                  callId: "20000000-0000-4000-8000-000000000002",
                  operation: "dashboard.initializeDashboard",
                  input: {},
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
      const memoryId = yield* wait(
        fixture.db.prepare("SELECT id FROM memories").first<string>("id")
      );
      expect(memoryId).not.toBeNull();
      const refused = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "memory.forget",
          args: { params: { id: memoryId ?? "" } },
        })
      );
      expect(yield* wait(refused.json())).toMatchObject({
        result: { isError: true, structuredContent: { error: { code: "user_action_required" } } },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM memories").first<number>("count(*)"))
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM dashboard_documents").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE outcome = 'accepted' AND oauth_connection_id = ?"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(2);
    })
  ));
it("fails Memory batches closed when owner inference construction is unavailable without denying unrelated mutations", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      fixture.disableInference();
      const response = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                transactionChildren[0],
                {
                  ...transactionChildren[1],
                  operation: "memory.remember",
                  input: { payload: { text: "I plan monthly spending." } },
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: { isError: true, structuredContent: { error: { code: "unavailable" } } },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM memories").first<number>("count(*)"))
      ).toBe(0);
      const sensitive = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                transactionChildren[0],
                {
                  ...transactionChildren[1],
                  operation: "memory.forget",
                  input: { params: { id: "30000000-0000-4000-8000-000000000001" } },
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(sensitive.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            error: { code: "user_action_required", failedCallIndex: 1, operation: "memory.forget" },
          },
        },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT operation, outcome FROM pat_audit").all())
      ).toMatchObject({ results: [{ operation: "memory.forget", outcome: "rejected" }] });
      const ordinary = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "transactions.createTransaction",
          args: transactionArguments,
        })
      );
      expect(yield* wait(ordinary.json())).toMatchObject({ result: { isError: false } });
    })
  ));
it("reports interruption after a committed OAuth mutation without undoing or retrying its protected effects", () => {
  const controller = new AbortController();
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const committed = Promise.withResolvers<void>();
      fixture.interceptQueryResponse(() => {
        committed.resolve();
        controller.abort();
        return Promise.resolve(new Response("interrupted-delivery", { status: 200 }));
      });
      yield* wait(
        expect(
          mcpFixture({
            send: (path, init) => fixture.send(path, { ...init, signal: controller.signal }),
            bearer: token.access_token,
            method: "tools/call",
            name: "transactions.createTransaction",
            args: transactionArguments,
          })
        ).rejects.toThrow("All fibers interrupted without error")
      );
      yield* wait(committed.promise);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE outcome = 'accepted' AND oauth_connection_id = ?"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM canonical_request_leases")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  );
});
it("shares bounded mutation concurrency across OAuth credentials for the same User before scheduling another coordinator unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let admitted = 0;
      fixture.interceptQueryResponse(({ response }) => {
        admitted += 1;
        if (admitted === 2) ready.resolve();
        return release.promise.then(() => response);
      });
      const invoke = (bearer: string): Promise<Response> =>
        mcpFixture({
          send: fixture.send,
          bearer,
          method: "tools/call",
          name: "transactions.createTransaction",
          args: transactionArguments,
        });
      const pending = [invoke(token.access_token), invoke(rotated.access_token)];
      yield* wait(ready.promise);
      const denied = yield* wait(invoke(rotated.access_token));
      expect(yield* wait(denied.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "rate_limited", retryAfterSeconds: 1 } },
        },
      });
      expect(admitted).toBe(2);
      release.resolve();
      for (const response of yield* wait(Promise.all(pending))) {
        expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
      }
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM canonical_request_leases")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("reuses Category and Budget owner behavior in one OAuth mutation unit with exact Money and independent accounting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                {
                  ...transactionChildren[0],
                  operation: "categories.createKeywordRule",
                  input: { payload: { keyword: "Lunch", categoryId: categoryIds.restaurantes } },
                },
                {
                  ...transactionChildren[1],
                  operation: "budgets.createBudget",
                  input: {
                    payload: {
                      categoryId: categoryIds.restaurantes,
                      cap: { amount: "9007199254740993", currency: "COP" },
                    },
                  },
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: {
          isError: false,
          structuredContent: {
            data: {
              results: [
                { operation: "categories.createKeywordRule" },
                {
                  operation: "budgets.createBudget",
                  output: { data: { cap: { amount: "9007199254740993", currency: "COP" } } },
                },
              ],
            },
          },
        },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM keyword_rules").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ? AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(2);
    })
  ));
it("refuses a foreign Transaction child after preparing an owned child without committing either transition", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const created = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({
              data: Schema.Struct({ id: Schema.String, categoryId: Schema.String }),
            }),
          }),
        })
      )(
        yield* wait(
          (yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "transactions.createTransaction",
              args: transactionArguments,
            })
          )).json()
        )
      );
      yield* sessionFor({ db: fixture.db, index: 2 });
      const foreignId = "30000000-0000-4000-8000-000000000001";
      const current = DateTime.formatIso(yield* DateTime.now);
      yield* wait(
        fixture.db
          .prepare(
            "INSERT INTO transactions (id,user_id,amount,currency,direction,category_id,occurred_at,created_at) VALUES (?,?,'15000','COP','outflow',?,?,?)"
          )
          .bind(
            foreignId,
            "20000000-0000-4000-8000-000000000001",
            created.result.structuredContent.data.categoryId,
            current,
            current
          )
          .run()
      );
      const response = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                transactionChildren[0],
                {
                  ...transactionChildren[1],
                  operation: "transactions.linkTransactions",
                  input: {
                    payload: {
                      firstTransactionId: created.result.structuredContent.data.id,
                      secondTransactionId: foreignId,
                    },
                  },
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            error: {
              code: "not_found",
              failedCallIndex: 1,
              operation: "transactions.linkTransactions",
            },
            next: [],
          },
        },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM transaction_reconciliation_members")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ? AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));
it("links and unlinks exact owned Transactions through ordinary OAuth mutations without deleting originals or repeating accounting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const created = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({
              data: Schema.Struct({
                results: Schema.Tuple([
                  Schema.Struct({
                    output: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
                  }),
                  Schema.Struct({
                    output: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
                  }),
                ]),
              }),
            }),
          }),
        })
      )(
        yield* wait(
          (yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "operations.executeAtomicBatch",
              args: { payload: { calls: transactionChildren } },
            })
          )).json()
        )
      );
      const [first, second] = created.result.structuredContent.data.results;
      const args = {
        payload: {
          firstTransactionId: first.output.data.id,
          secondTransactionId: second.output.data.id,
        },
      };
      for (const name of ["transactions.linkTransactions", "transactions.unlinkTransactions"]) {
        const response = yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name,
            args,
          })
        );
        expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM transaction_reconciliation_members")
              .first<number>("count(*)")
          )
        ).toBe(name === "transactions.linkTransactions" ? 2 : 0);
      }
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ? AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(4);
    })
  ));
it.each(["single", "mixed"])(
  "rechecks credential expiration when an OAuth %s unit is prepared but its native commit has not executed",
  (unit) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture(["write", "dashboard"]);
        const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        const held = fixture.holdMutationCommit();
        const pending =
          unit === "single"
            ? mcpFixture({
                send: fixture.send,
                bearer: token.access_token,
                method: "tools/call",
                name: "transactions.createTransaction",
                args: transactionArguments,
              })
            : mcpFixture({
                send: fixture.send,
                bearer: token.access_token,
                method: "tools/call",
                name: "operations.executeAtomicBatch",
                args: {
                  payload: {
                    calls: [
                      transactionChildren[0],
                      {
                        ...transactionChildren[1],
                        operation: "dashboard.initializeDashboard",
                        input: {},
                      },
                    ],
                  },
                },
              });
        yield* wait(held.waiting);
        const expiresAt = (yield* Clock.currentTimeMillis) + 20;
        yield* wait(
          fixture.db
            .prepare("UPDATE oauth_access_credentials SET expires_at_ms = ?")
            .bind(expiresAt)
            .run()
        );
        yield* Effect.sleep("30 millis");
        held.release();
        const response = yield* wait(pending);
        expect(yield* wait(response.json())).toMatchObject({ result: { isError: true } });
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM dashboard_documents").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM pat_audit WHERE outcome = 'accepted'")
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);
it.each(["single", "mixed"])(
  "rechecks a prepared OAuth %s unit after grant revocation, Consent withdrawal and child-scope narrowing",
  (unit) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const withdrawn of ["grant", "consent", "scope"]) {
          const fixture = yield* approvedFixture(["write", "dashboard"]);
          const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
            yield* wait((yield* wait(exchangeFixture(fixture))).json())
          );
          const held = fixture.holdMutationCommit();
          const calls = [
            transactionChildren[0],
            { ...transactionChildren[1], operation: "dashboard.initializeDashboard", input: {} },
          ];
          const pending =
            unit === "single"
              ? mcpFixture({
                  send: fixture.send,
                  bearer: token.access_token,
                  method: "tools/call",
                  name: "transactions.createTransaction",
                  args: transactionArguments,
                })
              : mcpFixture({
                  send: fixture.send,
                  bearer: token.access_token,
                  method: "tools/call",
                  name: "operations.executeAtomicBatch",
                  args: { payload: { calls } },
                });
          yield* wait(held.waiting);
          if (withdrawn === "grant") {
            yield* wait(
              fixture.db
                .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
                .bind(yield* Clock.currentTimeMillis, fixture.connectionId)
                .run()
            );
          }
          if (withdrawn === "consent") yield* revokeFixtureConsent(fixture.db);
          if (withdrawn === "scope") {
            yield* wait(
              fixture.db
                .prepare("UPDATE oauth_access_credentials SET scopes_json = ?")
                .bind(unit === "single" ? '["dashboard"]' : '["write"]')
                .run()
            );
          }
          held.release();
          const response = yield* wait(pending);
          yield* wait(held.settled);
          expect(yield* wait(response.json()), `${unit}: ${withdrawn}`).toMatchObject({
            result: { isError: true },
          });
          for (const table of ["transactions", "source_attestations", "dashboard_documents"]) {
            expect(
              yield* wait(
                fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")
              ),
              table
            ).toBe(0);
          }
          expect(
            yield* wait(
              fixture.db
                .prepare("SELECT count(*) FROM pat_audit WHERE outcome = 'accepted'")
                .first<number>("count(*)")
            )
          ).toBe(0);
        }
      })
    )
);
it("rechecks immutable OAuth grant expiration at the protected mixed-batch commit even with an unexpired credential", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const expiresAt = (yield* Clock.currentTimeMillis) + 5000;
      const approvalClock = vi
        .spyOn(Date, "now")
        .mockReturnValue(expiresAt - 7 * 24 * 60 * 60 * 1000);
      const fixture = yield* approvedFixture(["write", "dashboard"]);
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      approvalClock.mockRestore();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      // Retained credentials are untrusted authority facts: a longer credential cannot extend its grant.
      yield* wait(
        fixture.db
          .prepare("UPDATE oauth_access_credentials SET expires_at_ms = ?")
          .bind(expiresAt + 60000)
          .run()
      );
      const held = fixture.holdMutationCommit();
      const pending = mcpFixture({
        send: fixture.send,
        bearer: token.access_token,
        method: "tools/call",
        name: "operations.executeAtomicBatch",
        args: {
          payload: {
            calls: [
              transactionChildren[0],
              { ...transactionChildren[1], operation: "dashboard.initializeDashboard", input: {} },
            ],
          },
        },
      });
      yield* wait(held.waiting);
      yield* Effect.sleep(Math.max(0, expiresAt - (yield* Clock.currentTimeMillis)) + 20);
      held.release();
      const response = yield* wait(pending);
      yield* wait(held.settled);
      expect(yield* wait(response.json())).toMatchObject({ result: { isError: true } });
      for (const table of ["transactions", "source_attestations", "dashboard_documents"]) {
        expect(
          yield* wait(
            fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")
          ),
          table
        ).toBe(0);
      }
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE outcome = 'accepted'")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("lists distinct owned agent connections with canonical activity and no credential material", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const second = yield* approveAgain(fixture);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      for (let call = 0; call < 5; call++) {
        yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        );
      }
      const other = yield* sessionFor({ db: fixture.db, index: 2 });
      const listed = yield* wait(
        fixture.send("/web/oauth/connections", { headers: fixture.headers })
      );
      expect(listed.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(Schema.Json)(yield* wait(listed.json()));
      expect(body).toMatchObject({
        connections: [
          { claimedClientName: "<img src=x onerror=alert(1)>", scopes: ["read"], state: "active" },
          { claimedClientName: "<img src=x onerror=alert(1)>", scopes: ["read"], state: "active" },
        ],
      });
      const activity = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          connections: Schema.Array(Schema.Struct({ recentActivity: Schema.Array(Schema.Json) })),
        })
      )(body);
      expect(
        activity.connections
          .map((item) => item.recentActivity.length)
          .sort((left, right) => left - right)
      ).toEqual([0, 3]);
      const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(body);
      expect(text).toContain(fixture.connectionId);
      expect(text).toContain(second.connectionId);
      expect(text).toContain("categories.listCategories");
      expect(text).not.toContain(token.access_token);
      expect(text).not.toContain(token.refresh_token);
      expect(text).not.toContain("digest");
      const isolated = yield* wait(
        fixture.send("/web/oauth/connections", { headers: { ...fixture.headers, cookie: other } })
      );
      expect(yield* wait(isolated.json())).toEqual({ connections: [], nextCursor: null });
      expect(listed.headers.get("cache-control")).toBe("no-store");
    })
  ));
it("revokes one agent atomically across restart without revoking another connection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const second = yield* approveAgain(fixture);
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const other = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: second.body }))).json())
      );
      const discovered = yield* wait(
        mcpFixture({ send: fixture.send, bearer: original.access_token, method: "tools/list" })
      );
      expect(yield* wait(discovered.text())).toContain("categories.listCategories");
      const revoked = yield* wait(
        fixture.send("/web/oauth/revoke", {
          method: "POST",
          headers: fixture.headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            connectionId: fixture.connectionId,
          }),
        })
      );
      expect(revoked.status).toBe(200);
      expect(yield* wait(revoked.json())).toEqual({ revoked: true });
      fixture.restartCoordinators();
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: original.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(401);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: other.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(200);
      const evidence = yield* wait(
        fixture.db
          .prepare("SELECT connection_id,reason,session_id FROM oauth_user_revocation_consents")
          .all()
      );
      expect(evidence.results).toEqual([
        {
          connection_id: fixture.connectionId,
          reason: "user_one",
          session_id: "10000000-0000-4000-8000-000000000003",
        },
      ]);
      expect(
        Option.isNone(
          yield* Effect.option(
            wait(
              fixture.db
                .prepare("UPDATE oauth_user_revocation_consents SET reason = 'user_all'")
                .run()
            )
          )
        )
      ).toBe(true);
      expect(
        Option.isNone(
          yield* Effect.option(
            wait(fixture.db.prepare("DELETE FROM oauth_user_revocation_consents").run())
          )
        )
      ).toBe(true);
    })
  ));
it.each(["wrong-user", "forged-session", "stale-session", "csrf", "oauth-bearer"] as const)(
  "refuses %s browser revocation without exposing or changing the owned connection",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        const headers = { ...fixture.headers };
        if (kind === "wrong-user") headers.cookie = yield* sessionFor({ db: fixture.db, index: 2 });
        if (kind === "forged-session" || kind === "oauth-bearer") {
          headers.cookie = "__Host-fidy_session=forged";
        }
        if (kind === "csrf") headers.origin = "https://evil.example";
        if (kind === "stale-session") {
          const now = yield* Clock.currentTimeMillis;
          yield* wait(
            fixture.db
              .prepare(
                "UPDATE web_sessions SET created_at_ms = ?, fresh_until_ms = ?, hard_expires_at_ms = ?"
              )
              .bind(now - 600001, now - 1, now - 600001 + 7776000000)
              .run()
          );
        }
        const response = yield* wait(
          fixture.send("/web/oauth/revoke", {
            method: "POST",
            headers: {
              ...headers,
              ...(kind === "oauth-bearer" ? { authorization: `Bearer ${token.access_token}` } : {}),
            },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
              connectionId: fixture.connectionId,
            }),
          })
        );
        const statuses = {
          "wrong-user": 400,
          csrf: 403,
          "forged-session": 401,
          "stale-session": 401,
          "oauth-bearer": 401,
        };
        expect(response.status).toBe(statuses[kind]);
        expect(yield* wait(response.text())).not.toContain(fixture.connectionId);
        expect(
          (yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "categories.listCategories",
              args: {},
            })
          )).status
        ).toBe(200);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);
it("revokes all owned agents while a refresh is queued, leaving another User and committed canonical evidence intact", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const second = yield* approveAgain(fixture);
      const otherCookie = yield* sessionFor({ db: fixture.db, index: 2 });
      yield* wait(
        fixture.db
          .prepare(
            "INSERT INTO onboarding_consent_records VALUES ('other-grant-test', ?, '{}', 'disclosure', 'decision', 1, 1)"
          )
          .bind("20000000-0000-4000-8000-000000000001")
          .run()
      );
      const other = yield* approveAgain({
        ...fixture,
        headers: { ...fixture.headers, cookie: otherCookie },
      });
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const secondToken = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: second.body }))).json())
      );
      const otherToken = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: other.body }))).json())
      );
      yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: original.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      const gate = fixture.holdRefresh();
      const queued = refreshFixture({
        ...fixture,
        refresh: original.refresh_token,
        scope: Option.none(),
      });
      yield* wait(gate.waiting);
      const revoked = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(revoked.status).toBe(200);
      gate.release();
      expect((yield* wait(queued)).status).toBe(400);
      fixture.restartCoordinators();
      for (const token of [original, secondToken]) {
        expect(
          (yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "categories.listCategories",
              args: {},
            })
          )).status
        ).toBe(401);
        expect(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
          )).status
        ).toBe(400);
      }
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: otherToken.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(200);
      expect(
        yield* makeAudit({ database: fixture.db }).query({
          userId: "10000000-0000-4000-8000-000000000001",
          limit: 10,
        })
      ).toHaveLength(1);
      const repeated = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(repeated.status).toBe(200);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(2);
    })
  ));
it("does not revoke any agent when append-only revocation evidence is unavailable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const second = yield* approveAgain(fixture);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      yield* wait(
        fixture.db
          .prepare(
            `CREATE TRIGGER reject_oauth_evidence BEFORE INSERT ON oauth_user_revocation_consents WHEN NEW.connection_id = '${second.connectionId}' BEGIN SELECT RAISE(ABORT,'unavailable'); END`
          )
          .run()
      );
      const response = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(response.status).toBe(503);
      expect(yield* wait(response.json())).toEqual({ error: "temporarily_unavailable" });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_connections WHERE revoked_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
        )).status
      ).toBe(200);
    })
  ));
it("keeps corrupt retained OAuth review and connection dates in the typed failure channel", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reviewed = yield* reviewedFixture();
      const choice = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthReviewChoice))(
        reviewed.choice
      );
      yield* wait(
        reviewed.db
          .prepare("UPDATE oauth_review_requests SET created_at_ms=?,expires_at_ms=? WHERE id=?")
          .bind(8_640_000_000_000_001 - 600_000, 8_640_000_000_000_001, choice.requestId)
          .run()
      );
      const typedCorruption = new BootstrapUnavailable();
      deepStrictEqual(
        yield* Effect.exit(
          reviewRequest({
            db: reviewed.db,
            request: new Request(
              `https://api.fidyapp.com/web/oauth/review?requestId=${choice.requestId}`,
              { headers: reviewed.headers }
            ),
            browserOrigin: "https://app.fidyapp.com",
            current: DateTime.nowUnsafe().epochMilliseconds,
            admitUser: () => Effect.void,
          })
        ),
        Exit.fail(typedCorruption)
      );
      expect(
        (yield* wait(
          reviewed.send(`/web/oauth/review?requestId=${choice.requestId}`, {
            headers: reviewed.headers,
          })
        )).status
      ).toBe(503);
      expect(
        (yield* wait(reviewed.db.prepare("SELECT id FROM oauth_connections").all())).results
      ).toEqual([]);
      const approved = yield* approvedFixture();
      // Inject retained corruption without changing the production grant immutability fence.
      yield* wait(approved.db.exec("DROP TRIGGER oauth_connection_immutable"));
      for (const dates of [
        { expiry: -8_640_000_000_000_001, revokedAt: null },
        { expiry: 8_640_000_000_000_001, revokedAt: null },
        {
          expiry: DateTime.add(DateTime.nowUnsafe(), { days: 7 }).epochMilliseconds,
          revokedAt: 8_640_000_000_000_001,
        },
      ]) {
        yield* wait(
          approved.db
            .prepare(
              "UPDATE oauth_connections SET approved_at_ms=?,expires_at_ms=?,revoked_at_ms=? WHERE id=?"
            )
            .bind(dates.expiry - 1, dates.expiry, dates.revokedAt, approved.connectionId)
            .run()
        );
        deepStrictEqual(
          yield* Effect.exit(
            manageConnections({
              db: approved.db,
              request: new Request("https://api.fidyapp.com/web/oauth/connections", {
                headers: approved.headers,
              }),
              browserOrigin: "https://app.fidyapp.com",
              current: DateTime.nowUnsafe().epochMilliseconds,
              admitUser: () => Effect.void,
              coordinator: {
                getByName: () => {
                  throw new Error("Connection listing must not revoke work");
                },
              },
            })
          ),
          Exit.fail(typedCorruption)
        );
        expect(
          (yield* wait(approved.send("/web/oauth/connections", { headers: approved.headers })))
            .status
        ).toBe(503);
      }
    })
  ));

it("reports malformed connection metadata and unavailable canonical activity rather than a false empty list", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      yield* wait(fixture.db.prepare("DROP TRIGGER oauth_connection_immutable").run());
      yield* wait(fixture.db.prepare("UPDATE oauth_connections SET scopes_json = '[]'").run());
      expect(
        (yield* wait(fixture.send("/web/oauth/connections", { headers: fixture.headers }))).status
      ).toBe(503);
      yield* wait(
        fixture.db.prepare("UPDATE oauth_connections SET scopes_json = '[\"read\"]'").run()
      );
      yield* wait(fixture.db.prepare("ALTER TABLE pat_audit RENAME TO unavailable_audit").run());
      expect(
        (yield* wait(fixture.send("/web/oauth/connections", { headers: fixture.headers }))).status
      ).toBe(503);
    })
  ));
it("keeps OAuth revocation, PAT-wide revocation, Hosted Agent Sessions and browser logout independent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const current = yield* Clock.currentTimeMillis;
      const issued = yield* wait(
        fixture.send("/pats", {
          method: "POST",
          headers: fixture.headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            requestId: "10000000-0000-4000-8000-000000000005",
            grant: {
              recipientLabel: "Agente directo",
              scopes: ["read"],
              lifetimeDays: 7,
              reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(current + 604800000)),
            },
          }),
        })
      );
      expect(issued.status).toBe(200);
      const pat = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Struct({ bearer: Schema.String }) })
      )(yield* wait(issued.json()));
      yield* wait(
        fixture.db
          .prepare(
            "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status) VALUES ('10000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000001','{}',?,'active')"
          )
          .bind(current)
          .run()
      );
      const revoked = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(revoked.status).toBe(200);
      expect(
        (yield* wait(
          fixture.send("/categories", { headers: { authorization: `Bearer ${pat.data.bearer}` } })
        )).status
      ).toBe(200);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT status FROM hosted_agent_sessions").first<string>("status")
        )
      ).toBe("active");
      const replacement = yield* approveAgain(fixture);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: replacement.body }))).json())
      );
      expect(
        (yield* wait(fixture.send("/pats", { method: "DELETE", headers: fixture.headers }))).status
      ).toBe(200);
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(200);
      expect(
        (yield* wait(
          fixture.send("/web/session/logout", { method: "POST", headers: fixture.headers })
        )).status
      ).toBe(204);
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(200);
      expect(
        (yield* wait(
          refreshFixture({
            ...fixture,
            body: replacement.body,
            refresh: token.refresh_token,
            scope: Option.none(),
          })
        )).status
      ).toBe(200);
    })
  ));
it("rechecks queued browser revocation subject, freshness and deadline before recording any effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const current = yield* Clock.currentTimeMillis;
      const admission = {
        userId: "10000000-0000-4000-8000-000000000001",
        sessionId: "10000000-0000-4000-8000-000000000003",
        connectionId: fixture.connectionId,
        deadlineAtMs: current + 5000,
      };
      expect(
        (yield* wait(fixture.revokeCoordinate("20000000-0000-4000-8000-000000000001", admission)))
          .status
      ).toBe(503);
      expect(
        (yield* wait(
          fixture.revokeCoordinate(admission.userId, { ...admission, deadlineAtMs: current - 1 })
        )).status
      ).toBe(503);
      yield* wait(
        fixture.db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(current, admission.sessionId)
          .run()
      );
      expect((yield* wait(fixture.revokeCoordinate(admission.userId, admission))).status).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_connections WHERE revoked_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("pages retained connections and refuses oversized revoke-all atomically rather than publishing a partial success", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      yield* wait(
        fixture.db.batch([
          fixture.db
            .prepare(`WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM copies WHERE n < 1024)
      INSERT INTO oauth_connections(id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms,refresh_allowed)
      SELECT '30000000-0000-4000-8000-' || printf('%012d',n),'copy-' || n,g.user_id,g.client_id,g.claimed_client_name,g.redirect_uri,g.resource,g.scopes_json,g.approved_at_ms,g.expires_at_ms,g.refresh_allowed FROM copies,oauth_connections g WHERE g.id = ?`)
            .bind(fixture.connectionId),
          fixture.db
            .prepare(`INSERT INTO oauth_grant_consents(id,connection_id,user_id,session_id,disclosure_revision,disclosure_text,accepted_at_ms)
      SELECT 'copy-' || g.id,g.id,g.user_id,c.session_id,c.disclosure_revision,c.disclosure_text,c.accepted_at_ms FROM oauth_connections g,oauth_grant_consents c WHERE c.connection_id = ? AND g.id != ?`)
            .bind(fixture.connectionId, fixture.connectionId),
        ])
      );
      const Page = Schema.Struct({
        connections: Schema.Array(Schema.Struct({ connectionId: Schema.String })),
        nextCursor: Schema.OptionFromNullOr(Schema.String),
      });
      const first = yield* Schema.decodeUnknownEffect(Page)(
        yield* wait(
          (yield* wait(fixture.send("/web/oauth/connections", { headers: fixture.headers }))).json()
        )
      );
      expect(first.connections).toHaveLength(25);
      expect(Option.isSome(first.nextCursor)).toBe(true);
      const second = yield* Schema.decodeUnknownEffect(Page)(
        yield* wait(
          (yield* wait(
            fixture.send(
              `/web/oauth/connections?after=${Option.getOrElse(first.nextCursor, () => "")}`,
              { headers: fixture.headers }
            )
          )).json()
        )
      );
      expect(second.connections).toHaveLength(25);
      expect(
        new Set([...first.connections, ...second.connections].map((item) => item.connectionId)).size
      ).toBe(50);
      const refusal = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(refusal.status).toBe(503);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_connections WHERE revoked_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
const TokenFixture = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Int,
  scope: Schema.String,
});
const refreshFixture = (
  input: Readonly<{
    send: Harness["send"];
    body: URLSearchParams;
    refresh: string;
    scope: Option.Option<string>;
  }>
): Promise<Response> =>
  exchangeFixture({
    send: input.send,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refresh,
      client_id: input.body.get("client_id") ?? "",
      resource: "https://api.fidyapp.com/mcp",
      ...Option.match(input.scope, { onNone: () => ({}), onSome: (scope) => ({ scope }) }),
    }),
  });
it("reconnects an expired access credential with rotated authority for the same User, client and fixed grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const expiresAt = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
          .bind(fixture.connectionId)
          .first<number>("expires_at_ms")
      );
      const accessExpiry = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_access_credentials WHERE connection_id = ?")
          .bind(fixture.connectionId)
          .first<number>("expires_at_ms")
      );
      vi.spyOn(Date, "now").mockReturnValue(accessExpiry ?? 0);
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: original.access_token, method: "tools/list" })
        )).status
      ).toBe(401);
      const response = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      expect(response.status).toBe(200);
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(response.json()));
      expect(rotated.scope).toBe("read");
      expect(rotated.expires_in).toBe(600);
      expect(rotated.refresh_token).not.toBe(original.refresh_token);
      expect(rotated.access_token).not.toBe(original.access_token);
      const queried = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: rotated.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(queried.status).toBe(200);
      expect(yield* wait(queried.text())).toContain("Restaurantes");
      const observed = yield* makeAudit({ database: fixture.db }).query({
        userId: "10000000-0000-4000-8000-000000000001",
        limit: 10,
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]?.caller).toMatchObject({
        _tag: "OAuthAgent",
        connectionId: fixture.connectionId,
      });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
            .bind(fixture.connectionId)
            .first<number>("expires_at_ms")
        )
      ).toBe(expiresAt);
      expect(response.headers.get("cache-control")).toBe("no-store");
      yield* assertReleased(fixture.db);
    })
  ));
it("treats lost token delivery as replay, revokes every generation across restart and requires a new browser grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const delivered = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(delivered.json()));
      // The host did not retain this response. There is deliberately no replacement recovery channel.
      fixture.restartCoordinators();
      const replay = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      expect(replay.status).toBe(400);
      expect(yield* wait(replay.json())).toEqual({ error: "invalid_grant" });
      for (const bearer of [original.access_token, winner.access_token]) {
        expect(
          (yield* wait(mcpFixture({ send: fixture.send, bearer, method: "tools/list" }))).status
        ).toBe(401);
      }
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: winner.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents WHERE connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      const replacement = yield* approveAgain(fixture);
      expect(replacement.connectionId).not.toBe(fixture.connectionId);
      const reconnected = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: replacement.body }))).json())
      );
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: reconnected.access_token, method: "tools/list" })
        )).status
      ).toBe(200);
      yield* assertReleased(fixture.db);
    })
  ));
it("persists replay revocation even when independent coordinator instances race the same refresh digest", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, user_id: Schema.String })
      )(
        yield* wait(fixture.db.prepare("SELECT id,user_id FROM oauth_refresh_credentials").first())
      );
      const admission = {
        deadlineAtMs: (yield* Clock.currentTimeMillis) + 5000,
        userId: row.user_id,
        connectionId: fixture.connectionId,
        credentialId: row.id,
        digest: Array.from(
          new Uint8Array(
            yield* wait(
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`oauth-refresh:${original.refresh_token}`)
              )
            )
          )
        ),
        clientId: fixture.body.get("client_id") ?? "",
        resource: "https://api.fidyapp.com/mcp",
      };
      const first = fixture.refreshCoordinate(row.user_id, admission);
      fixture.restartCoordinators();
      const responses = yield* wait(
        Promise.all([first, fixture.refreshCoordinate(row.user_id, admission)])
      );
      expect(
        responses.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 400]);
      const delivered = responses.find((response) => response.status === 200);
      if (delivered === undefined) return yield* new TestFailure({ cause: "No refresh winner" });
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(delivered.json()));
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: winner.access_token, method: "tools/list" })
        )).status
      ).toBe(401);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));
it.each(["write", "admin"])(
  "revokes recognized refresh replay before refusing the substituted %s scope",
  (scope) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        const delivered = yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        );
        const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait(delivered.json())
        );
        expect(
          (yield* wait(
            refreshFixture({
              ...fixture,
              refresh: original.refresh_token,
              scope: Option.some(scope),
            })
          )).status
        ).toBe(400);
        expect(
          (yield* wait(
            mcpFixture({ send: fixture.send, bearer: winner.access_token, method: "tools/list" })
          )).status
        ).toBe(401);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_revocation_consents")
              .first<number>("count(*)")
          )
        ).toBe(1);
      })
    )
);
it("keeps refresh admission bounded to the stable User across rotation, sources and separately approved connections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const other = yield* approveAgain(fixture);
      const otherToken = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: other.body }))).json())
      );
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      const alreadyCharged = yield* wait(
        fixture.db
          .prepare(
            "SELECT count(*) FROM resource_admission_events WHERE policy_key = 'oauth.user.v1'"
          )
          .first<number>("count(*)")
      );
      for (let index = alreadyCharged ?? 0; index < 60; index++) {
        expect(
          (yield* wait(
            refreshFixture({
              ...fixture,
              send: sendFrom(fixture.send, index + 1),
              refresh: rotated.refresh_token,
              scope: Option.some("write"),
            })
          )).status
        ).toBe(400);
      }
      const before = yield* wait(
        fixture.db
          .prepare(
            "SELECT (SELECT count(*) FROM oauth_access_credentials) AS access_count,(SELECT count(*) FROM oauth_refresh_credentials) AS refresh_count,(SELECT count(*) FROM oauth_refresh_events) AS events,(SELECT count(*) FROM oauth_revocation_consents) AS revocations,(SELECT count(*) FROM oauth_refresh_credentials WHERE consumed_at_ms IS NOT NULL) AS consumed"
          )
          .first()
      );
      for (const refresh of [rotated.refresh_token, otherToken.refresh_token]) {
        const refused = yield* wait(
          refreshFixture({
            ...fixture,
            send: sendFrom(fixture.send, 100),
            refresh,
            scope: Option.none(),
          })
        );
        expect(refused.status).not.toBe(200);
        expect(yield* wait(refused.text())).not.toContain(refresh);
      }
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT (SELECT count(*) FROM oauth_access_credentials) AS access_count,(SELECT count(*) FROM oauth_refresh_credentials) AS refresh_count,(SELECT count(*) FROM oauth_refresh_events) AS events,(SELECT count(*) FROM oauth_revocation_consents) AS revocations,(SELECT count(*) FROM oauth_refresh_credentials WHERE consumed_at_ms IS NOT NULL) AS consumed"
            )
            .first()
        )
      ).toEqual(before);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM resource_admission_events WHERE policy_key = 'oauth.user.v1'"
            )
            .first<number>("count(*)")
        )
      ).toBe(60);
      yield* assertReleased(fixture.db);
    })
  ));
it("allows one concurrent refresh winner but the recognized loser revokes its entire family", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const responses = yield* wait(
        Promise.all(
          Array.from({ length: 2 }, () =>
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )
        )
      );
      expect(
        responses.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 400]);
      const response = responses.find((value) => value.status === 200);
      if (response === undefined) return yield* new TestFailure({ cause: "No refresh winner" });
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(response.json()));
      fixture.restartCoordinators();
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: winner.access_token, method: "tools/list" })
        )).status
      ).toBe(401);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: winner.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(1);
      yield* assertReleased(fixture.db);
    })
  ));
it("uses the supplied Clock for OAuth ingress admission, issuance and outstanding lease release", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup();
      const current = 1700000000000;
      const clock = clockAt(yield* Clock.Clock, current);
      const response = yield* handleOAuthRequest({
        db: fixture.db,
        browserOrigin: "https://app.fidyapp.com",
        request: new Request("https://api.fidyapp.com/oauth/register", {
          method: "POST",
          headers: { "x-oauth-source": "a".repeat(64), "content-type": "application/json" },
          body: '{"client_name":"Agente","redirect_uris":["http://127.0.0.1/callback"]}',
        }),
        coordinator: {
          getByName: () => ({
            fetch: (): Promise<Response> =>
              Promise.reject(new Error("Registration cannot coordinate User work")),
          }),
        },
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(201);
      expect(yield* wait(response.json())).toMatchObject({ client_id_issued_at: 1700000000 });
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT admitted_at_epoch_ms,released_at_epoch_ms FROM resource_admission_events WHERE policy_key='oauth.concurrent.v1'"
            )
            .first()
        )
      ).toEqual({ admitted_at_epoch_ms: current, released_at_epoch_ms: current });
    })
  ));

it("clips refresh publication to the supplied Clock without extending absolute authority", () => {
  const signal = new AbortController().signal;
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, user_id: Schema.String })
      )(
        yield* wait(fixture.db.prepare("SELECT id,user_id FROM oauth_refresh_credentials").first())
      );
      const expiry = yield* Schema.decodeUnknownEffect(Schema.Int)(
        yield* wait(
          fixture.db.prepare("SELECT expires_at_ms FROM oauth_connections").first("expires_at_ms")
        )
      );
      const current = expiry - 1000;
      const liveClock = yield* Clock.Clock;
      const clock = clockAt(liveClock, current);
      const admission = yield* Schema.decodeUnknownEffect(OAuthRefreshAdmission)({
        credentialId: row.id,
        userId: row.user_id,
        connectionId: fixture.connectionId,
        clientId: fixture.body.get("client_id"),
        resource: "https://api.fidyapp.com/mcp",
        deadlineAtMs: expiry,
        digest: Array.from(
          new Uint8Array(
            yield* wait(
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`oauth-refresh:${token.refresh_token}`)
              )
            )
          )
        ),
      });
      const response = yield* executeOAuthRefresh({
        db: fixture.db,
        admission,
        signal,
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(200);
      expect(yield* wait(response.json())).toMatchObject({ expires_in: 1 });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT occurred_at_ms FROM oauth_refresh_events")
            .first("occurred_at_ms")
        )
      ).toBe(current);
    })
  );
});

it("inherits the supplied Clock through MCP protocol callbacks when bounding canonical admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const current = (yield* Clock.currentTimeMillis) + 120000;
      const liveClock = yield* Clock.Clock;
      const clock = clockAt(liveClock, current);
      let deadline = 0;
      const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
      const response = yield* handleMcpRequest({
        db: fixture.db,
        request: new Request("https://api.fidyapp.com/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.access_token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": "categories.listCategories",
          },
          body: yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                jsonrpc: Schema.Literal("2.0"),
                id: Schema.Int,
                method: Schema.Literal("tools/call"),
                params: Schema.Struct({
                  name: Schema.Literal("categories.listCategories"),
                  arguments: Schema.Struct({}),
                  _meta: Schema.Struct({
                    "io.modelcontextprotocol/protocolVersion": Schema.Literal("2026-07-28"),
                    "io.modelcontextprotocol/clientCapabilities": Schema.Struct({}),
                  }),
                }),
              })
            )
          )({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "categories.listCategories",
              arguments: {},
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
        coordinator: {
          getByName: (userId) => ({
            fetch: (incoming): Promise<Response> =>
              runNative(
                Effect.gen(function* () {
                  const request = incoming instanceof Request ? incoming : new Request(incoming);
                  const admission = yield* Schema.decodeUnknownEffect(OAuthCanonicalAdmission)(
                    yield* wait(request.json())
                  );
                  deadline = admission.deadlineMilliseconds;
                  const payload = yield* Schema.encodeEffect(OAuthCanonicalAdmission)(admission);
                  return yield* wait(fixture.coordinate(userId, payload));
                })
              ),
          }),
        },
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
      expect(deadline).toBe(current + 3000);
    })
  ));

it("refuses exact OAuth credential expiry under a supplied Clock without canonical Audit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const request = new Request("https://api.fidyapp.com/mcp", {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      const caller = yield* authenticateOAuth({
        db: fixture.db,
        request,
        current: yield* Clock.currentTimeMillis,
      });
      if (Option.isNone(caller)) return yield* new TestFailure({ cause: "Missing caller" });
      const current = yield* Schema.decodeUnknownEffect(Schema.Int)(
        yield* wait(
          fixture.db
            .prepare("SELECT expires_at_ms FROM oauth_access_credentials")
            .first("expires_at_ms")
        )
      );
      const liveClock = yield* Clock.Clock;
      const clock = clockAt(liveClock, current);
      const response = yield* executeOAuthCanonicalWork({
        retryKey: Option.none(),
        confirmation: Option.none(),
        bucket: Option.none(),
        inference: Option.none(),
        db: fixture.db,
        subject: caller.value.subject,
        operation: "categories.listCategories",
        input: { unexpected: true },
        signal: request.signal,
        deadlineMilliseconds: current + 3000,
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(401);
      expect(
        yield* makeAudit({ database: fixture.db }).query({
          userId: caller.value.subject.userId,
          limit: 10,
        })
      ).toEqual([]);
    })
  ));

it("fences later Promise-owned query units at the supplied Clock deadline while settling the started read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      let current = yield* Clock.currentTimeMillis;
      const request = new Request("https://api.fidyapp.com/mcp", {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      const caller = yield* authenticateOAuth({ db: fixture.db, request, current });
      if (Option.isNone(caller)) return yield* new TestFailure({ cause: "Missing caller" });
      const time = DateTime.formatIso(DateTime.makeUnsafe(current));
      yield* wait(
        fixture.db
          .prepare("INSERT INTO budgets VALUES (?, ?, ?, 'COP', '1000', ?, ?)")
          .bind(
            "30000000-0000-4000-8000-000000000001",
            caller.value.subject.userId,
            "10000000-0000-4000-8000-000000000001",
            time,
            time
          )
          .run()
      );
      const gate = fixture.holdBudgetRead();
      const deadlineMilliseconds = current + 3000;
      const live = yield* Clock.Clock;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => current,
        currentTimeMillis: Effect.sync(() => current),
        currentTimeNanosUnsafe: () => BigInt(current) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(current) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: live.monotonicTimeNanos,
        sleep: (duration) => live.sleep(duration),
      };
      const running = yield* executeOAuthCanonicalWork({
        retryKey: Option.none(),
        confirmation: Option.none(),
        bucket: Option.none(),
        inference: Option.none(),
        db: fixture.db,
        subject: caller.value.subject,
        operation: "budgets.getBudgetStatus",
        input: { query: { timeZone: "America/Bogota" } },
        signal: request.signal,
        deadlineMilliseconds,
      }).pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild);
      yield* wait(gate.waiting);
      current = deadlineMilliseconds;
      gate.release();
      expect((yield* Fiber.join(running)).status).toBe(503);
      expect(gate.scheduled()).toEqual([]);
      const audit = yield* makeAudit({ database: fixture.db }).query({
        userId: caller.value.subject.userId,
        limit: 10,
      });
      expect(audit.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
        { operation: "budgets.getBudgetStatus", outcome: "succeeded" },
      ]);
    })
  ));

const assertRefreshUnchanged = (
  fixture: Readonly<{ db: D1Database; connectionId: string }>
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    expect(
      yield* wait(
        fixture.db
          .prepare(
            "SELECT count(*) FROM oauth_refresh_credentials WHERE consumed_at_ms IS NOT NULL"
          )
          .first<number>("count(*)")
      )
    ).toBe(0);
    for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
      expect(
        yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
      ).toBe(1);
    }
    for (const table of ["oauth_refresh_events", "oauth_revocation_consents"]) {
      expect(
        yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
      ).toBe(0);
    }
  });
it("rejects unknown, wrong-purpose, wrong client/resource and escalated refresh without damaging valid authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const base = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: original.refresh_token,
        client_id: fixture.body.get("client_id") ?? "",
        resource: "https://api.fidyapp.com/mcp",
      });
      for (const [field, value] of [
        ["refresh_token", "x".repeat(43)],
        ["refresh_token", original.access_token],
        ["client_id", "20000000-0000-4000-8000-000000000001"],
        ["resource", "https://evil.example/mcp"],
        ["scope", "read write"],
        ["scope", "admin"],
        ["scope", ""],
        ["scope", "read read"],
        ["user_id", "20000000-0000-4000-8000-000000000001"],
      ]) {
        const body = new URLSearchParams(base);
        body.set(field ?? "", value ?? "");
        const refused = yield* wait(exchangeFixture({ ...fixture, body }));
        expect(refused.status).toBe(400);
        expect(yield* wait(refused.json())).toEqual({ error: "invalid_grant" });
        yield* assertRefreshUnchanged(fixture);
      }
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: original.access_token, method: "tools/list" })
        )).status
      ).toBe(200);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(200);
    })
  ));
it.each(["grant", "consent", "credential"])(
  "refuses refresh after %s withdrawal without consuming or publishing any generation",
  (withdrawn) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        if (withdrawn === "grant") {
          yield* wait(
            fixture.db
              .prepare("UPDATE oauth_connections SET revoked_at_ms = ?")
              .bind(yield* Clock.currentTimeMillis)
              .run()
          );
        }
        if (withdrawn === "consent") yield* revokeFixtureConsent(fixture.db);
        if (withdrawn === "credential") {
          yield* wait(
            fixture.db
              .prepare("UPDATE oauth_refresh_credentials SET expires_at_ms = issued_at_ms + 1")
              .run()
          );
        }
        expect(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).status
        ).toBe(400);
        yield* assertRefreshUnchanged(fixture);
        yield* assertReleased(fixture.db);
      })
    )
);
it("atomically revokes recognized replay after Consent withdrawal without minting replacement credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(200);
      yield* revokeFixtureConsent(fixture.db);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT revoked_at_ms FROM oauth_connections")
            .first<number>("revoked_at_ms")
        )
      ).not.toBeNull();
      for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
        expect(
          yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
        ).toBe(2);
      }
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      yield* assertReleased(fixture.db);
    })
  ));
it("rolls back replay revocation if its required Consent evidence cannot be appended", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      yield* wait(
        fixture.db
          .prepare(
            "CREATE TRIGGER skip_replay_evidence BEFORE INSERT ON oauth_revocation_consents BEGIN SELECT RAISE(IGNORE); END"
          )
          .run()
      );
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT revoked_at_ms FROM oauth_connections")
            .first<number>("revoked_at_ms")
        )
      ).toBeNull();
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: winner.access_token, method: "tools/list" })
        )).status
      ).toBe(200);
      yield* wait(fixture.db.prepare("DROP TRIGGER skip_replay_evidence").run());
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: winner.access_token, method: "tools/list" })
        )).status
      ).toBe(401);
      yield* assertReleased(fixture.db);
    })
  ));
it("honors the exact refresh inactivity boundary even before the absolute 90-day grant ends", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read"], 90);
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const expiry = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_refresh_credentials")
          .first<number>("expires_at_ms")
      );
      const grantExpiry = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections")
          .first<number>("expires_at_ms")
      );
      expect((grantExpiry ?? 0) - (expiry ?? 0)).toBeGreaterThan(0);
      vi.spyOn(Date, "now").mockReturnValue(expiry ?? 0);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      yield* assertRefreshUnchanged(fixture);
    })
  ));
it("clips both new credentials to the immutable grant and rejects at its exact expiration", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const expiration = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections")
          .first<number>("expires_at_ms")
      );
      const clock = vi.spyOn(Date, "now").mockReturnValue((expiration ?? 0) - 1000);
      const response = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      expect(response.status).toBe(200);
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(response.json()));
      expect(winner.expires_in).toBe(1);
      for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
        expect(
          yield* wait(
            fixture.db
              .prepare(`SELECT expires_at_ms FROM ${table} ORDER BY issued_at_ms DESC LIMIT 1`)
              .first<number>("expires_at_ms")
          )
        ).toBe(expiration);
      }
      clock.mockReturnValue(expiration ?? 0);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: winner.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: winner.access_token, method: "tools/list" })
        )).status
      ).toBe(401);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT revoked_at_ms FROM oauth_connections")
            .first<number>("revoked_at_ms")
        )
      ).toBeNull();
    })
  ));
it.each(["oauth_access_credentials", "oauth_refresh_credentials", "oauth_refresh_events"])(
  "rolls back refresh consumption and all credentials when %s publication is skipped",
  (table) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        yield* wait(
          fixture.db
            .prepare(
              `CREATE TRIGGER skip_refresh_publication BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`
            )
            .run()
        );
        expect(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).status
        ).toBe(400);
        yield* assertRefreshUnchanged(fixture);
        yield* wait(fixture.db.prepare("DROP TRIGGER skip_refresh_publication").run());
        expect(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).status
        ).toBe(200);
      })
    )
);
it("retains narrowed credential scopes across reconnect and never escalates back to the broader grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write"]);
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const narrowed = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({
              ...fixture,
              refresh: original.refresh_token,
              scope: Option.some("write"),
            })
          )).json()
        )
      );
      expect(narrowed.scope).toBe("write");
      const listed = yield* wait(
        mcpFixture({ send: fixture.send, bearer: narrowed.access_token, method: "tools/list" })
      );
      const narrowedTools = yield* Schema.decodeUnknownEffect(ListedTools)(
        yield* wait(listed.json())
      );
      expect(narrowedTools.result.tools.map(({ name }) => name)).toContain(
        "transactions.createTransaction"
      );
      expect(narrowedTools.result.tools.map(({ name }) => name)).not.toContain(
        "categories.listCategories"
      );
      expect(
        (yield* wait(
          refreshFixture({
            ...fixture,
            refresh: narrowed.refresh_token,
            scope: Option.some("read write"),
          })
        )).status
      ).toBe(400);
      const retained = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: narrowed.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      expect(retained.scope).toBe("write");
    })
  ));
it("rejects cross-User/client/resource refresh admissions under the real User lock without consuming authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      yield* sessionFor({ db: fixture.db, index: 2 });
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, user_id: Schema.String })
      )(
        yield* wait(
          fixture.db.prepare("SELECT id,user_id,digest FROM oauth_refresh_credentials").first()
        )
      );
      const admission = {
        deadlineAtMs: (yield* Clock.currentTimeMillis) + 5000,
        userId: row.user_id,
        connectionId: fixture.connectionId,
        credentialId: row.id,
        digest: Array.from(
          new Uint8Array(
            yield* wait(
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`oauth-refresh:${token.refresh_token}`)
              )
            )
          )
        ),
        clientId: fixture.body.get("client_id") ?? "",
        resource: "https://api.fidyapp.com/mcp",
      };
      for (const changed of [
        { ...admission, userId: "20000000-0000-4000-8000-000000000001" },
        { ...admission, connectionId: "20000000-0000-4000-8000-000000000001" },
        { ...admission, clientId: "20000000-0000-4000-8000-000000000001" },
        { ...admission, resource: "https://evil.example/mcp" },
      ]) {
        expect((yield* wait(fixture.refreshCoordinate(row.user_id, changed))).status).not.toBe(200);
        yield* assertRefreshUnchanged(fixture);
      }
      expect(
        (yield* wait(fixture.refreshCoordinate("20000000-0000-4000-8000-000000000001", admission)))
          .status
      ).toBe(503);
      yield* assertRefreshUnchanged(fixture);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
        )).status
      ).toBe(200);
    })
  ));
it("bounds token delivery waiting to five seconds and cancels queued refresh without later minting or blind retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const gate = fixture.holdRefresh();
      const pending = refreshFixture({
        ...fixture,
        refresh: token.refresh_token,
        scope: Option.none(),
      });
      yield* wait(gate.waiting);
      const refused = yield* wait(pending);
      expect(refused.status).toBe(503);
      expect(yield* wait(refused.json())).toEqual({ error: "temporarily_unavailable" });
      gate.release();
      yield* wait(gate.settled);
      yield* assertRefreshUnchanged(fixture);
      yield* assertReleased(fixture.db);
    })
  ));
it("cancels a streamed refresh body, releases admission and exposes no proof in failures or logs", () => {
  const abort = new AbortController();
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const reading = Promise.withResolvers<void>();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (): void => reading.resolve(),
          cancel: (): void => {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      );
      const pending = fixture.send("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        duplex: "half",
        signal: abort.signal,
      });
      yield* wait(reading.promise);
      abort.abort();
      const refused = yield* Effect.exit(wait(pending));
      deepStrictEqual(
        refused,
        Exit.fail(
          new TestFailure({
            cause: new Error("All fibers interrupted without error"),
          })
        )
      );
      expect(cancelled).toBe(true);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(refused)
      ).not.toContain(token.refresh_token);
      yield* assertRefreshUnchanged(fixture);
      yield* assertReleased(fixture.db);
    })
  );
});
it("keeps refresh success/refusal telemetry and persisted lifecycle evidence metadata-only", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const response = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(response.json()));
      const refused = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      expect(yield* wait(refused.json())).toEqual({ error: "invalid_grant" });
      const metadata: Array<unknown> = [];
      for (const table of [
        "oauth_access_credentials",
        "oauth_refresh_credentials",
        "oauth_refresh_events",
        "oauth_revocation_consents",
      ]) {
        metadata.push(yield* wait(fixture.db.prepare(`SELECT * FROM ${table}`).all()));
      }
      const exported = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        log.mock.calls
      );
      expect(log.mock.calls.length).toBeGreaterThan(0);
      const stored = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(metadata);
      for (const secret of [
        original.access_token,
        original.refresh_token,
        winner.access_token,
        winner.refresh_token,
      ]) {
        expect(exported).not.toContain(secret);
        expect(stored).not.toContain(secret);
      }
      for (const forbidden of [
        "oauth-refresh:",
        "https://",
        "connectionId",
        "digest",
        "BootstrapUnavailable",
        "D1_ERROR",
      ]) {
        expect(exported).not.toContain(forbidden);
      }
    })
  ));
it.each([
  { guard: "foreign_user", status: 400 },
  { guard: "stale_session", status: 401 },
  { guard: "hostile_origin", status: 403 },
  { guard: "unrequested_scope", status: 400 },
  { guard: "revoked_consent", status: 503 },
])(
  "refuses schema-valid approval with $guard and leaves no grant, Consent or callback code",
  ({ guard, status }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* reviewedFixture();
        const choice = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthReviewChoice))(
          fixture.choice
        );
        let headers = fixture.headers;
        let payload = choice;
        if (guard === "foreign_user") {
          headers = { ...headers, cookie: yield* sessionFor({ db: fixture.db, index: 2 }) };
        }
        if (guard === "stale_session") {
          yield* wait(
            fixture.db
              .prepare(
                "UPDATE web_sessions SET created_at_ms = created_at_ms - 600000, fresh_until_ms = fresh_until_ms - 600000, idle_expires_at_ms = idle_expires_at_ms - 600000, hard_expires_at_ms = hard_expires_at_ms - 600000"
              )
              .run()
          );
        }
        if (guard === "hostile_origin") headers = { ...headers, origin: "https://evil.example" };
        if (guard === "unrequested_scope") payload = { ...choice, scopes: ["read", "write"] };
        if (guard === "revoked_consent") {
          yield* wait(
            fixture.db
              .prepare(
                "INSERT INTO consent_user_revocations(id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('revoked',?,'grant-test','10000000-0000-4000-8000-000000000003',?)"
              )
              .bind("10000000-0000-4000-8000-000000000001", yield* Clock.currentTimeMillis)
              .run()
          );
        }
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthReviewChoice))(payload);
        const rejected = yield* wait(
          fixture.send("/web/oauth/connect", { method: "POST", headers, body })
        );
        expect(rejected.status).toBe(status);
        expect(yield* wait(rejected.text())).not.toContain('"callback"');
        for (const table of [
          "oauth_connections",
          "oauth_grant_consents",
          "oauth_codes",
          "oauth_access_credentials",
          "oauth_refresh_credentials",
        ]) {
          expect(
            yield* wait(
              fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")
            )
          ).toBe(0);
        }
      })
    )
);
const revokeFixtureConsent = (db: D1Database): Effect.Effect<void, TestFailure> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((current) =>
      wait(
        db
          .prepare(
            "INSERT INTO consent_user_revocations(id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('revoked',?,'grant-test','10000000-0000-4000-8000-000000000003',?)"
          )
          .bind("10000000-0000-4000-8000-000000000001", current)
          .run()
      )
    ),
    Effect.asVoid
  );
it("refuses an otherwise valid code after current Consent withdrawal without consuming or issuing credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      yield* revokeFixtureConsent(fixture.db);
      const refused = yield* wait(exchangeFixture(fixture));
      expect(refused.status).toBe(400);
      expect(yield* wait(refused.json())).toEqual({ error: "invalid_grant" });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_codes WHERE consumed_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
        expect(
          yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
        ).toBe(0);
      }
    })
  ));
const authorityTestInput = (operation: string): Schema.Json => {
  if (operation === "transactions.createTransaction") return transactionArguments;
  if (operation === "operations.executeAtomicBatch") {
    return { payload: { calls: transactionChildren } };
  }
  return {};
};
it.each(
  ["grant", "consent", "credential", "deadline"].flatMap((withdrawn) =>
    [
      "categories.listCategories",
      "memory.recall",
      "dashboard.getDashboard",
      "subscription.getSubscriptionStatus",
      "transactions.createTransaction",
      "operations.executeAtomicBatch",
    ].map((operation) => ({ withdrawn, operation }))
  )
)(
  "rechecks already-admitted OAuth authority after $withdrawn for $operation at the real User coordinator",
  ({ withdrawn, operation }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture(["read", "write"]);
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
        const admitted = yield* authenticateOAuth({
          db: fixture.db,
          current: yield* Clock.currentTimeMillis,
          request: new Request("https://api.fidyapp.com/mcp", {
            headers: { authorization: `Bearer ${token.access_token}` },
          }),
        });
        expect(Option.isSome(admitted)).toBe(true);
        if (Option.isNone(admitted)) return;
        const caller = admitted.value.subject;
        const payload = yield* Schema.encodeEffect(OAuthCanonicalAdmission)({
          userId: caller.userId,
          connectionId: caller.oauthConnectionId,
          credentialId: caller.credentialId,
          clientId: caller.clientId,
          resource: caller.resource,
          digest: Array.from(caller.digest),
          deadlineMilliseconds:
            (yield* Clock.currentTimeMillis) + (withdrawn === "deadline" ? -1 : 5000),
          operation: CanonicalOperationId.make(operation),
          input: authorityTestInput(operation),
        });
        if (withdrawn === "grant") {
          yield* wait(
            fixture.db
              .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
              .bind(yield* Clock.currentTimeMillis, fixture.connectionId)
              .run()
          );
        }
        if (withdrawn === "consent") {
          yield* revokeFixtureConsent(fixture.db);
        }
        if (withdrawn === "credential") {
          yield* wait(
            fixture.db
              .prepare("UPDATE oauth_access_credentials SET expires_at_ms = issued_at_ms + 1")
              .run()
          );
        }
        const refused = yield* wait(fixture.coordinate(caller.userId, payload));
        const credentialRefusalStatus = withdrawn === "consent" ? 403 : 401;
        expect(refused.status).toBe(withdrawn === "deadline" ? 503 : credentialRefusalStatus);
        const text = yield* wait(refused.text());
        expect(text).not.toContain("Restaurantes");
        expect(text).not.toContain(token.access_token);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
              .bind(fixture.connectionId)
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);
it("rolls back approval when required Consent evidence is skipped and code exchange when refresh issuance is skipped", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const review = yield* reviewedFixture();
      yield* wait(
        review.db
          .prepare(
            "CREATE TRIGGER refuse_oauth_consent BEFORE INSERT ON oauth_grant_consents BEGIN SELECT RAISE(IGNORE); END"
          )
          .run()
      );
      expect(
        (yield* wait(
          review.send("/web/oauth/connect", {
            method: "POST",
            headers: review.headers,
            body: review.choice,
          })
        )).status
      ).toBe(503);
      for (const table of [
        "oauth_connections",
        "oauth_grant_consents",
        "oauth_codes",
        "oauth_access_credentials",
        "oauth_refresh_credentials",
      ]) {
        expect(
          yield* wait(review.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
        ).toBe(0);
      }
      expect(
        yield* wait(
          review.db.prepare("SELECT count(*) FROM oauth_review_requests").first<number>("count(*)")
        )
      ).toBe(1);
      const fixture = yield* approvedFixture();
      yield* wait(
        fixture.db
          .prepare(
            "CREATE TRIGGER refuse_oauth_refresh BEFORE INSERT ON oauth_refresh_credentials BEGIN SELECT RAISE(IGNORE); END"
          )
          .run()
      );
      expect((yield* wait(exchangeFixture(fixture))).status).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_codes WHERE consumed_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
        expect(
          yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
        ).toBe(0);
      }
      yield* wait(fixture.db.prepare("DROP TRIGGER refuse_oauth_refresh").run());
      expect((yield* wait(exchangeFixture(fixture))).status).toBe(200);
    })
  ));
it("rejects substituted client, redirect, audience, missing PKCE and expired codes without consuming or minting authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      for (const [field, value] of [
        ["client_id", "20000000-0000-4000-8000-000000000001"],
        ["redirect_uri", "http://127.0.0.1:3457/callback"],
        ["resource", "https://evil.example/mcp"],
        ["code_verifier", ""],
      ]) {
        const changed = new URLSearchParams(fixture.body);
        if (value === "") changed.delete(field ?? "");
        else changed.set(field ?? "", value ?? "");
        const rejected = yield* wait(exchangeFixture({ ...fixture, body: changed }));
        expect(rejected.status).toBe(400);
        expect(yield* wait(rejected.json())).toEqual({ error: "invalid_grant" });
      }
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_codes WHERE consumed_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_access_credentials")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_refresh_credentials")
            .first<number>("count(*)")
        )
      ).toBe(0);
      yield* wait(
        fixture.db
          .prepare("UPDATE oauth_codes SET expires_at_ms = ?")
          .bind(yield* Clock.currentTimeMillis)
          .run()
      );
      expect((yield* wait(exchangeFixture(fixture))).status).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_access_credentials")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it.each(["abort", "deadline"])(
  "fences subsequent Core units and releases the coordinator after an in-flight Budget query %s",
  (fault) => {
    const abort = new AbortController();
    return Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture(["read"]);
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
        const time = DateTime.formatIso(yield* DateTime.now);
        yield* wait(
          fixture.db
            .prepare("INSERT INTO budgets VALUES (?, ?, ?, 'COP', '1000', ?, ?)")
            .bind(
              "30000000-0000-4000-8000-000000000001",
              "10000000-0000-4000-8000-000000000001",
              "10000000-0000-4000-8000-000000000001",
              time,
              time
            )
            .run()
        );
        const gate = fixture.holdBudgetRead();
        const response = mcpFixture({
          send: (path, init) => fixture.send(path, { ...init, signal: abort.signal }),
          bearer: token.access_token,
          method: "tools/call",
          name: "budgets.getBudgetStatus",
          args: { query: { timeZone: "America/Bogota" } },
        });
        yield* wait(gate.waiting);
        if (fault === "abort") {
          abort.abort();
          deepStrictEqual(
            yield* Effect.exit(wait(response)),
            Exit.fail(
              new TestFailure({
                cause: new Error("All fibers interrupted without error"),
              })
            )
          );
        } else {
          yield* wait(response);
        }
        gate.release();
        const next = yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        );
        expect(yield* wait(next.json())).toMatchObject({ result: { isError: false } });
        expect(gate.scheduled().filter((sql) => /budget|transaction_effective/u.test(sql))).toEqual(
          []
        );
      })
    );
  }
);
// These declarations deliberately have no native query owner yet; this is not an installed-query inventory.
const uninstalledQueries = new Set([
  "identity.getCurrentUser",
  "transactions.listSourceAttestations",
]);
const queryTools = operationCatalog.operations.filter(
  ({ id, policy }) =>
    policy.kind === "query" &&
    policy.access._tag === "UserOwnedAgentScoped" &&
    !uninstalledQueries.has(id)
);
it("accounts for every eligible query declaration and fails if an installed binding disappears", () => {
  expect(
    installedCanonicalOperations()
      .filter(
        ({ policy }) => policy.kind === "query" && policy.access._tag === "UserOwnedAgentScoped"
      )
      .map(({ id }) => id)
      .sort()
  ).toEqual(queryTools.map(({ id }) => id).sort());
  expect(operationCatalog.operations.filter(({ id }) => uninstalledQueries.has(id))).toHaveLength(
    uninstalledQueries.size
  );
  // The approved read slice includes Dashboard reads, never account-security or Dashboard mutation authority.
  expect(
    queryTools.every(
      ({ policy }) =>
        policy.access._tag === "UserOwnedAgentScoped" &&
        policy.access.scope._tag === "Operation" &&
        policy.access.scope.capability === "read"
    )
  ).toBe(true);
  expect(queryTools.map(({ id }) => id)).toContain("dashboard.getDashboard");
});
it("refuses deliberately missing canonical query adapters without inventing a binding or accounting work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read"]);
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      for (const name of uninstalledQueries) {
        const response = yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name,
            args: {},
          })
        );
        expect(yield* wait(response.json()), name).toHaveProperty("error");
      }
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("total")
        )
      ).toBe(0);
    })
  ));
const ListedTools = Schema.Struct({
  result: Schema.Struct({
    cacheScope: Schema.Literal("private"),
    ttlMs: Schema.Literal(0),
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        inputSchema: Schema.Json,
        outputSchema: Schema.Json,
        annotations: Schema.Struct({
          readOnlyHint: Schema.Boolean,
          destructiveHint: Schema.Boolean,
        }),
      })
    ),
  }),
});
const Listed2025Tools = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        inputSchema: Schema.Json,
        outputSchema: Schema.optionalKey(Schema.Json),
        annotations: Schema.Struct({
          readOnlyHint: Schema.Boolean,
          destructiveHint: Schema.Boolean,
        }),
      })
    ),
  }),
});
it("retains a 2025 session across separate initialized and discovery requests through published ingress", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const headers = {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      const initialized = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: "initialize-resident",
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "resident-protocol-fixture", version: "1" },
            },
          }),
        })
      );
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get("mcp-session-id");
      expect(sessionId).not.toBeNull();
      yield* wait(initialized.text());
      const sessionHeaders = {
        ...headers,
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId ?? "",
      };
      const notified = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: sessionHeaders,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        })
      );
      expect(notified.status).toBe(202);
      yield* wait(notified.text());
      const discovery = yield* wait(
        fixture.send("/mcp", {
          method: "POST",
          headers: sessionHeaders,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: "discover-resident",
            method: "tools/list",
            params: {},
          }),
        })
      );
      expect(discovery.status).toBe(200);
      const listed = yield* Schema.decodeUnknownEffect(Listed2025Tools)(
        yield* wait(discovery.json())
      );
      expect(listed.result.tools.map(({ name }) => name)).toEqual(
        [...readDiscovery, "operations.executeAtomicBatch"].sort()
      );
      for (const tool of listed.result.tools) {
        if (tool.name === "operations.executeAtomicBatch") {
          expect(tool.annotations.readOnlyHint).toBe(false);
        } else {
          expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
        }
      }
    })
  ));
it("derives exact private canonical discovery for every non-empty capability combination without leaking nested unauthorized identities", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const { scopes, tools, additionalDeclarations } of discoveryCases) {
        const capabilities = yield* Schema.decodeUnknownEffect(PATScopes)(scopes);
        const fixture = yield* approvedFixture(capabilities);
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
        const listed = yield* Schema.decodeUnknownEffect(ListedTools)(
          yield* wait(
            (yield* wait(
              mcpFixture({ send: fixture.send, bearer: token.access_token, method: "tools/list" })
            )).json()
          )
        );
        const expected = [...tools].sort();
        const names = listed.result.tools.map(({ name }) => name);
        expect(names, scopes.join(" ")).toEqual(expected);
        for (const excluded of excludedAccountSecurityDiscovery) {
          expect(names).not.toContain(excluded);
        }
        for (const tool of listed.result.tools) {
          expect(tool.annotations).toEqual({
            readOnlyHint: readDiscovery.includes(tool.name),
            destructiveHint: sensitiveDiscovery.has(tool.name),
          });
        }
        const schemas = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
          listed.result.tools.map(({ inputSchema, outputSchema }) => ({
            inputSchema,
            outputSchema,
          }))
        );
        const allowedDeclarations = new Set([...tools, ...additionalDeclarations]);
        for (const operation of operationCatalog.operations.filter(
          ({ id }) => !allowedDeclarations.has(id)
        )) {
          expect(schemas).not.toContain(`"${operation.id}"`);
        }
      }
    })
  ));
const expectedQueryFailure = (id: string, peer: boolean): boolean =>
  id === "ingestion.getStatementSubmission" ||
  (peer &&
    [
      "dashboard.getDashboard",
      "dashboard.getDashboardView",
      "budgets.getBudget",
      "transactions.getTransaction",
    ].includes(id));
it("executes every installed declaration-derived query through Core for two Users with private exact structured and text outcomes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write", "dashboard"]);
      const cookie = yield* sessionForUser({ db: fixture.db, index: 2, userIndex: 2 });
      const time = DateTime.formatIso(yield* DateTime.now);
      const resourceId = "30000000-0000-4000-8000-000000000001";
      const privateMarker = "primary-user-private";
      yield* wait(
        fixture.db.batch([
          fixture.db
            .prepare(
              "INSERT INTO onboarding_consent_records VALUES ('grant-peer', ?, '{}', 'disclosure', 'decision', 1, 1)"
            )
            .bind("20000000-0000-4000-8000-000000000001"),
          fixture.db
            .prepare("INSERT INTO trial_periods VALUES (?,0,604800000)")
            .bind("10000000-0000-4000-8000-000000000001"),
          fixture.db
            .prepare("INSERT INTO trial_periods VALUES (?,0,604800000)")
            .bind("20000000-0000-4000-8000-000000000001"),
          fixture.db
            .prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?)")
            .bind(resourceId, "10000000-0000-4000-8000-000000000001", privateMarker, time, time),
          fixture.db
            .prepare("INSERT INTO keyword_rules VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(
              resourceId,
              "10000000-0000-4000-8000-000000000001",
              privateMarker,
              privateMarker,
              "10000000-0000-4000-8000-000000000001",
              time,
              time
            ),
          fixture.db
            .prepare(
              "INSERT INTO transactions (id,user_id,amount,currency,direction,counterparty,category_id,notes,occurred_at,created_at) VALUES (?,?,'9007199254740993','COP','outflow','Mercado',?,?,?,?)"
            )
            .bind(
              resourceId,
              "10000000-0000-4000-8000-000000000001",
              "10000000-0000-4000-8000-000000000001",
              privateMarker,
              time,
              time
            ),
          fixture.db
            .prepare("INSERT INTO budgets VALUES (?, ?, ?, 'COP', '9007199254740994', ?, ?)")
            .bind(
              resourceId,
              "10000000-0000-4000-8000-000000000001",
              "10000000-0000-4000-8000-000000000001",
              time,
              time
            ),
        ])
      );
      expect(
        (yield* wait(
          fixture.send("/dashboard/initialize", {
            method: "POST",
            headers: fixture.headers,
            body: "{}",
          })
        )).status
      ).toBe(200);
      const peer = yield* approveAgain({ ...fixture, headers: { ...fixture.headers, cookie } });
      const examples: ReadonlyArray<Schema.Json> = [
        {},
        { query: {} },
        { query: { timeZone: "America/Bogota" } },
        { query: { q: "mercado" } },
        { params: { id: resourceId } },
      ];
      for (const current of [fixture, peer]) {
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(
          yield* wait(
            (yield* wait(exchangeFixture({ send: fixture.send, body: current.body }))).json()
          )
        );
        for (const operation of queryTools) {
          // Catalog cases exercise owner behavior, not burst admission.
          vi.spyOn(Date, "now").mockReturnValue((yield* Clock.currentTimeMillis) + 1000);
          const args = examples.find((example) =>
            Option.isSome(
              Schema.decodeOption(operation.input, { onExcessProperty: "error" })(example)
            )
          );
          expect(args, operation.id).toBeDefined();
          const response = yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: operation.id,
              args: args ?? {},
            })
          );
          const raw = yield* wait(response.json());
          expect(raw, operation.id).toHaveProperty("result.structuredContent");
          const value = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              result: Schema.Struct({
                isError: Schema.Boolean,
                structuredContent: Schema.Json,
                content: Schema.Tuple([
                  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
                ]),
              }),
            })
          )(raw);
          const result = value.result;
          expect(
            Option.isSome(
              Schema.decodeOption(result.isError ? operation.failure : operation.success)(
                result.structuredContent
              )
            ),
            operation.id
          ).toBe(true);
          expect(
            yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(result.content[0].text)
          ).toEqual(result.structuredContent);
          expect(result.content[0].text, operation.id).not.toContain("unauthenticated");
          expect(result.content[0].text, operation.id).not.toContain("validation_failed");
          expect(result.content[0].text, operation.id).not.toContain('"code":"unavailable"');
          const intentionallyAbsent = expectedQueryFailure(
            operation.id,
            current.connectionId === peer.connectionId
          );
          expect(result.isError, operation.id).toBe(intentionallyAbsent);
          if (current.connectionId === peer.connectionId) {
            expect(result.content[0].text, operation.id).not.toContain(privateMarker);
            expect(result.content[0].text, operation.id).not.toContain("9007199254740993");
          } else if (operation.id === "transactions.listTransactions") {
            expect(result.content[0].text).toContain("9007199254740993");
            expect(result.content[0].text).toContain(privateMarker);
          }
          const audit = yield* wait(
            fixture.db
              .prepare(
                "SELECT oauth_connection_id,oauth_credential_id,pat_id,operation,outcome FROM pat_audit WHERE operation = ? AND oauth_connection_id = ?"
              )
              .bind(operation.id, current.connectionId)
              .all()
          );
          expect(audit.results, operation.id).toHaveLength(1);
          expect(audit.results[0], operation.id).toMatchObject({
            oauth_connection_id: current.connectionId,
            pat_id: null,
            operation: operation.id,
          });
        }
      }
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) AS total FROM dashboard_documents")
            .first<number>("total")
        )
      ).toBe(1);
    })
  ));
it("validates malformed structured inputs for every eligible query without echoing arguments or duplicating accounting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write", "dashboard"]);
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      for (const operation of queryTools) {
        vi.spyOn(Date, "now").mockReturnValue((yield* Clock.currentTimeMillis) + 1000);
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            result: Schema.Struct({
              isError: Schema.Literal(true),
              structuredContent: Schema.Json,
              content: Schema.Array(Schema.Struct({ text: Schema.String })),
            }),
          })
        )(
          yield* wait(
            (yield* wait(
              mcpFixture({
                send: fixture.send,
                bearer: token.access_token,
                method: "tools/call",
                name: operation.id,
                args: { unexpected: "private-input-must-not-escape" },
              })
            )).json()
          )
        );
        expect(result.result.structuredContent, operation.id).toMatchObject({
          error: { code: "validation_failed" },
          next: [],
        });
        expect(
          Option.isSome(Schema.decodeOption(operation.failure)(result.result.structuredContent)),
          operation.id
        ).toBe(true);
        expect(result.result.content[0]?.text, operation.id).not.toContain(
          "private-input-must-not-escape"
        );
        const audit = yield* wait(
          fixture.db
            .prepare(
              "SELECT outcome FROM pat_audit WHERE operation = ? AND oauth_connection_id = ?"
            )
            .bind(operation.id, fixture.connectionId)
            .all()
        );
        expect(audit.results, operation.id).toEqual([{ outcome: "rejected" }]);
      }
    })
  ));
it("retains complete query data while removing scope-inaccessible continuations before MCP serialization", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read"]);
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      fixture.interceptQueryResponse(({ response }) =>
        response.json().then((body: unknown) => {
          const raw = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Json }))(body);
          return Response.json({
            data: raw.data,
            next: [
              {
                tool: "memory.remember",
                hint: "Private denied hint.",
                args: { payload: { text: "private-denied-input" } },
              },
            ],
          });
        })
      );
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            isError: Schema.Literal(false),
            structuredContent: Schema.Struct({
              data: Schema.Array(Schema.Json),
              next: Schema.Array(Schema.Json),
            }),
            content: Schema.Array(Schema.Struct({ text: Schema.String })),
          }),
        })
      )(
        yield* wait(
          (yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "categories.listCategories",
              args: {},
            })
          )).json()
        )
      );
      expect(result.result.structuredContent.data).toHaveLength(16);
      expect(result.result.structuredContent.next).toEqual([]);
      expect(result.result.content[0]?.text).not.toContain("private-denied");
      expect(result.result.content[0]?.text).not.toContain("Private denied hint.");
    })
  ));
it.each([
  "malformed-json",
  "malformed-output",
  "oversized-output",
  "rejected-response",
  "deadline",
  "retry-info",
])(
  "returns a bounded schema-valid structured failure for $0 without diagnostic or accounting duplication",
  (fault) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
        let cleanedUp = false;
        fixture.interceptQueryResponse(({ request, response }) => {
          if (fault === "retry-info") {
            return Promise.resolve(
              Response.json(
                {
                  error: {
                    code: "rate_limited",
                    message: "Retry after the admission window.",
                    retryAfterSeconds: 7,
                  },
                  next: [],
                },
                { status: 429, headers: { "retry-after": "7" } }
              )
            );
          }
          if (fault === "rejected-response") {
            return Promise.reject(new Error("private-diagnostic-must-not-escape"));
          }
          if (fault === "malformed-json") {
            return Promise.resolve(new Response("private-diagnostic-must-not-escape"));
          }
          if (fault === "malformed-output") {
            return Promise.resolve(
              Response.json({ data: "private-diagnostic-must-not-escape", next: [] })
            );
          }
          if (fault === "oversized-output") {
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start: (controller): void => {
                    controller.enqueue(new Uint8Array(1_048_577));
                  },
                  cancel: (): void => {
                    cleanedUp = true;
                  },
                })
              )
            );
          }
          const pending = Promise.withResolvers<Response>();
          const onAbort = (): void => {
            cleanedUp = true;
            pending.resolve(response);
          };
          if (request.signal.aborted) onAbort();
          else request.signal.addEventListener("abort", onAbort, { once: true });
          return pending.promise;
        });
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            result: Schema.Struct({
              isError: Schema.Literal(true),
              structuredContent: Schema.Json,
              content: Schema.Tuple([
                Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
              ]),
            }),
          })
        )(
          yield* wait(
            (yield* wait(
              mcpFixture({
                send: fixture.send,
                bearer: token.access_token,
                method: "tools/call",
                name: "categories.listCategories",
                args: {},
              })
            )).json()
          )
        );
        const operation = operationCatalog.byId.get("categories.listCategories");
        expect(operation).toBeDefined();
        if (operation === undefined) return;
        expect(
          Option.isSome(Schema.decodeOption(operation.failure)(result.result.structuredContent))
        ).toBe(true);
        expect(result.result.structuredContent).toMatchObject(
          fault === "retry-info"
            ? { error: { code: "rate_limited", retryAfterSeconds: 7 }, next: [] }
            : { error: { code: "unavailable" }, next: [] }
        );
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
            result.result.content[0].text
          )
        ).toEqual(result.result.structuredContent);
        expect(result.result.content[0].text).not.toContain("private-diagnostic-must-not-escape");
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) AS total FROM pat_audit WHERE oauth_connection_id = ?")
              .bind(fixture.connectionId)
              .first<number>("total")
          )
        ).toBe(1);
        if (fault === "oversized-output" || fault === "deadline") expect(cleanedUp).toBe(true);
      })
    )
);
it("returns a schema-valid unavailable failure from a genuinely unavailable native Memory storage adapter", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read"]);
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      yield* wait(fixture.db.prepare("DROP TABLE memories").run());
      const raw = yield* wait(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "memory.recall",
            args: {},
          })
        )).json()
      );
      expect(raw).toMatchObject({
        result: { isError: true, structuredContent: { error: { code: "unavailable" }, next: [] } },
      });
      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Json }) })
      )(raw);
      const operation = operationCatalog.byId.get("memory.recall");
      if (operation === undefined) throw new Error("Missing Memory declaration");
      expect(
        Option.isSome(Schema.decodeOption(operation.failure)(parsed.result.structuredContent))
      ).toBe(true);
    })
  ));
it("returns the canonical uninitialized Dashboard outcome without creating domain state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read"]);
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const response = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "dashboard.getDashboard",
          args: {},
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "dashboard_uninitialized" }, next: [] },
        },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM dashboard_documents").first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("keeps read and account-security tools uncallable by a write-only connection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["write"]);
      const exchanged = yield* wait(exchangeFixture(fixture));
      expect(exchanged.status).toBe(200);
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait(exchanged.json()));
      const listed = yield* wait(
        mcpFixture({ send: fixture.send, bearer: token.access_token, method: "tools/list" })
      );
      const tools = yield* Schema.decodeUnknownEffect(ListedTools)(yield* wait(listed.json()));
      expect(tools.result.tools.map(({ name }) => name)).toContain("operations.executeAtomicBatch");
      for (const name of [
        "categories.listCategories",
        "pats.createPAT",
        "browserLogin.approvePairing",
      ]) {
        const refused = yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name,
            args: {},
          })
        );
        expect(yield* wait(refused.text())).toContain('"error"');
      }
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("blocks wrong-purpose credentials and live explicit Consent revocation after discovery without query evidence or data effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const request = (): Promise<Response> =>
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        });
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: token.access_token, method: "tools/list" })
        )).status
      ).toBe(200);
      expect(
        (yield* wait(
          mcpFixture({ send: fixture.send, bearer: token.refresh_token, method: "tools/list" })
        )).status
      ).toBe(401);
      yield* revokeFixtureConsent(fixture.db);
      expect((yield* wait(request())).status).toBe(401);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("rejects cross-User and client coordinator substitutions and returns validated structured failures for malformed canonical inputs", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      yield* sessionFor({ db: fixture.db, index: 2 });
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const digest = Array.from(
        new Uint8Array(
          yield* wait(
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(`oauth-access:${token.access_token}`)
            )
          )
        )
      );
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, user_id: Schema.String })
      )(
        yield* wait(
          fixture.db
            .prepare("SELECT id,user_id FROM oauth_access_credentials WHERE connection_id = ?")
            .bind(fixture.connectionId)
            .first()
        )
      );
      const admission = {
        userId: row.user_id,
        connectionId: fixture.connectionId,
        credentialId: row.id,
        clientId: fixture.body.get("client_id") ?? "",
        resource: "https://api.fidyapp.com/mcp",
        digest,
        deadlineMilliseconds: (yield* Clock.currentTimeMillis) + 5000,
        operation: "categories.listCategories",
        input: {},
      };
      expect(
        (yield* wait(fixture.coordinate("20000000-0000-4000-8000-000000000001", admission))).status
      ).toBe(503);
      expect(
        (yield* wait(
          fixture.coordinate(row.user_id, {
            ...admission,
            clientId: "20000000-0000-4000-8000-000000000001",
          })
        )).status
      ).toBe(401);
      expect(
        (yield* wait(
          fixture.coordinate(row.user_id, {
            ...admission,
            userId: "20000000-0000-4000-8000-000000000001",
          })
        )).status
      ).toBe(503);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
      const invalid = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: { payload: { unexpected: true } },
        })
      );
      expect(invalid.status).toBe(200);
      const value = yield* wait(invalid.json());
      expect(value).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "validation_failed" }, next: [] },
        },
      });
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ? AND outcome = 'rejected'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));
it("rejects revoked and exactly expired grants before code exchange or query admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const revoked = yield* approvedFixture();
      yield* wait(
        revoked.db
          .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
          .bind(yield* Clock.currentTimeMillis, revoked.connectionId)
          .run()
      );
      expect((yield* wait(exchangeFixture(revoked))).status).toBe(400);
      expect(
        yield* wait(
          revoked.db
            .prepare("SELECT count(*) FROM oauth_access_credentials")
            .first<number>("count(*)")
        )
      ).toBe(0);
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const expiration = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
          .bind(fixture.connectionId)
          .first<number>("expires_at_ms")
      );
      expect(expiration).not.toBeNull();
      vi.spyOn(Date, "now").mockReturnValue(expiration ?? 0);
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(401);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("expires access authority without extending the reviewed connection or disclosing credential material", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const expiration = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
          .bind(fixture.connectionId)
          .first<number>("expires_at_ms")
      );
      yield* wait(
        fixture.db
          .prepare("UPDATE oauth_access_credentials SET expires_at_ms = issued_at_ms + 1")
          .run()
      );
      const rejected = yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(rejected.status).toBe(401);
      expect(yield* wait(rejected.text())).not.toContain(token.access_token);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
            .bind(fixture.connectionId)
            .first<number>("expires_at_ms")
        )
      ).toBe(expiration);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("approves a separately identified connection with atomic Consent and only a protected authorization-code callback", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const requestId = yield* startReview(send);
      const cookie = yield* sessionFor({ db, index: 1 });
      yield* wait(
        db
          .prepare(
            "INSERT INTO onboarding_consent_records VALUES (?, ?, '{}', 'disclosure', 'decision', 1, 1)"
          )
          .bind("10000000-0000-4000-8000-000000000004", "10000000-0000-4000-8000-000000000001")
          .run()
      );
      const headers = {
        origin: "https://app.fidyapp.com",
        cookie,
        "content-type": "application/json",
      };
      const reviewed = yield* wait(send(`/web/oauth/review?requestId=${requestId}`, { headers }));
      const review = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ reviewedAt: Schema.String })
      )(yield* wait(reviewed.json()));
      const reviewedAt = yield* Schema.decodeEffect(Schema.DateTimeUtcFromString)(
        review.reviewedAt
      );
      const expiresAt = DateTime.formatIso(DateTime.add(reviewedAt, { days: 7 }));
      const choice = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
        requestId,
        scopes: ["read"],
        lifetimeDays: 7,
        reviewedAt: review.reviewedAt,
        expiresAt,
      });
      const approved = yield* wait(
        send("/web/oauth/connect", { method: "POST", headers, body: choice })
      );
      expect(approved.status).toBe(200);
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ callback: Schema.String, connectionId: Schema.String })
      )(yield* wait(approved.json()));
      const callback = new URL(result.callback);
      expect(callback.origin + callback.pathname).toBe("http://127.0.0.1:3456/callback");
      expect(callback.searchParams.get("iss")).toBe("https://api.fidyapp.com");
      expect(callback.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(result).not.toHaveProperty("access_token");
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        client_id:
          (yield* wait(
            db
              .prepare("SELECT client_id FROM oauth_connections WHERE id = ?")
              .bind(result.connectionId)
              .first<string>("client_id")
          )) ?? "",
        redirect_uri: "http://127.0.0.1:3456/callback",
        resource: "https://api.fidyapp.com/mcp",
        code_verifier: "x".repeat(43),
      });
      const exchange = (): Promise<Response> =>
        send("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: tokenBody.toString(),
        });
      expect((yield* wait(exchange())).status).toBe(400);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_access_credentials").first<number>("count(*)")
        )
      ).toBe(0);
      tokenBody.set("code_verifier", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
      const exchanges = yield* wait(Promise.all([exchange(), exchange()]));
      expect(exchanges.map((value) => value.status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      const winner = exchanges.find((value) => value.status === 200);
      if (winner === undefined) return yield* new TestFailure({ cause: "No exchange winner" });
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          access_token: Schema.String,
          refresh_token: Schema.String,
          expires_in: Schema.Int,
          scope: Schema.String,
        })
      )(yield* wait(winner.json()));
      expect(token.expires_in).toBe(600);
      expect(token.scope).toBe("read");
      expect(token.access_token).not.toBe(token.refresh_token);
      const mcp = (method: string, params?: Schema.Json): Promise<Response> =>
        send("/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.access_token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...(method === "tools/call" ? { "mcp-name": "categories.listCategories" } : {}),
          },
          body: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              ...Schema.decodeUnknownSync(Schema.JsonObject)(params ?? {}),
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        });
      const listed = yield* wait(mcp("tools/list"));
      expect(listed.status).toBe(200);
      const listBody = yield* wait(listed.text());
      expect(listBody).toContain("categories.listCategories");
      expect(listBody).not.toContain("categories.createKeywordRule");
      const queried = yield* wait(
        mcp("tools/call", { name: "categories.listCategories", arguments: {} })
      );
      const queryBody = yield* wait(queried.text());
      expect(queried.status, queryBody).toBe(200);
      expect(queryBody).toContain("Restaurantes");
      expect(queryBody).toContain('"isError":false');
      expect(queryBody).toContain('"structuredContent"');
      expect(queryBody).not.toContain("createKeywordRule");
      const observed = yield* makeAudit({ database: db }).query({
        userId: "10000000-0000-4000-8000-000000000001",
        limit: 10,
      });
      expect(observed.map((entry) => entry.caller)).toMatchObject([
        { _tag: "OAuthAgent", connectionId: result.connectionId },
      ]);
      expect(
        yield* wait(
          db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(result.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect((yield* wait(exchange())).status).toBe(400);
      expect(approved.headers.get("cache-control")).toBe("no-store");
      expect(approved.headers.get("referrer-policy")).toBe("no-referrer");
      expect(
        yield* wait(db.prepare("SELECT count(*) FROM oauth_connections").first<number>("count(*)"))
      ).toBe(1);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_grant_consents").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        (yield* wait(send("/web/oauth/connect", { method: "POST", headers, body: choice }))).status
      ).toBe(400);
    })
  ));
it(
  "rejects distributed registration and discovery pressure at global limits",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, send } = yield* setup();
        for (let index = 0; index < 100; index++) {
          expect(
            (yield* wait(
              sendFrom(send, Math.floor(index / 10))("/oauth/register", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
              })
            )).status
          ).toBe(400);
        }
        expect(
          (yield* wait(
            sendFrom(send, 20)("/oauth/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          )).status
        ).toBe(429);
        for (let index = 0; index < 499; index++) {
          expect(
            (yield* wait(
              sendFrom(send, 30 + Math.floor(index / 60))("/.well-known/oauth-authorization-server")
            )).status
          ).toBe(200);
        }
        expect(
          (yield* wait(sendFrom(send, 50)("/.well-known/oauth-authorization-server"))).status
        ).toBe(429);
        expect(
          yield* wait(
            db.prepare("SELECT count(*) FROM oauth_public_clients").first<number>("count(*)")
          )
        ).toBe(0);
        yield* assertReleased(db);
      })
    ),
  60_000
);
it("keeps the stable User budget across fresh sessions and rotating sources", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const requestId = yield* startReview(send);
      const cookies = [
        yield* sessionFor({ db, index: 1 }),
        yield* sessionForUser({ db, index: 2, userIndex: 1 }),
      ];
      for (let index = 0; index < 60; index++) {
        expect(
          (yield* wait(
            sendFrom(send, index + 1)(`/web/oauth/review?requestId=${requestId}`, {
              headers: { origin: "https://app.fidyapp.com", cookie: cookies[index % 2] ?? "" },
            })
          )).status
        ).toBe(200);
      }
      expect(
        (yield* wait(
          sendFrom(send, 80)(`/web/oauth/review?requestId=${requestId}`, {
            headers: { origin: "https://app.fidyapp.com", cookie: cookies[1] ?? "" },
          })
        )).status
      ).toBe(429);
      expect(
        yield* wait(
          db
            .prepare(
              "SELECT count(*) FROM resource_admission_events WHERE policy_key = 'oauth.user.v1'"
            )
            .first<number>("count(*)")
        )
      ).toBe(60);
      yield* assertReleased(db);
    })
  ));
it("atomically caps concurrent pending requests at five per source", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const query = yield* authorizationQuery(send);
      const attempts = yield* wait(
        Promise.all(Array.from({ length: 6 }, () => send(`/oauth/authorize?${query}`)))
      );
      expect(attempts.filter((response) => response.status === 302)).toHaveLength(5);
      expect(attempts.filter((response) => response.status === 503)).toHaveLength(1);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_review_requests").first<number>("count(*)")
        )
      ).toBe(5);
      yield* assertReleased(db);
    })
  ));
it("atomically caps concurrent request bindings at five per stable User across sources", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const references: Array<string> = [];
      for (let index = 0; index < 6; index++) {
        references.push(yield* startReview(sendFrom(send, index)));
      }
      const cookie = yield* sessionFor({ db, index: 1 });
      const attempts = yield* wait(
        Promise.all(
          references.map((requestId, index) =>
            sendFrom(send, index)(`/web/oauth/review?requestId=${requestId}`, {
              headers: { origin: "https://app.fidyapp.com", cookie },
            })
          )
        )
      );
      expect(attempts.filter((response) => response.status === 200)).toHaveLength(5);
      expect(attempts.filter((response) => response.status === 400)).toHaveLength(1);
      expect(
        yield* wait(
          db
            .prepare("SELECT count(*) FROM oauth_review_requests WHERE user_id IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(5);
      yield* assertReleased(db);
    })
  ));
it("refuses registry overflow atomically and reclaims unused registrations without exceeding capacity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const current = yield* Clock.currentTimeMillis;
      yield* wait(
        db
          .prepare(
            "WITH RECURSIVE clients(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM clients WHERE i < 10000) INSERT INTO oauth_public_clients(id, metadata_json, created_at_ms, last_used_at_ms) SELECT printf('%036d', i), ?, ?, ? FROM clients"
          )
          .bind(
            '{"client_name":"Agente","redirect_uris":["https://example.com/cb"]}',
            current,
            current
          )
          .run()
      );
      const register = (): Promise<Response> =>
        send("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"client_name":"Agente","redirect_uris":["https://example.com/cb"]}',
        });
      expect((yield* wait(register())).status).toBe(503);
      yield* wait(
        db
          .prepare(
            "UPDATE oauth_public_clients SET last_used_at_ms = ? WHERE id = printf('%036d',1)"
          )
          .bind(current - 2592000000)
          .run()
      );
      const attempts = yield* wait(Promise.all(Array.from({ length: 3 }, register)));
      expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_public_clients").first<number>("count(*)")
        )
      ).toBe(10000);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_review_requests").first<number>("count(*)")
        )
      ).toBe(0);
      yield* assertReleased(db);
    })
  ));
it("caps outstanding bootstrap work before reading another body and releases leases after rejected payloads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const probes = Array.from({ length: 32 }, heldBody);
      const attempts = probes.map((probe, index) =>
        sendFrom(send, index)("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: probe.body,
          duplex: "half",
        })
      );
      yield* wait(Promise.all(probes.map((probe) => probe.reading)));
      expect(
        (yield* wait(sendFrom(send, 50)("/.well-known/oauth-authorization-server"))).status
      ).toBe(429);
      probes.forEach((probe) => probe.release());
      const rejected = yield* wait(Promise.all(attempts));
      expect(rejected.every((response) => response.status === 400)).toBe(true);
      yield* assertReleased(db);
      expect(
        (yield* wait(sendFrom(send, 50)("/.well-known/oauth-authorization-server"))).status
      ).toBe(200);
    })
  ));
it("requires a fresh same-User session and CSRF-safe origin for review and cancellation without granting unreviewed authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const requestId = yield* startReview(send);
      const cookie = yield* sessionFor({ db, index: 1 });
      const otherCookie = yield* sessionFor({ db, index: 2 });
      const path = `/web/oauth/review?requestId=${requestId}`;
      expect((yield* wait(send(path))).status).toBe(403);
      expect(
        (yield* wait(
          send(path, {
            headers: { origin: "https://app.fidyapp.com", cookie: "__Host-fidy_session=forged" },
          })
        )).status
      ).toBe(401);
      const headers = {
        origin: "https://app.fidyapp.com",
        cookie,
        "content-type": "application/json",
      };
      const review = yield* wait(send(path, { headers }));
      expect(review.status).toBe(200);
      expect(yield* wait(review.json())).toMatchObject({
        scopes: ["read"],
        connectAvailable: true,
        permissions: [
          {
            scope: "read",
            label: "Consultar tus datos",
            description: "Consultar tus datos financieros en Fidy.",
          },
        ],
      });
      expect(
        (yield* wait(send(path, { headers: { ...headers, cookie: otherCookie } }))).status
      ).toBe(400);
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            requestId: Schema.String,
            scopes: Schema.Array(Schema.String),
            lifetimeDays: Schema.Finite,
          })
        )
      )({ requestId, scopes: ["write"], lifetimeDays: 90 });
      expect(
        (yield* wait(send("/web/oauth/connect", { method: "POST", headers, body: encoded }))).status
      ).toBe(400);
      const approved = yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            requestId: Schema.String,
            scopes: Schema.Array(Schema.String),
            lifetimeDays: Schema.Finite,
          })
        )
      )({ requestId, scopes: ["read"], lifetimeDays: 90 });
      expect(
        (yield* wait(send("/web/oauth/connect", { method: "POST", headers, body: approved })))
          .status
      ).toBe(400);
      const cancelled = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ requestId: Schema.String }))
      )({ requestId });
      expect(
        (yield* wait(
          send("/web/oauth/cancel", {
            method: "POST",
            headers: { ...headers, origin: "https://evil.example" },
            body: cancelled,
          })
        )).status
      ).toBe(403);
      expect(
        (yield* wait(send("/web/oauth/cancel", { method: "POST", headers, body: cancelled })))
          .status
      ).toBe(200);
      expect((yield* wait(send(path, { headers }))).status).toBe(400);
      expect(
        yield* wait(db.prepare("SELECT count(*) FROM oauth_connections").first<number>("count(*)"))
      ).toBe(0);
    })
  ));
it("rejects hostile registration metadata and actual oversized streamed bytes without retaining a client", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, db } = yield* setup();
      for (const body of [
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb"],"client_uri":"http://169.254.169.254/metadata"}',
        '{"client_name":"Agente","redirect_uris":["https://user:secret@example.com/cb"]}',
        '{"client_name":"Agente","redirect_uris":["http://192.168.1.1/cb"]}',
        '{"client_name":"Agente","redirect_uris":["http://localhost/cb"]}',
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb","https://example.com/cb"]}',
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb"],"grant_types":["authorization_code","authorization_code"]}',
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb#fragment"]}',
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb"],"token_endpoint_auth_method":"client_secret_basic"}',
      ]) {
        const rejected = yield* wait(
          send("/oauth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          })
        );
        expect(rejected.status).toBe(400);
        expect(yield* wait(rejected.json())).toEqual({ error: "invalid_client_metadata" });
      }
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull: (controller): void => controller.enqueue(new Uint8Array(16385)),
        cancel: (): void => {
          cancelled = true;
        },
      });
      expect(
        (yield* wait(
          send("/oauth/register", {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": "1" },
            body,
            duplex: "half",
          })
        )).status
      ).toBe(400);
      expect(cancelled).toBe(true);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_public_clients").first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
it("bounds registration and discovery pressure independently of canonical allowances", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, db } = yield* setup();
      for (let index = 0; index < 10; index++) {
        expect(
          (yield* wait(
            send("/oauth/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: '{"client_name":"Agente","redirect_uris":["http://127.0.0.1/cb"]}',
            })
          )).status
        ).toBe(201);
      }
      expect(
        (yield* wait(
          send("/oauth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"client_name":"Agente","redirect_uris":["http://127.0.0.1/cb"]}',
          })
        )).status
      ).toBe(429);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_public_clients").first<number>("count(*)")
        )
      ).toBe(10);
      for (let index = 0; index < 49; index++) {
        expect((yield* wait(send("/.well-known/oauth-authorization-server"))).status).toBe(200);
      }
      expect((yield* wait(send("/.well-known/oauth-authorization-server"))).status).toBe(429);
    })
  ));
it("refuses expired requests, empty scope choices and arbitrary metadata URLs without leaking claims", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, db } = yield* setup();
      const requestId = yield* startReview(send);
      const cookie = yield* sessionFor({ db, index: 1 });
      const headers = {
        origin: "https://app.fidyapp.com",
        cookie,
        "content-type": "application/json",
      };
      const empty = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
        requestId,
        scopes: [],
        lifetimeDays: 90,
      });
      expect(
        (yield* wait(send("/web/oauth/connect", { method: "POST", headers, body: empty }))).status
      ).toBe(400);
      const current = yield* Clock.currentTimeMillis;
      yield* wait(
        db
          .prepare(
            "UPDATE oauth_review_requests SET created_at_ms = ?, expires_at_ms = ? WHERE id = ?"
          )
          .bind(current - 600000, current, requestId)
          .run()
      );
      expect(
        (yield* wait(send(`/web/oauth/review?requestId=${requestId}`, { headers }))).status
      ).toBe(400);
      for (const client of [
        "http://169.254.169.254/metadata",
        "https://127.0.0.1/metadata",
        "https://evil.example/redirect-chain",
      ]) {
        const query = new URLSearchParams({
          client_id: client,
          resource: "https://api.fidyapp.com/mcp",
        });
        const rejected = yield* wait(send(`/oauth/authorize?${query}`));
        expect(rejected.status).toBe(400);
        expect(yield* wait(rejected.text())).toBe('{"error":"invalid_request"}');
      }
      expect((yield* wait(send("/oauth/token", { method: "POST" }))).status).toBe(400);
    })
  ));
it("discovers the fixed MCP resource and issuer through ingress/Core without purchasing canonical work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send } = yield* setup();
      const resource = yield* wait(send("/.well-known/oauth-protected-resource/mcp"));
      expect(resource.status).toBe(200);
      expect(yield* wait(resource.json())).toEqual({
        resource: "https://api.fidyapp.com/mcp",
        authorization_servers: ["https://api.fidyapp.com"],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
      });
      const issuer = yield* wait(send("/.well-known/oauth-authorization-server"));
      expect(issuer.status).toBe(200);
      expect(yield* wait(issuer.json())).toMatchObject({
        issuer: "https://api.fidyapp.com",
        authorization_endpoint: "https://api.fidyapp.com/oauth/authorize",
        registration_endpoint: "https://api.fidyapp.com/oauth/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
      const challenge = yield* wait(send("/mcp"));
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toBe(
        'Bearer resource_metadata="https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp", scope="read"'
      );
      expect(resource.headers.get("cache-control")).toBe("no-store");
    })
  ));
it("registers a public client without secrets and binds the redirect, resource and S256 request before browser handoff", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, db } = yield* setup();
      const registered = yield* wait(
        send("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"client_name":"Mi agente","redirect_uris":["http://127.0.0.1/callback"]}',
        })
      );
      expect(registered.status).toBe(201);
      const client = yield* wait(registered.json());
      const parsed = yield* Schema.decodeUnknownEffect(Schema.Struct({ client_id: Schema.String }))(
        client
      );
      expect(client).not.toHaveProperty("client_secret");
      const query = new URLSearchParams({
        client_id: parsed.client_id,
        redirect_uri: "http://127.0.0.1:3456/callback",
        response_type: "code",
        resource: "https://api.fidyapp.com/mcp",
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256",
        state: "state-is-not-authority",
      });
      const started = yield* wait(send(`/oauth/authorize?${query}`));
      expect(started.status).toBe(302);
      expect(started.headers.get("location")).toMatch(
        /^https:\/\/app\.fidyapp\.com\/oauth\/review\/[0-9a-f-]{36}$/u
      );
      const count = yield* wait(
        db.prepare("SELECT count(*) AS total FROM oauth_review_requests").first<number>("total")
      );
      expect(count).toBe(1);
      query.set("resource", "https://evil.example/mcp");
      expect((yield* wait(send(`/oauth/authorize?${query}`))).status).toBe(400);
      query.set("resource", "https://api.fidyapp.com/mcp");
      query.set("redirect_uri", "http://127.0.0.1:3456/other");
      expect((yield* wait(send(`/oauth/authorize?${query}`))).status).toBe(400);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) AS total FROM oauth_review_requests").first<number>("total")
        )
      ).toBe(1);
    })
  ));

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
                  retryKey: Option.none(),
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

const allowancePAT = (
  fixture: Readonly<{ send: Harness["send"]; headers: FixtureHeaders }>
): Effect.Effect<string, TestFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const issued = yield* wait(
      fixture.send("/pats", {
        method: "POST",
        headers: fixture.headers,
        body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          requestId: "10000000-0000-4000-8000-000000000005",
          grant: {
            recipientLabel: "Agente directo",
            scopes: ["read", "write"],
            lifetimeDays: 7,
            reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(current + 604800000)),
          },
        }),
      })
    );
    expect(issued.status).toBe(200);
    const pat = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.Struct({ bearer: Schema.String }) })
    )(yield* wait(issued.json()));
    return pat.data.bearer;
  });

const seedCanonicalConsumption = (
  db: D1Database,
  units: number
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const period = allowancePeriod(DateTime.makeUnsafe(current));
    yield* wait(
      db.batch(
        Array.from({ length: units }, (_, index) =>
          db
            .prepare(
              "INSERT INTO commercial_allowance_consumptions VALUES (?,'canonical_call',?,?,?,1)"
            )
            .bind(
              "10000000-0000-4000-8000-000000000001",
              `seed-${index}`,
              DateTime.toEpochMillis(period.startsAt),
              current
            )
        )
      )
    );
  });

it("shares the canonical-call allowance between PAT ingress and OAuth MCP", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      const direct = yield* wait(
        fixture.send("/categories", { headers: { authorization: `Bearer ${patBearer}` } })
      );
      expect(direct.status).toBe(200);
      expect(direct.headers.get("fidy-canonical-remaining")).toBe("49");
      const called = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(yield* wait(called.json())).toMatchObject({
        result: {
          isError: false,
          _meta: {
            "co.fidy/canonicalAllowance": {
              allowance: "canonical_call",
              limit: "50",
              remaining: "48",
            },
          },
        },
      });
      const inspected = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(inspected.json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { consumed: 2, remaining: 48 } } } },
      });
    })
  ));

it("accounts OAuth mutation attempts and atomic batches once and replays across PAT and rotated credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      const args = {
        payload: { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } },
      };
      const invoke = (name: string, args: Schema.Json, retryKey?: Schema.Json): Promise<Response> =>
        mcpFixture(
          { ...fixture, bearer: token.access_token, method: "tools/call", name, args },
          Option.fromUndefinedOr(retryKey)
        );
      const created = yield* wait(invoke("budgets.createBudget", args, "budget-once"));
      const original = yield* wait(created.json());
      expect(original).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "49" } } },
      });
      const patReplay = yield* wait(
        fixture.send("/budgets", {
          method: "POST",
          headers: {
            authorization: `Bearer ${patBearer}`,
            "content-type": "application/json",
            "fidy-retry-key": "budget-once",
          },
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(args.payload),
        })
      );
      expect(patReplay.status).toBe(201);
      expect(patReplay.headers.get("fidy-canonical-remaining")).toBe("49");
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      const replayed = yield* wait(
        mcpFixture(
          {
            ...fixture,
            bearer: rotated.access_token,
            method: "tools/call",
            name: "budgets.createBudget",
            args,
          },
          Option.some("budget-once")
        )
      );
      expect(yield* wait(replayed.json())).toEqual(original);
      const mismatch = yield* wait(
        invoke(
          "budgets.createBudget",
          { payload: { ...args.payload, cap: { amount: "2000", currency: "COP" } } },
          "budget-once"
        )
      );
      expect(yield* wait(mismatch.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "validation_failed" } },
          _meta: { "co.fidy/canonicalAllowance": { remaining: "49" } },
        },
      });
      const failed = yield* wait(invoke("budgets.createBudget", args));
      expect(yield* wait(failed.json())).toMatchObject({
        result: { isError: true, _meta: { "co.fidy/canonicalAllowance": { remaining: "48" } } },
      });
      const batch = {
        payload: {
          calls: [
            {
              callId: "10000000-0000-4000-8000-000000000011",
              operation: "budgets.createBudget",
              input: {
                payload: {
                  categoryId: categoryIds.transporte,
                  cap: { amount: "2000", currency: "COP" },
                },
              },
            },
            {
              callId: "10000000-0000-4000-8000-000000000012",
              operation: "budgets.createBudget",
              input: {
                payload: {
                  categoryId: categoryIds.salud,
                  cap: { amount: "3000", currency: "COP" },
                },
              },
            },
          ],
        },
      };
      const batched = yield* wait(invoke("operations.executeAtomicBatch", batch, "batch-once"));
      expect(yield* wait(batched.json())).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "47" } } },
      });
      const repeat = yield* wait(invoke("operations.executeAtomicBatch", batch, "batch-once"));
      expect(yield* wait(repeat.json())).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "47" } } },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(3);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_credential_id IS NOT NULL AND operation = 'budgets.createBudget'"
            )
            .first<number>("count(*)")
        )
      ).toBe(6);
    })
  ));

it("refuses exhausted OAuth mutations and batches without partial effects across clients, grants and refresh", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      yield* seedCanonicalConsumption(fixture.db, 50);
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      const again = yield* approveAgain(fixture);
      const replacement = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: again.body }))).json())
      );
      const query = yield* authorizationQuery(fixture.send);
      const clientBody = new URLSearchParams(fixture.body);
      clientBody.set("client_id", query.get("client_id") ?? "");
      const otherClient = yield* approveAgain({ ...fixture, body: clientBody });
      const other = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: otherClient.body }))).json())
      );
      for (const bearer of [
        token.access_token,
        rotated.access_token,
        replacement.access_token,
        other.access_token,
      ]) {
        const discovery = yield* wait(mcpFixture({ ...fixture, bearer, method: "tools/list" }));
        expect(discovery.status).toBe(200);
        const query = yield* wait(
          mcpFixture({
            ...fixture,
            bearer,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        );
        expect(yield* wait(query.json())).toMatchObject({
          result: {
            isError: true,
            structuredContent: { error: { code: "quota_exhausted", allowance: "canonical_call" } },
            _meta: { "co.fidy/canonicalAllowance": { remaining: "0" } },
          },
        });
      }
      const args = {
        payload: { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } },
      };
      for (const [name, input] of [
        ["budgets.createBudget", args],
        [
          "operations.executeAtomicBatch",
          {
            payload: {
              calls: [
                {
                  callId: "10000000-0000-4000-8000-000000000011",
                  operation: "budgets.createBudget",
                  input: args,
                },
              ],
            },
          },
        ],
      ] as const) {
        const refused = yield* wait(
          mcpFixture({
            ...fixture,
            bearer: rotated.access_token,
            method: "tools/call",
            name,
            args: input,
          })
        );
        expect(yield* wait(refused.json())).toMatchObject({
          result: { isError: true, structuredContent: { error: { code: "quota_exhausted" } } },
        });
      }
      const inspection = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: other.access_token,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(inspection.json())).toMatchObject({
        result: {
          isError: false,
          structuredContent: { data: { canonicalCalls: { remaining: 0, consumed: 50 } } },
        },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(0);
    })
  ));

it("linearizes parallel PAT and OAuth mutation admission at the last Free canonical unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      yield* seedCanonicalConsumption(fixture.db, 49);
      const cap = { amount: "1000", currency: "COP" };
      const patBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
        categoryId: categoryIds.transporte,
        cap,
      });
      const [pat, oauth] = yield* wait(
        Promise.all([
          fixture.send("/budgets", {
            method: "POST",
            headers: { authorization: `Bearer ${patBearer}`, "content-type": "application/json" },
            body: patBody,
          }),
          mcpFixture({
            ...fixture,
            bearer: token.access_token,
            method: "tools/call",
            name: "budgets.createBudget",
            args: { payload: { categoryId: categoryIds.mercado, cap } },
          }),
        ])
      );
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({ isError: Schema.Boolean, structuredContent: Schema.Json }),
        })
      )(yield* wait(oauth.json()));
      expect(Number(pat.ok) + Number(!result.result.isError)).toBe(1);
      const refusal = pat.ok ? result.result.structuredContent : yield* wait(pat.json());
      expect(refusal).toMatchObject({ error: { code: "quota_exhausted" } });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(1);
      const remaining = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(remaining.json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { consumed: 50, remaining: 0 } } } },
      });
    })
  ));

it("resets the shared OAuth and PAT allowance at the exact Bogota month boundary without recharging live retries", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const instant = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-01T04:59:59.999Z"));
      const clock = vi.spyOn(Date, "now").mockReturnValue(instant);
      const fixture = yield* approvedFixture(["read", "write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      yield* seedCanonicalConsumption(fixture.db, 49);
      const call = (): Promise<Response> =>
        mcpFixture(
          {
            ...fixture,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          },
          Option.some("month-boundary")
        );
      const last = yield* wait(call());
      expect(yield* wait(last.json())).toMatchObject({
        result: {
          isError: false,
          _meta: {
            "co.fidy/canonicalAllowance": { remaining: "0", resetsAt: "2026-11-01T05:00:00.000Z" },
          },
        },
      });
      const refused = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(yield* wait(refused.json())).toMatchObject({
        result: {
          structuredContent: {
            error: { code: "quota_exhausted", resetsAt: "2026-11-01T05:00:00.000Z" },
          },
        },
      });
      clock.mockReturnValue(instant + 1);
      const replayed = yield* wait(call());
      expect(yield* wait(replayed.json())).toMatchObject({
        result: {
          isError: false,
          _meta: {
            "co.fidy/canonicalAllowance": { remaining: "50", resetsAt: "2026-12-01T05:00:00.000Z" },
          },
        },
      });
      const direct = yield* wait(
        fixture.send("/categories", { headers: { authorization: `Bearer ${patBearer}` } })
      );
      expect(direct.status).toBe(200);
      expect(direct.headers.get("fidy-canonical-remaining")).toBe("49");
      const inspected = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(inspected.json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { remaining: 49, consumed: 1 } } } },
      });
    })
  ));

it("keeps Trial OAuth calls commercially uncapped while reporting independent security refusal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      yield* seedCanonicalConsumption(fixture.db, 50);
      const current = yield* Clock.currentTimeMillis;
      yield* wait(
        fixture.db
          .prepare("INSERT INTO trial_periods VALUES (?,?,?)")
          .bind("10000000-0000-4000-8000-000000000001", current - 1, current - 1 + 604800000)
          .run()
      );
      const called = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(yield* wait(called.json())).toMatchObject({
        result: {
          isError: false,
          _meta: { "co.fidy/canonicalAllowance": { limit: "uncapped", remaining: "uncapped" } },
        },
      });
      yield* wait(
        fixture.db
          .prepare(
            "INSERT INTO canonical_request_buckets VALUES (?,?) ON CONFLICT(subject) DO UPDATE SET virtual_at_ms = excluded.virtual_at_ms"
          )
          .bind("user:10000000-0000-4000-8000-000000000001", current + 60000)
          .run()
      );
      const refused = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(yield* wait(refused.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "rate_limited", retryAfterSeconds: 1 } },
          _meta: { "co.fidy/canonicalAllowance": { remaining: "uncapped" } },
        },
      });
    })
  ));

it("charges native confirmation once and prevents continuation references from exempting unrelated canonical work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const inspect = (): Promise<Response> =>
        mcpFixture({ ...fixture, method: "tools/call", name: "quota.getQuota", args: {} });
      expect(yield* wait((yield* wait(inspect())).json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { consumed: 2 } } } },
      });
      expect(yield* wait((yield* wait(fixture.call(explicitNativeAccept))).json())).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "48" } } },
      });
      expect(yield* wait((yield* wait(fixture.call(explicitNativeAccept))).json())).toMatchObject({
        result: { isError: true, _meta: { "co.fidy/canonicalAllowance": { remaining: "48" } } },
      });
      const unrelated = yield* wait(
        nativeConfirmationCall(
          fixture,
          {
            name: "categories.listCategories",
            arguments: {},
            requestState: fixture.reference,
            inputResponses: { review: explicitNativeAccept },
          },
          "categories.listCategories"
        )
      );
      expect(yield* wait(unrelated.json())).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "47" } } },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(0);
    })
  ));

it("shares one retry admission during parallel PAT and OAuth mutations without repeating a domain effect", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      yield* seedCanonicalConsumption(fixture.db, 49);
      const payload = { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } };
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(payload);
      const direct = (): Promise<Response> =>
        fixture.send("/budgets", {
          method: "POST",
          headers: {
            authorization: `Bearer ${patBearer}`,
            "content-type": "application/json",
            "fidy-retry-key": "parallel-once",
          },
          body,
        });
      const [pat, oauth] = yield* wait(
        Promise.all([
          direct(),
          mcpFixture(
            {
              ...fixture,
              bearer: token.access_token,
              method: "tools/call",
              name: "budgets.createBudget",
              args: { payload },
            },
            Option.some("parallel-once")
          ),
        ])
      );
      const reply = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ result: Schema.Struct({ isError: Schema.Boolean }) })
      )(yield* wait(oauth.json()));
      expect(pat.ok || !reply.result.isError).toBe(true);
      const replay = yield* wait(direct());
      expect(replay.status).toBe(201);
      expect(replay.headers.get("fidy-canonical-remaining")).toBe("0");
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT sum(units) FROM commercial_allowance_consumptions WHERE allowance = 'canonical_call'"
            )
            .first<number>("sum(units)")
        )
      ).toBe(50);
    })
  ));

it("rechecks live OAuth capabilities and revocation before disclosing retained financial retry results", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture(["read", "write"]);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const args = {
        payload: { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } },
      };
      const created = yield* wait(
        mcpFixture(
          {
            ...fixture,
            bearer: token.access_token,
            method: "tools/call",
            name: "budgets.createBudget",
            args,
          },
          Option.some("private-budget")
        )
      );
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
          }),
        })
      )(yield* wait(created.json()));
      const peer = yield* nativePeer(fixture, 2);
      const separate = yield* wait(
        mcpFixture(
          {
            ...fixture,
            bearer: peer.bearer,
            method: "tools/call",
            name: "budgets.createBudget",
            args,
          },
          Option.some("private-budget")
        )
      );
      const peerResult = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
          }),
        })
      )(yield* wait(separate.json()));
      expect(peerResult.result.structuredContent.data.id).not.toBe(
        result.result.structuredContent.data.id
      );
      const standing = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: peer.bearer,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(standing.json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { consumed: 1, remaining: 49 } } } },
      });
      const readonlyGrant = yield* approveAgain(fixture);
      const readonlyToken = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: readonlyGrant.body }))).json())
      );
      const refused = yield* wait(
        mcpFixture(
          {
            ...fixture,
            bearer: readonlyToken.access_token,
            method: "tools/call",
            name: "budgets.createBudget",
            args,
          },
          Option.some("private-budget")
        )
      );
      const text = yield* wait(refused.text());
      expect(text).not.toContain(result.result.structuredContent.data.id);
      expect(text).toContain('"error"');
      yield* wait(
        fixture.send("/web/oauth/revoke", {
          method: "POST",
          headers: fixture.headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            connectionId: fixture.connectionId,
          }),
        })
      );
      const revoked = yield* wait(
        mcpFixture(
          {
            ...fixture,
            bearer: token.access_token,
            method: "tools/call",
            name: "budgets.createBudget",
            args,
          },
          Option.some("private-budget")
        )
      );
      expect(revoked.status).toBe(401);
      expect(yield* wait(revoked.text())).not.toContain(result.result.structuredContent.data.id);
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(2);
    })
  ));
