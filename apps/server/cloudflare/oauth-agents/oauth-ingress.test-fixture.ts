import { categoryIds } from "../../src/core/categories/contract";
import { Clock, Data, DateTime, Effect, Option, Predicate, Schema } from "effect";
import { afterAll, expect } from "vitest";
import { applyTestMigration, installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { makeMutationCommitGate } from "./mutation-commit.test-fixture";
import { UserTransactionCoordinator } from "../transactions/runtime";
import { type McpResidency, makeMcpResidency } from "../mcp/runtime";
import { OAuthMcpAdmission } from "../mcp/contract";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import publicWorker from "../public-worker";
import coreWorker from "../core-worker";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";

const databases = isolatedTestDatabases();

export class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}

export const wait = <A>(promise: Promise<A>): Effect.Effect<A, TestFailure> =>
  Effect.tryPromise({ try: () => promise, catch: (cause) => new TestFailure({ cause }) });

type QueryGate = Readonly<{
  waiting: ReturnType<typeof Promise.withResolvers<void>>;
  release: ReturnType<typeof Promise.withResolvers<void>>;
  settled: ReturnType<typeof Promise.withResolvers<void>>;
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
          return gate.release.promise
            .then(() => {
              const result: unknown = Reflect.apply(method, target, args);
              return result;
            })
            .finally(gate.settled.resolve);
        }
        if (gate.scheduled.length > 0) gate.scheduled.push(sql);
        const result: unknown = Reflect.apply(method, target, args);
        return result;
      };
    },
  });

const admitsCanonicalFault = (
  request: Request,
  intercept: Option.Option<Parameters<Harness["interceptQueryResponse"]>[0]>
): boolean => new URL(request.url).pathname === "/oauth-mcp" && Option.isSome(intercept);

