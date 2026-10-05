import { operationCatalog } from "../../src/shell/api";
import {
  discoveryCases,
  excludedAccountSecurityDiscovery,
  readDiscovery,
  sensitiveDiscovery,
} from "./discovery.test-fixture";
import { installedCanonicalOperations } from "../canonical-operations/operations";
import { categoryIds } from "../../src/core/categories/contract";
import { PATScopes } from "../../src/core/tokens/contract";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { Clock, Data, DateTime, Effect, Option, Predicate, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import { authenticateOAuth } from "./operations";
import { makeMutationCommitGate } from "./mutation-commit.test-fixture";
import { OAuthReviewChoice } from "../../src/shell/oauth-agents/contract";
import { makeAudit } from "../../src/shell/audit/runtime";
import { UserTransactionCoordinator } from "../transactions/runtime";
import publicWorker from "../public-worker";
import coreWorker from "../core-worker";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
afterEach(() => vi.restoreAllMocks());
class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}
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
const setup = (): Effect.Effect<Harness, TestFailure> =>
  Effect.gen(function* () {
    const db = yield* wait(databases.acquire());
    yield* wait(
      installTestSchema({
        db,
        sources: Array.from(
          new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
        )
          .sort((left, right) => left.localeCompare(right))
          .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
      })
    );
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
      db,
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
  lifetimeDays = 7
): Effect.Effect<
  Harness & Readonly<{ query: URLSearchParams; choice: string; headers: FixtureHeaders }>,
  TestFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const harness = yield* setup();
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
  lifetimeDays = 7
): Effect.Effect<
  Harness & Readonly<{ connectionId: string; body: URLSearchParams; headers: FixtureHeaders }>,
  TestFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const { choice, query, headers, ...harness } = yield* reviewedFixture(scopes, lifetimeDays);
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
  >
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
        },
      },
    }),
  });
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
      const response = yield* wait(
        mcpFixture({
          send: (path, init) => fixture.send(path, { ...init, signal: controller.signal }),
          bearer: token.access_token,
          method: "tools/call",
          name: "transactions.createTransaction",
          args: transactionArguments,
        })
      );
      yield* wait(committed.promise);
      expect(response.status).toBe(503);
      expect(yield* wait(response.text())).not.toContain("rolled back");
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
      const refused = yield* wait(pending);
      expect(refused.status).not.toBe(200);
      expect(cancelled).toBe(true);
      expect(yield* wait(refused.text())).not.toContain(token.refresh_token);
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
        if (fault === "abort") abort.abort();
        yield* wait(response);
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
it("rejects distributed registration and discovery pressure at global limits", () =>
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
  ));
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
