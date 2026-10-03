import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { afterAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { BigDecimal, type Cause, DateTime, Effect, Option, Schema } from "effect";
import { repairDashboardProjection } from "../transactions/operations";
import { DashboardDocument } from "../../src/core/dashboard/contract";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { ToolCallId, TranscriptTurnId } from "../../src/core/agent/contract";
import { executeCanonicalWork } from "../canonical-operations/operations";
import { OperationResponse } from "../../src/shell/public-http/contract";
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

const setup = (
  database: Option.Option<D1Database> = Option.none()
): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Option.match(database, {
      onNone: () => Effect.tryPromise(() => databases.acquire()),
      onSome: Effect.succeed,
    });
    yield* Effect.tryPromise(() =>
      installTestSchema({
        db,
        sources: Array.from(
          new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
        )
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

const coordinatorByDatabase = new WeakMap<D1Database, Map<string, UserTransactionCoordinator>>();
const coordinatorObservers = new WeakMap<D1Database, (operation: string) => void>();
const send = (
  db: D1Database,
  credential: number | string,
  pathAndBody: string | Readonly<{ path: string; method: "POST" | "PUT"; body: object }>
): Promise<Response> =>
  publicWorker.fetch(
    new Request(
      `https://api.fidyapp.com${typeof pathAndBody === "string" ? pathAndBody : pathAndBody.path}`,
      {
        method: typeof pathAndBody === "string" ? "GET" : pathAndBody.method,
        headers: {
          origin: "https://app.fidyapp.com",
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
const InitializedReply = Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) });
const initialize = (db: D1Database, credential: number | string = 0): Promise<Response> =>
  send(db, credential, { path: "/dashboard/initialize", method: "POST", body: {} });

it.each(["individual", "batch"] as const)(
  "encodes %s initialization continuations as canonical JSON without internal Option values",
  (mode) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const response = yield* Effect.tryPromise(() =>
          mode === "individual"
            ? initialize(db)
            : batch(db, [batchCall("dashboard.initializeDashboard", {}, 1)])
        );
        expect(response.status).toBe(200);
        const body: unknown = yield* Effect.tryPromise(() => response.json());
        const output =
          mode === "individual"
            ? body
            : (yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  data: Schema.Struct({
                    results: Schema.Array(Schema.Struct({ output: Schema.Unknown })),
                  }),
                })
              )(body)).data.results[0]?.output;
        const codec = Schema.toCodecJson(OperationResponse(DashboardDocument));
        const decoded = yield* Schema.decodeUnknownEffect(codec)(output);
        expect(yield* Schema.encodeEffect(codec)(decoded)).toEqual(output);
        expect(
          decoded.next.find((suggestion) => suggestion.tool === "dashboard.applyDashboardEdit")
        ).toMatchObject({ args: Option.none() });
      })
    )
);
const batchCall = (operation: string, input: object, index: number): object => ({
  callId: `30000000-0000-4000-8000-00000000000${index}`,
  operation,
  input,
});
const batch = (db: D1Database, calls: ReadonlyArray<object>): Promise<Response> =>
  send(db, 0, { path: "/operations/atomic-batch", method: "POST", body: { calls } });