const fetchCoordinator = (
  input: Readonly<{
    name: string;
    request: Request;
    coordinators: Map<string, UserTransactionCoordinator>;
    environment: ConstructorParameters<typeof UserTransactionCoordinator>[1];
  }>
): Promise<Response> => {
  let coordinator = input.coordinators.get(input.name);
  if (coordinator === undefined) {
    coordinator = new UserTransactionCoordinator(
      { id: { name: input.name }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
      input.environment
    );
    input.coordinators.set(input.name, coordinator);
  }
  return coordinator.fetch(input.request);
};

const deliverCanonicalFault = (
  input: Readonly<{
    name: string;
    request: Request;
    db: D1Database;
    residencies: Map<string, McpResidency>;
    enqueueCanonicalWork: Parameters<typeof makeMcpResidency>[0]["enqueueCanonicalWork"];
  }>
): Promise<Response> => {
  let residency = input.residencies.get(input.name);
  if (residency === undefined) {
    residency = makeMcpResidency({
      userId: input.name,
      db: input.db,
      enqueueCanonicalWork: input.enqueueCanonicalWork,
    });
    input.residencies.set(input.name, residency);
  }
  const resident = residency;
  return input.request.text().then((body) =>
    Effect.runPromise(
      resident.handle({
        admission: Schema.decodeSync(Schema.fromJsonString(OAuthMcpAdmission))(body),
        signal: input.request.signal,
      })
    )
  );
};

export type Harness = Readonly<{
  disableInference: () => void;
  mcpHandoffs: () => number;
  holdMutationCommit: () => Readonly<{
    waiting: Promise<void>;
    settled: Promise<void>;
    release: () => void;
  }>;
  holdBudgetRead: () => Readonly<{
    waiting: Promise<void>;
    release: () => void;
    settled: Promise<void>;
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

export const setup = (auditMigration = true): Effect.Effect<Harness, TestFailure> =>
  Effect.gen(function* () {
    const db = yield* wait(databases.acquire());
    const sources = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
    )
      .sort((left, right) => left.localeCompare(right))
      .filter(
        (name) =>
          auditMigration ||
          (name !== "0037_oauth_shared_audit_budget.sql" &&
            name !== "0062_pat_activity.sql" &&
            name !== "0063_connections.sql" &&
            name !== "0064_connection_browser_execution.sql" &&
            name !== "0065_connection_attempt_retention.sql")
      )
      .map((name) => new URL(`../migrations/${name}`, import.meta.url));
    if (auditMigration) yield* wait(installTestSchema({ db, sources }));
    else for (const source of sources) yield* wait(applyTestMigration({ db, source }));
    let mcpHandoffCount = 0;
    const coordinators = new Map<string, UserTransactionCoordinator>();
    const deliveryResidencies = new Map<string, McpResidency>();
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
            if (new URL(request.url).pathname === "/oauth-mcp") mcpHandoffCount += 1;
            // Delivery-fault tests compose the published residency with the real canonical
            // HTTP boundary, so faults affect SDK result decoding without patching internals.
            if (admitsCanonicalFault(request, queryResponseIntercept)) {
              return deliverCanonicalFault({
                name,
                request,
                db: queryDb,
                residencies: deliveryResidencies,
                enqueueCanonicalWork: ({ admission, signal }) =>
                  Effect.gen(function* () {
                    const body = yield* Schema.encodeEffect(
                      Schema.fromJsonString(OAuthCanonicalAdmission)
                    )(admission);
                    return yield* Effect.tryPromise(() =>
                      environment.USER_TRANSACTION_COORDINATOR.getByName(name).fetch(
                        new Request("https://coordinator.internal/oauth-canonical", {
                          method: "POST",
                          signal,
                          body,
                        })
                      )
                    );
                  }).pipe(Effect.orDie),
              });
            }
            const run = (): Promise<Response> =>
              fetchCoordinator({ coordinators, name, environment, request });
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
            fetch: (incoming) => {
              const forwarded = incoming instanceof Request ? incoming : new Request(incoming);
              return coreWorker.fetch(forwarded, environment).then((response) => {
                const location = response.headers.get("location");
                // Cloudflare's HTTP binding follows redirects on newly constructed Requests.
                // Keep the redirect target inside this isolated Core, never on the network.
                if (
                  forwarded.redirect === "follow" &&
                  response.status === 302 &&
                  location !== null
                ) {
                  return coreWorker.fetch(new Request(location), environment);
                }
                return response;
              });
            },
          },
        }
      );
    return {
      db: queryDb,
      send,
      mcpHandoffs: () => mcpHandoffCount,
      holdMutationCommit: mutationCommit.hold,
      disableInference: () => {
        environment.HOSTED_AI_MODEL = "";
      },
      restartCoordinators: () => coordinators.clear(),
      holdBudgetRead: () => {
        const gate: QueryGate = {
          waiting: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
          settled: Promise.withResolvers<void>(),
          scheduled: [],
        };
        queryGate = Option.some(gate);
        return {
          waiting: gate.waiting.promise,
          release: gate.release.resolve,
          settled: gate.settled.promise,
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

export const sessionForUser = (
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

export const sessionFor = (
  input: Readonly<{ db: D1Database; index: number }>
): Effect.Effect<string, TestFailure> => sessionForUser({ ...input, userIndex: input.index });

export const authorizationQuery = (
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

export const sendFrom =
  ({ send, index }: Readonly<{ send: Harness["send"]; index: number }>): Harness["send"] =>
  (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", `198.51.100.${index + 1}`);
    return send(path, { ...init, headers });
  };

export const clockAt = ({
  live,
  current,
  read,
}: Readonly<{ live: Clock.Clock; current: number; read: () => number }>): Clock.Clock => ({
  currentTimeMillisUnsafe: read,
  currentTimeMillis: Effect.sync(read),
  currentTimeNanosUnsafe: () => BigInt(current) * 1000000n,
  currentTimeNanos: Effect.succeed(BigInt(current) * 1000000n),
  monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: live.monotonicTimeNanos,
  sleep: (duration) => live.sleep(duration),
});

export const assertReleased = (db: D1Database): Effect.Effect<void, TestFailure> =>
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

export type FixtureHeaders = Readonly<{ origin: string; cookie: string; "content-type": string }>;

export const reviewedFixture = (
  {
    scopes,
    lifetimeDays,
    auditMigration,
  }: Readonly<{
    scopes: ReadonlyArray<string>;
    lifetimeDays: number;
    auditMigration: boolean;
  }> = { scopes: ["read"], lifetimeDays: 7, auditMigration: true }
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

export const approvedFixture = (
  {
    scopes,
    lifetimeDays,
    auditMigration,
  }: Readonly<{
    scopes: ReadonlyArray<string>;
    lifetimeDays: number;
    auditMigration: boolean;
  }> = { scopes: ["read"], lifetimeDays: 7, auditMigration: true }
): Effect.Effect<
  Harness & Readonly<{ connectionId: string; body: URLSearchParams; headers: FixtureHeaders }>,
  TestFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const { choice, query, headers, ...harness } = yield* reviewedFixture({
      scopes,
      lifetimeDays,
      auditMigration,
    });
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

export const exchangeFixture = (
  fixture: Readonly<{ send: Harness["send"]; body: URLSearchParams }>
): Promise<Response> =>
  fixture.send("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: fixture.body.toString(),
  });

export const mcpFixture = (
  input: Readonly<
    { send: Harness["send"]; bearer: string; retryKey: Option.Option<Schema.Json> } & (
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
          ...Option.match(input.retryKey, {
            onNone: () => ({}),
            onSome: (retryKey) => ({ "co.fidy/retryKey": retryKey }),
          }),
        },
      },
    }),
  });

export const nativeConfirmationCall = ({
  fixture,
  params,
  name,
}: Readonly<{
  fixture: Readonly<{ send: Harness["send"]; bearer: string }>;
  params: Schema.Json;
  name: string;
}>): Promise<Response> =>
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

export const reviewBudgetDeletion = ({
  send,
  bearer,
  id,
}: Readonly<{ send: Harness["send"]; bearer: string; id: string }>): Effect.Effect<
  Readonly<{
    reference: string;
    call: (response: Schema.Json, argumentsOverride?: Schema.Json) => Promise<Response>;
  }>,
  TestFailure | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const args = { params: { id } };
    const review = yield* wait(
      nativeConfirmationCall({
        fixture: { send, bearer },
        params: { name: "budgets.deleteBudget", arguments: args },
        name: "budgets.deleteBudget",
      })
    );
    const pending = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ result: Schema.Struct({ requestState: Schema.String }) })
    )(yield* wait(review.json()));
    const call = (
      response: Schema.Json,
      argumentsOverride: Schema.Json = args
    ): Promise<Response> =>
      nativeConfirmationCall({
        fixture: { send, bearer },
        params: {
          name: "budgets.deleteBudget",
          arguments: argumentsOverride,
          requestState: pending.result.requestState,
          inputResponses: { review: response },
        },
        name: "budgets.deleteBudget",
      });
    return { reference: pending.result.requestState, call };
  });

export const pendingBudgetDeletion = (
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
    const fixture = yield* approvedFixture({
      scopes,
      lifetimeDays: 7,
      auditMigration: true,
    });
    const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
      yield* wait((yield* wait(exchangeFixture(fixture))).json())
    );
    const bearer = token.access_token;
    const created = yield* wait(
      mcpFixture({
        retryKey: Option.none(),
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
    const review = yield* reviewBudgetDeletion({ send: fixture.send, bearer, id });
    return { ...fixture, bearer, id, ...review };
  });

export type NativeFixture = Effect.Success<ReturnType<typeof pendingBudgetDeletion>>;

export const approveAgain = (
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

export const transactionArguments = {
  payload: {
    money: { amount: "15000", currency: "COP" },
    direction: "outflow",
    occurredAt: "2026-10-03T12:00:00.000Z",
  },
};

export const transactionChildren = [
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

export const TokenFixture = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Int,
  scope: Schema.String,
});

export const refreshFixture = (
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

export const revokeFixtureConsent = (db: D1Database): Effect.Effect<void, TestFailure> =>
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

export const ListedTools = Schema.Struct({
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

afterAll(() => databases.dispose());

export const nativePeer = ({
  fixture,
  userIndex,
}: Readonly<{
  fixture: Pick<NativeFixture, "send" | "db">;
  userIndex: 1 | 2;
}>): Effect.Effect<
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