const count = (db: D1Database, table: "dashboard_documents" | "dashboard_audit"): Promise<number> =>
  db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`)
    .bind(users[0])
    .first<{ count: number }>()
    .then((row) => row?.count ?? -1);

it("explicitly initializes one valid Dashboard through the canonical browser operation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const response = yield* Effect.tryPromise(() =>
        send(db, 0, { path: "/dashboard/initialize", method: "POST", body: {} })
      );
      expect(response.status).toBe(200);
      const reply = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
      )(yield* Effect.tryPromise(() => response.json()));
      expect(reply.data.title).toBe("Tablero");
      expect(reply.data.layout.kind).toBe("split");
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(1);
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(1);
    })
  ));

it("offers only caller-authorized next operations after individual and batched initialization", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const token = `fin_${"i".repeat(8)}_${"n".repeat(43)}`;
      yield* seedPAT(db, { token, scope: "dashboard", id: "30000000-0000-4000-8000-000000000073" });
      const nextTools = Schema.Struct({
        next: Schema.Array(Schema.Struct({ tool: Schema.String })),
      });
      const pat = yield* Effect.tryPromise(() =>
        send(db, token, { path: "/dashboard/initialize", method: "POST", body: {} })
      );
      expect(pat.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(nextTools)(
          yield* Effect.tryPromise(() => pat.json())
        )).next.map((suggestion) => suggestion.tool)
      ).toEqual(["dashboard.applyDashboardEdit"]);
      const web = yield* Effect.tryPromise(() =>
        batch(db, [batchCall("dashboard.initializeDashboard", {}, 1)])
      );
      expect(web.status).toBe(200);
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.Struct({ results: Schema.Array(Schema.Struct({ output: nextTools })) }),
        })
      )(yield* Effect.tryPromise(() => web.json()));
      expect(result.data.results[0]?.output.next.map((suggestion) => suggestion.tool)).toEqual([
        "dashboard.getDashboardView",
        "dashboard.applyDashboardEdit",
      ]);
    })
  ));

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

it("rejects a supplied foreign User or Widget identity without initializing either User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const foreign = { userId: users[1], widgetId: "30000000-0000-4000-8000-000000000099" };
      const individual = yield* Effect.tryPromise(() =>
        send(db, 0, { path: "/dashboard/initialize", method: "POST", body: foreign })
      );
      expect(individual.status).toBe(400);
      const batched = yield* Effect.tryPromise(() =>
        batch(db, [batchCall("dashboard.initializeDashboard", foreign, 1)])
      );
      expect(batched.status).toBe(400);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT COUNT(*) AS count FROM dashboard_documents").first<{ count: number }>()
        )
      ).toEqual({ count: 0 });
    })
  ));

it(
  "persists one Dashboard child through the public atomic batch and rolls back a failed sibling",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const rejected = yield* Effect.tryPromise(() =>
          batch(db, [
            batchCall("dashboard.getDashboard", {}, 1),
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
          batch(db, [batchCall("dashboard.getDashboardView", {}, 3)])
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
            batchCall("dashboard.getDashboard", {}, 4),
            batchCall("dashboard.getDashboardView", {}, 5),
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

it("retains concurrent initialization identities and never resets later edits or revision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const replies = yield* Effect.tryPromise(() =>
        Promise.all(Array.from({ length: 8 }, () => initialize(db)))
      );
      const documents = yield* Effect.forEach(replies, (reply) => {
        expect(reply.status).toBe(200);
        return Effect.tryPromise(() => reply.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(InitializedReply))
        );
      });
      expect(
        documents.every((reply) => JSON.stringify(reply) === JSON.stringify(documents[0]))
      ).toBe(true);
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT revision FROM dashboard_documents WHERE user_id = ?")
            .bind(users[0])
            .first()
        )
      ).toEqual({ revision: 1 });
      const edited = yield* Effect.tryPromise(() =>
        send(db, 0, {
          path: "/dashboard/edits",
          method: "POST",
          body: { op: "set-title", title: "Keep my layout" },
        })
      );
      expect(edited.status).toBe(200);
      const before = yield* Schema.decodeUnknownEffect(InitializedReply)(
        yield* Effect.tryPromise(() => edited.json())
      );
      const repeated = yield* Effect.tryPromise(() => initialize(db));
      expect(repeated.status).toBe(200);
      expect(
        yield* Schema.decodeUnknownEffect(InitializedReply)(
          yield* Effect.tryPromise(() => repeated.json())
        )
      ).toEqual(before);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT revision FROM dashboard_documents WHERE user_id = ?")
            .bind(users[0])
            .first()
        )
      ).toEqual({ revision: 2 });
      const neighbor = yield* Effect.tryPromise(() => initialize(db, 1));
      expect(neighbor.status).toBe(200);
      const other = yield* Schema.decodeUnknownEffect(InitializedReply)(
        yield* Effect.tryPromise(() => neighbor.json())
      );
      expect(other.data.title).toBe("Tablero");
      expect(other.data.layout).not.toEqual(before.data.layout);
      const owner = yield* Effect.tryPromise(() =>
        batch(db, [batchCall("dashboard.initializeDashboard", {}, 2)])
      );
      expect(owner.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(BatchDashboard)(
          yield* Effect.tryPromise(() => owner.json())
        )).data.results[0]?.output.data.title
      ).toBe("Keep my layout");
    })
  ));

it(
  "serializes racing initializers in a real Durable Object while D1 retains one document",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bundle = yield* Effect.tryPromise(() =>
            Bun.build({
              entrypoints: [new URL("../coordinator-test-harness.ts", import.meta.url).pathname],
              target: "browser",
            })
          );
          const output = bundle.outputs[0];
          if (!bundle.success || output === undefined) {
            throw new Error("Coordinator fixture bundle unavailable");
          }
          const source = yield* Effect.tryPromise(() => output.text());
          const runtime = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Miniflare({
                  workers: [
                    {
                      config: {
                        name: "dashboard-initialization",
                        type: "worker",
                        compatibilityDate: "2026-09-08",
                        exports: {
                          UserTransactionCoordinator: { type: "durable-object", storage: "sqlite" },
                        },
                        env: {
                          DB: { id: "dashboard-initialization", type: "d1" },
                          USER_TRANSACTION_COORDINATOR: {
                            type: "durable-object",
                            worker: "dashboard-initialization",
                            exportName: "UserTransactionCoordinator",
                          },
                          AI: { type: "json", value: { run: null } },
                          HOSTED_AI_MODEL: { type: "text", value: approvedWorkersAiModel },
                        },
                        manifest: {
                          mainModule: "index.mjs",
                          modules: { "index.mjs": { contents: source, type: "esm" } },
                        },
                      },
                    },
                  ],
                })
            ),
            (value) => Effect.tryPromise(() => value.dispose()).pipe(Effect.orDie)
          );
          const database = yield* Effect.tryPromise(() => runtime.getD1Database("DB"));
          const db = yield* setup(Option.some(database));
          const namespace = yield* Effect.tryPromise(() =>
            runtime.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR")
          );
          const proof = Array.from(yield* Effect.tryPromise(() => digest(bearer(0))));
          const capture = (response: {
            status: number;
            json: () => Promise<unknown>;
          }): Promise<Readonly<{ status: number; body: unknown }>> =>
            response.json().then((body) => ({ status: response.status, body }));
          const results = yield* Effect.tryPromise(() =>
            Promise.all(
              Array.from({ length: 6 }, (_, index) =>
                namespace
                  .getByName(users[0] ?? "")
                  .fetch("https://coordinator.internal/canonical-work", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      _tag: "WebSessionWork",
                      userId: users[0],
                      sessionId: sessions[0],
                      digest: proof,
                      work:
                        index % 2 === 0
                          ? { _tag: "Call", operation: "dashboard.initializeDashboard", input: {} }
                          : {
                              _tag: "Batch",
                              calls: [batchCall("dashboard.initializeDashboard", {}, index)],
                            },
                    }),
                  })
                  .then(capture)
              )
            )
          );
          expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200, 200]);
          const documents = results.map((result, index) =>
            index % 2 === 0
              ? Schema.decodeUnknownSync(InitializedReply)(result.body).data
              : Schema.decodeUnknownSync(
                  Schema.Struct({
                    data: Schema.Struct({
                      results: Schema.Array(Schema.Struct({ output: InitializedReply })),
                    }),
                  })
                )(result.body).data.results[0]?.output.data
          );
          expect(
            documents.every((document) => JSON.stringify(document) === JSON.stringify(documents[0]))
          ).toBe(true);
          expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(1);
          expect(
            yield* Effect.tryPromise(() =>
              db
                .prepare("SELECT revision FROM dashboard_documents WHERE user_id = ?")
                .bind(users[0])
                .first()
            )
          ).toEqual({ revision: 1 });
          expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(6);
        })
      )
    ),
  30_000
);

it("returns the committed winner when another initializer creates the document before its insert", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      let firstCommit = true;
      let winner = Option.none<DashboardDocument>();
      const runAtBoundary = Effect.runPromiseWith(yield* Effect.context<never>());
      const win = (): Promise<void> =>
        runAtBoundary(
          Effect.gen(function* () {
            const initialized = yield* Effect.tryPromise(() => initialize(db));
            expect(initialized.status).toBe(200);
            const edited = yield* Effect.tryPromise(() =>
              send(db, 0, {
                path: "/dashboard/edits",
                method: "POST",
                body: { op: "set-title", title: "Winning layout" },
              })
            );
            expect(edited.status).toBe(200);
            winner = Option.some(
              (yield* Schema.decodeUnknownEffect(InitializedReply)(
                yield* Effect.tryPromise(() => edited.json())
              )).data
            );
          })
        );
      const racing: D1Database = {
        prepare: (sql) => db.prepare(sql),
        batch: (statements) => {
          if (!firstCommit) return db.batch(statements);
          firstCommit = false;
          return win().then(() => db.batch(statements));
        },
        exec: (sql) => db.exec(sql),
        withSession: (constraint) => db.withSession(constraint),
        dump: () => db.dump(),
      };
      const response = yield* executeCanonicalWork({
        db: racing,
        current: DateTime.nowUnsafe().epochMilliseconds,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        subject: {
          userId: users[0] ?? "",
          id: sessions[0] ?? "",
          digest: yield* Effect.tryPromise(() => digest(bearer(0))),
        },
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("dashboard.initializeDashboard"),
          input: {},
        },
      });
      expect(response.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(InitializedReply)(
          yield* Effect.tryPromise(() => response.json())
        )).data
      ).toEqual(Option.getOrThrow(winner));
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT revision FROM dashboard_documents WHERE user_id = ?")
            .bind(users[0])
            .first()
        )
      ).toEqual({ revision: 2 });
    })
  ));

it.each(["read", "write"] as const)(
  "refuses a %s-only PAT individually and in a batch without a document effect",
  (scope) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const token = `fin_${"s".repeat(8)}_${"c".repeat(43)}`;
        yield* seedPAT(db, { token, scope, id: "30000000-0000-4000-8000-000000000074" });
        expect((yield* Effect.tryPromise(() => initialize(db, token))).status).toBe(403);
        const rejected = yield* Effect.tryPromise(() =>
          send(db, token, {
            path: "/operations/atomic-batch",
            method: "POST",
            body: { calls: [batchCall("dashboard.initializeDashboard", {}, 1)] },
          })
        );
        expect(rejected.status).toBe(400);
        expect(
          (yield* Schema.decodeUnknownEffect(BatchFailure)(
            yield* Effect.tryPromise(() => rejected.json())
          )).error
        ).toMatchObject({ code: "scope_missing", failedCallIndex: 0 });
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM pat_audit WHERE operation = 'dashboard.initializeDashboard' AND outcome = 'accepted'"
              )
              .first()
          )
        ).toEqual({ count: 0 });
      })
    )
);

it("rechecks the declared initialization scope when a native call supplies a weaker admission scope", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const token = `fin_${"n".repeat(8)}_${"a".repeat(43)}`;
      const patId = "30000000-0000-4000-8000-000000000075";
      yield* seedPAT(db, { token, scope: "read", id: patId });
      const response = yield* executeCanonicalWork({
        db,
        current: DateTime.nowUnsafe().epochMilliseconds,
        bucket: Option.none(),
        hostedFence: Option.none(),
        inference: Option.none(),
        subject: {
          userId: users[0] ?? "",
          patId,
          digest: yield* Effect.tryPromise(() => digest(token)),
          requiredScope: Option.some("read"),
        },
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("dashboard.initializeDashboard"),
          input: {},
        },
      });
      expect(response.status).not.toBe(200);
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM pat_audit WHERE operation = 'dashboard.initializeDashboard' AND outcome = 'accepted'"
            )
            .first()
        )
      ).toEqual({ count: 0 });
    })
  ));

it("refuses colliding initialization children and rolls back an otherwise valid earlier child", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const response = yield* Effect.tryPromise(() =>
        batch(db, [
          batchCall("dashboard.initializeDashboard", {}, 1),
          batchCall(
            "dashboard.applyDashboardEdit",
            { payload: { op: "set-title", title: "Not committed" } },
            2
          ),
        ])
      );
      expect(response.status).toBe(400);
      expect(
        (yield* Schema.decodeUnknownEffect(BatchFailure)(
          yield* Effect.tryPromise(() => response.json())
        )).error
      ).toMatchObject({ code: "validation_failed", failedCallIndex: 1 });
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
    })
  ));

it("refuses explicit initialization over malformed stored state without replacing it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO dashboard_documents (user_id, document_json, revision) VALUES (?, '{}', 9)"
          )
          .bind(users[0])
          .run()
      );
      expect((yield* Effect.tryPromise(() => initialize(db))).status).toBe(503);
      const response = yield* Effect.tryPromise(() =>
        batch(db, [batchCall("dashboard.initializeDashboard", {}, 1)])
      );
      expect(response.status).toBe(503);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT document_json, revision FROM dashboard_documents WHERE user_id = ?")
            .bind(users[0])
            .first()
        )
      ).toEqual({ document_json: "{}", revision: 9 });
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
    })
  ));

it("does not initialize a default whose stable Category is unavailable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      yield* Effect.tryPromise(() =>
        db.prepare("DELETE FROM categories WHERE id = '10000000-0000-4000-8000-000000000001'").run()
      );
      expect((yield* Effect.tryPromise(() => initialize(db))).status).toBe(503);
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
    })
  ));

it.each(["individual", "batch"] as const)(
  "rolls back %s initialization when required PAT accountability cannot be written",
  (mode) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const token = `fin_${"p".repeat(8)}_${"a".repeat(43)}`;
        const patId = "30000000-0000-4000-8000-000000000076";
        yield* seedPAT(db, { token, scope: "dashboard", id: patId });
        yield* Effect.tryPromise(() =>
          db
            .prepare(`CREATE TRIGGER reject_initialization_audit BEFORE INSERT ON pat_audit
        WHEN NEW.operation = 'dashboard.initializeDashboard' AND NEW.outcome = 'accepted'
        BEGIN SELECT RAISE(ABORT, 'test_audit_unavailable'); END`)
            .run()
        );
        const response = yield* Effect.tryPromise(() =>
          mode === "individual"
            ? initialize(db, token)
            : send(db, token, {
                path: "/operations/atomic-batch",
                method: "POST",
                body: { calls: [batchCall("dashboard.initializeDashboard", {}, 1)] },
              })
        );
        expect(response.status).toBe(503);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
          )
        ).toEqual({ last_used_at_ms: null });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM pat_audit WHERE operation = 'dashboard.initializeDashboard' AND outcome = 'accepted'"
              )
              .first()
          )
        ).toEqual({ count: 0 });
      })
    )
);

it.each(["scope", "revocation", "Consent"] as const)(
  "rechecks live %s at the initialization commit and leaves no partial effect",
  (guard) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const token = `fin_${"g".repeat(8)}_${"a".repeat(43)}`;
        const patId = "30000000-0000-4000-8000-000000000077";
        yield* seedPAT(db, { token, scope: "dashboard", id: patId });
        const current = DateTime.nowUnsafe().epochMilliseconds;
        const invalidate = (): Promise<unknown> => {
          if (guard === "scope") {
            return db
              .prepare("UPDATE pats SET scopes_json = '[\"read\"]' WHERE id = ?")
              .bind(patId)
              .run();
          }
          if (guard === "revocation") {
            return db
              .prepare("UPDATE pats SET revoked_at_ms = ? WHERE id = ?")
              .bind(current, patId)
              .run();
          }
          return db.batch([
            db
              .prepare(`INSERT INTO onboarding_consent_records (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
                VALUES ('30000000-0000-4000-8000-000000000080',?,'{}','disclosure','decision',?,?)`)
              .bind(users[0], current, current),
            db
              .prepare(`INSERT INTO consent_user_revocations (id,user_id,grant_record_id,session_id,occurred_at_ms)
                VALUES ('30000000-0000-4000-8000-000000000081',?,'30000000-0000-4000-8000-000000000080',?,?)`)
              .bind(users[0], sessions[0], current),
          ]);
        };
        let invalidateOnce = true;
        const racing: D1Database = {
          prepare: (sql) => db.prepare(sql),
          batch: (statements) => {
            if (!invalidateOnce) return db.batch(statements);
            invalidateOnce = false;
            return invalidate().then(() => db.batch(statements));
          },
          exec: (sql) => db.exec(sql),
          withSession: (constraint) => db.withSession(constraint),
          dump: () => db.dump(),
        };
        const response = yield* executeCanonicalWork({
          db: racing,
          current,
          bucket: Option.none(),
          hostedFence: Option.none(),
          inference: Option.none(),
          subject: {
            userId: users[0] ?? "",
            patId,
            digest: yield* Effect.tryPromise(() => digest(token)),
            requiredScope: Option.some("dashboard"),
          },
          work: {
            _tag: "Call",
            operation: CanonicalOperationId.make("dashboard.initializeDashboard"),
            input: {},
          },
        });
        expect(response.status).not.toBe(200);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(0);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
          )
        ).toEqual({ last_used_at_ms: null });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM pat_audit WHERE operation = 'dashboard.initializeDashboard' AND outcome = 'accepted'"
              )
              .first()
          )
        ).toEqual({ count: 0 });
      })
    )
);

it("rejects a native foreign-User credential individually and in a batch before document effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      for (const work of [
        {
          _tag: "Call",
          operation: CanonicalOperationId.make("dashboard.initializeDashboard"),
          input: {},
        },
        { _tag: "Batch", calls: [batchCall("dashboard.initializeDashboard", {}, 1)] },
      ] as const) {
        const response = yield* executeCanonicalWork({
          db,
          current: DateTime.nowUnsafe().epochMilliseconds,
          bucket: Option.none(),
          hostedFence: Option.none(),
          inference: Option.none(),
          subject: {
            userId: users[1] ?? "",
            id: sessions[0] ?? "",
            digest: yield* Effect.tryPromise(() => digest(bearer(0))),
          },
          work,
        });
        expect(response.status).not.toBe(200);
      }
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT COUNT(*) AS count FROM dashboard_documents").first()
        )
      ).toEqual({ count: 0 });
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(0);
    })
  ));

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
        expect(denied.status).toBe(400);
        expect(
          (yield* Schema.decodeUnknownEffect(BatchFailure)(
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
        expect(allowed.status).toBe(200);
        expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(1);
      })
    ),
  30_000
);

it("commits hosted initialization with its exact Turn and refuses a foreign Turn without a document", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const current = DateTime.nowUnsafe().epochMilliseconds;
      const hostedSession = "30000000-0000-4000-8000-000000000085";
      const turnId = TranscriptTurnId.make("30000000-0000-4000-8000-000000000086");
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO onboarding_consent_records (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES ('30000000-0000-4000-8000-000000000087',?,'{}','disclosure','decision',?,?)"
            )
            .bind(users[0], current, current),
          db
            .prepare(
              "INSERT INTO hosted_agent_sessions (id, user_id, consent_basis_json, started_at_ms, status) VALUES (?, ?, '{}', ?, 'active')"
            )
            .bind(hostedSession, users[0], current),
          db
            .prepare(
              "INSERT INTO hosted_turns (id, user_id, hosted_session_id, started_at_ms, status) VALUES (?, ?, ?, ?, 'pending')"
            )
            .bind(turnId, users[0], hostedSession, current),
        ])
      );
      const invoke = (index: number): Effect.Effect<Response, Cause.UnknownError> =>
        Effect.gen(function* () {
          return yield* executeCanonicalWork({
            db,
            current,
            bucket: Option.none(),
            inference: Option.none(),
            hostedFence: Option.some({
              turnId,
              toolCallId: ToolCallId.make(`initialize-${index}`),
            }),
            subject: {
              userId: users[index] ?? "",
              id: sessions[index] ?? "",
              digest: yield* Effect.tryPromise(() => digest(bearer(index))),
            },
            work: {
              _tag: "Call",
              operation: CanonicalOperationId.make("dashboard.initializeDashboard"),
              input: {},
            },
          });
        });
      expect((yield* invoke(1)).status).toBe(503);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT COUNT(*) AS count FROM dashboard_documents").first()
        )
      ).toEqual({ count: 0 });
      const accepted = yield* invoke(0);
      expect(accepted.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(InitializedReply)(
          yield* Effect.tryPromise(() => accepted.json())
        )).data.title
      ).toBe("Tablero");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT user_id, tool_call_id FROM hosted_mutation_commits WHERE turn_id = ?")
            .bind(turnId)
            .all()
        ).pipe(Effect.map((result) => result.results))
      ).toEqual([{ user_id: users[0], tool_call_id: "initialize-0" }]);
      expect((yield* invoke(0)).status).toBe(503);
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_documents"))).toBe(1);
      expect(yield* Effect.tryPromise(() => count(db, "dashboard_audit"))).toBe(1);
    })
  ));

it(
  "does not report a skipped Dashboard revision as a successful edit",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const created = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
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

it.each(["dashboard.getDashboard", "dashboard.initializeDashboard"] as const)(
  "rolls back a Dashboard child when a later owner's guarded audit aborts the D1 batch",
  (operation) =>
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
            batchCall(operation, {}, 8),
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

it.each(["dashboard.getDashboard", "dashboard.initializeDashboard"] as const)(
  "rolls back first-use Dashboard persistence when its success Audit cannot commit",
  (operation) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() =>
          db
            .prepare(`CREATE TRIGGER reject_dashboard_success BEFORE INSERT ON dashboard_audit
    WHEN NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test_audit_unavailable'); END`)
            .run()
        );
        const reply = yield* Effect.tryPromise(() => batch(db, [batchCall(operation, {}, 6)]));
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
        const first = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
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
        const other = yield* Effect.tryPromise(() => send(db, 1, "/dashboard"));
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
        const before = (yield* Effect.tryPromise(() => send(db, 0, "/dashboard"))).status;
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
        const db = yield* setup();
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
        const documentResponse8 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
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
        const db = yield* setup();
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
        const documentResponse10 = yield* Effect.tryPromise(() => send(db, 0, "/dashboard"));
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
        const db = yield* setup();
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
        const db = yield* setup();
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
        expect(before?.count).toBe(0);
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
        const db = yield* setup();
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
        const db = yield* setup();
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
        const db = yield* setup();
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
        const db = yield* setup();
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
        const db = yield* setup();
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
        const db = yield* setup();
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
        const db = yield* setup();
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

it(
  "keeps one exact day chart when a concurrent Correction moves a Transaction between buckets",
  () =>
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
        const pendingView = send(delayed, 0, "/dashboard/view");
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
        expect(
          yield* chart(yield* Effect.tryPromise(() => send(delayed, 0, "/dashboard/view")))
        ).toEqual([{ date: localDate(second), amount: "10" }]);
      })
    ),
  30_000
);
