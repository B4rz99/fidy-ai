import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { BigDecimal, DateTime, Schema } from "effect";
import { DashboardDocument } from "../../src/core/dashboard/model";
import { Transaction } from "../../src/core/transactions/model";
import { DashboardView } from "../../src/shell/dashboard/operations";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import coreWorker from "../core-worker";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";
import publicWorker from "../public-worker";

const users = ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000052"];
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
const instances: Array<Miniflare> = [];
let sequence = 0;
const bearer = (index: number): string => String(index + 1).repeat(43);
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));

// @effect-diagnostics-next-line asyncFunction:off
const migrate = async (db: D1Database, name: string): Promise<void> => {
  const sql = await Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text();
  const statements = sql
    .replace(/^--.*$/gmu, "")
    .trim()
    .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u);
  await statements.reduce<Promise<void>>(
    (previous, statement) =>
      previous.then(() =>
        db
          .prepare(statement)
          .run()
          .then(() => undefined)
      ),
    Promise.resolve()
  );
};

// @effect-diagnostics-next-line asyncFunction:off
const seedUser = async ({
  db,
  user,
  index,
  current,
}: Readonly<{
  db: D1Database;
  user: string;
  index: number;
  current: number;
}>): Promise<void> => {
  await db
    .prepare(
      "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
    )
    .bind(user, current)
    .run();
  await db
    .prepare(
      "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
    )
    .bind(
      `10000000-0000-4000-8000-00000000007${index}`,
      `ABCD-123${index}`,
      await digest(`verifier${index}`),
      user,
      current,
      current + 600000
    )
    .run();
  await db
    .prepare(
      "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      sessions[index],
      `10000000-0000-4000-8000-00000000007${index}`,
      user,
      await digest(bearer(index)),
      current,
      current + 600000,
      current + 3600000,
      current + 7776000000
    )
    .run();
};

// @effect-diagnostics-next-line asyncFunction:off
const setup = async (): Promise<D1Database> => {
  const id = `dashboard-${++sequence}`;
  const mf = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id, type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch() {return new Response('ok')}}",
                type: "esm",
              },
            },
          },
          name: id,
          type: "worker",
        },
      },
    ],
  });
  instances.push(mf);
  await mf.ready;
  const db = await mf.getD1Database("DB");
  await [
    "0001_categories",
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
    "0017_statement_dispatch",
    "0018_dashboard",
    "0019_canonical_child_guards",
  ].reduce<Promise<void>>(
    (previous, name) => previous.then(() => migrate(db, name)),
    Promise.resolve()
  );
  const current = DateTime.nowUnsafe().epochMilliseconds;
  await users.reduce<Promise<void>>(
    (previous, user, index) => previous.then(() => seedUser({ db, user, index, current })),
    Promise.resolve()
  );
  return db;
};
afterEach(() => Promise.all(instances.splice(0).map((mf) => mf.dispose())));

// @effect-diagnostics-next-line asyncFunction:off
const seedPAT = async (
  db: D1Database,
  input: Readonly<{ token: string; scope: "read" | "write" | "dashboard"; id: string }>
): Promise<void> => {
  const { token, scope, id } = input;
  const current = DateTime.nowUnsafe().epochMilliseconds;
  await db
    .prepare(`INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json, lifetime_days,
    created_at_ms, issued_at_ms, expires_at_ms, request_id)
    VALUES (?, ?, ?, ?, 'Dashboard security fixture', ?, 7, ?, ?, ?, ?)`)
    .bind(
      id,
      users[0],
      token.slice(4, 12),
      await digest(token),
      JSON.stringify([scope]),
      current,
      current,
      current + 7 * 86400000,
      id.replace("8000", "9000")
    )
    .run();
};

const coordinatorByDatabase = new WeakMap<D1Database, Map<string, UserTransactionCoordinator>>();
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

// @effect-diagnostics-next-line asyncFunction:off
it("a first invalid or missing Dashboard edit records only its refusal and never persists a document", async () => {
  const db = await setup();
  const invalid = await send(db, 0, {
    path: "/dashboard/edits",
    method: "POST",
    body: { op: "set-title", title: "" },
  });
  expect(invalid.status).toBe(400);
  const missing = await send(db, 0, {
    path: "/dashboard/edits",
    method: "POST",
    body: {
      op: "remove-widget",
      widgetId: "30000000-0000-4000-8000-000000000099",
    },
  });
  expect(missing.status).toBe(404);
  expect(await count(db, "dashboard_documents")).toBe(0);
  const rows = await db
    .prepare("SELECT operation, outcome FROM dashboard_audit WHERE user_id = ? ORDER BY rowid")
    .bind(users[0])
    .all();
  expect(rows.results).toEqual([
    { operation: "dashboard.applyDashboardEdit", outcome: "rejected" },
    { operation: "dashboard.applyDashboardEdit", outcome: "rejected" },
  ]);
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("persists one Dashboard child through the public atomic batch and rolls back a failed sibling", async () => {
  const db = await setup();
  const rejected = await batch(db, [
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
  ]);
  expect(rejected.status).toBe(400);
  expect(Schema.decodeUnknownSync(BatchFailure)(await rejected.json()).error).toMatchObject({
    operation: "dashboard.applyDashboardEdit",
    failedCallIndex: 1,
    code: "not_found",
  });
  expect(await count(db, "dashboard_documents")).toBe(0);
  expect(await count(db, "dashboard_audit")).toBe(1);
  const accepted = await batch(db, [batchCall("dashboard.getDashboardView", {}, 3)]);
  expect(accepted.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(BatchDashboard)(await accepted.json()).data.results[0]?.output.data
      .title
  ).toBe("Tablero");
  expect(await count(db, "dashboard_documents")).toBe(1);
  const repeated = await batch(db, [
    batchCall("dashboard.getDashboard", {}, 4),
    batchCall("dashboard.getDashboardView", {}, 5),
  ]);
  expect(repeated.status).toBe(400);
  expect(Schema.decodeUnknownSync(BatchFailure)(await repeated.json()).error).toMatchObject({
    failedCallIndex: 1,
    code: "validation_failed",
  });
  expect(await count(db, "dashboard_audit")).toBe(2);
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("keeps Dashboard read and edit scopes distinct inside atomic batches", async () => {
  const db = await setup();
  const token = `fin_${"r".repeat(8)}_${"c".repeat(43)}`;
  await seedPAT(db, { token, scope: "read", id: "30000000-0000-4000-8000-000000000071" });
  const denied = await send(db, token, {
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
  });
  expect(denied.status).toBe(400);
  expect(Schema.decodeUnknownSync(BatchFailure)(await denied.json()).error.code).toBe(
    "scope_missing"
  );
  expect(await count(db, "dashboard_documents")).toBe(0);
  expect(await count(db, "dashboard_audit")).toBe(0);
  const allowed = await send(db, token, {
    path: "/operations/atomic-batch",
    method: "POST",
    body: {
      calls: [batchCall("dashboard.getDashboard", {}, 2)],
    },
  });
  expect(allowed.status).toBe(200);
  expect(await count(db, "dashboard_documents")).toBe(1);
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("does not report a skipped Dashboard revision as a successful edit", async () => {
  const db = await setup();
  const created = await send(db, 0, "/dashboard");
  expect(created.status).toBe(200);
  await db
    .prepare(`CREATE TRIGGER ignore_dashboard_update BEFORE UPDATE ON dashboard_documents
    BEGIN SELECT RAISE(IGNORE); END`)
    .run();
  const response = await send(db, 0, {
    path: "/dashboard/edits",
    method: "POST",
    body: {
      op: "set-title",
      title: "Not written",
    },
  });
  expect(response.status).not.toBe(200);
  expect(
    Schema.decodeUnknownSync(DocumentReply)(await (await send(db, 0, "/dashboard")).json()).data
      .title
  ).toBe("Tablero");
  expect(await count(db, "dashboard_audit")).toBe(2);
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("rolls back a Dashboard child when a later owner's guarded audit aborts the D1 batch", async () => {
  const db = await setup();
  await db
    .prepare(`CREATE TRIGGER reject_budget_success BEFORE INSERT ON budget_audit
    WHEN NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test_budget_unavailable'); END`)
    .run();
  const reply = await batch(db, [
    batchCall("dashboard.getDashboard", {}, 8),
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
  ]);
  expect(reply.status).toBe(503);
  expect(await count(db, "dashboard_documents")).toBe(0);
  expect(await count(db, "dashboard_audit")).toBe(0);
  const budget = await db
    .prepare("SELECT COUNT(*) AS count FROM budgets WHERE user_id = ?")
    .bind(users[0])
    .first<{ count: number }>();
  expect(budget?.count).toBe(0);
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("rolls back first-use Dashboard persistence when its success Audit cannot commit", async () => {
  const db = await setup();
  await db
    .prepare(`CREATE TRIGGER reject_dashboard_success BEFORE INSERT ON dashboard_audit
    WHEN NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'test_audit_unavailable'); END`)
    .run();
  const reply = await batch(db, [batchCall("dashboard.getDashboard", {}, 6)]);
  expect(reply.status).toBe(503);
  expect(await count(db, "dashboard_documents")).toBe(0);
  expect(await count(db, "dashboard_audit")).toBe(0);
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("a first valid edit commits the default and edit in the same unit for individual and batch callers", async () => {
  const db = await setup();
  const edited = await send(db, 0, {
    path: "/dashboard/edits",
    method: "POST",
    body: {
      op: "set-title",
      title: "Individual",
    },
  });
  expect(edited.status).toBe(200);
  expect(Schema.decodeUnknownSync(DocumentReply)(await edited.json()).data.title).toBe(
    "Individual"
  );
  const second = await batch(db, [
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
  ]);
  expect(second.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(BatchDashboard)(await second.json()).data.results[0]?.output.data.title
  ).toBe("Batch");
  expect(
    Schema.decodeUnknownSync(DocumentReply)(await (await send(db, 0, "/dashboard")).json()).data
      .title
  ).toBe("Batch");
  expect(await count(db, "dashboard_documents")).toBe(1);
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("creates a valid DashboardDocument for each User without sharing later edits", async () => {
  const db = await setup();
  const first = await send(db, 0, "/dashboard");
  expect(first.status).toBe(200);
  const body = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
  )(await first.json());
  const document = body.data;
  expect(document.title).toBe("Tablero");
  const edited = await send(db, 0, {
    path: "/dashboard/edits",
    method: "POST",
    body: {
      op: "set-title",
      title: "Mi tablero",
    },
  });
  expect(edited.status).toBe(200);
  const other = await send(db, 1, "/dashboard");
  expect(other.status).toBe(200);
  const otherBody = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
  )(await other.json());
  expect(otherBody.data.title).toBe("Tablero");
  const after = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
  )(await (await send(db, 0, "/dashboard")).json());
  expect(after.data.title).toBe("Mi tablero");
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("rejects a malformed layout edit without replacing the authenticated User's document", async () => {
  const db = await setup();
  const before = (await send(db, 0, "/dashboard")).status;
  expect(before).toBe(200);
  const invalid = await send(db, 0, {
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
  });
  expect(invalid.status).toBe(400);
  const document = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
  )(await (await send(db, 0, "/dashboard")).json());
  expect(document.data.title).toBe("Tablero");
  expect(document.data.layout.kind).toBe("split");
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("cannot remove another User's Widget using a known WidgetId", async () => {
  const db = await setup();
  const owned = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
  )(await (await send(db, 0, "/dashboard")).json()).data;
  const widgets = (node: DashboardDocument["layout"]): ReadonlyArray<string> =>
    node.kind === "leaf" ? [node.widget.id] : node.children.flatMap((child) => widgets(child.node));
  const foreignId = widgets(owned.layout)[0];
  expect(foreignId).toBeDefined();
  const refused = await send(db, 1, {
    path: "/dashboard/edits",
    method: "POST",
    body: {
      op: "remove-widget",
      widgetId: foreignId,
    },
  });
  expect(refused.status).toBe(404);
  const after = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
  )(await (await send(db, 0, "/dashboard")).json()).data;
  expect(widgets(after.layout)).toEqual(widgets(owned.layout));
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("renders an empty validated DashboardView with current User context", async () => {
  const db = await setup();
  const result = await send(db, 0, "/dashboard/view");
  expect(result.status).toBe(200);
  const body = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.toCodecJson(DashboardView) }))(
    await result.json()
  );
  expect(body.data.context).toMatchObject({
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
  });
  expect(body.data.layout.kind).toBe("split");
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("finds a recent Transaction by its captured notes in a configured list Widget", async () => {
  const db = await setup();
  const document = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
  )(await (await send(db, 0, "/dashboard")).json()).data;
  const leaves = (node: DashboardDocument["layout"]): ReadonlyArray<DashboardDocument["layout"]> =>
    node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
  const list = leaves(document.layout).find(
    (node) => node.kind === "leaf" && node.widget.type === "transaction-list"
  );
  if (list?.kind !== "leaf" || list.widget.type !== "transaction-list") {
    throw new Error("Missing list");
  }
  const edited = await send(db, 0, {
    path: "/dashboard/edits",
    method: "POST",
    body: {
      op: "update-widget",
      widget: { ...list.widget, search: "private note" },
    },
  });
  expect(edited.status).toBe(200);
  const created = await send(db, 0, {
    path: "/transactions",
    method: "POST",
    body: {
      money: { amount: "1.01", currency: "COP" },
      categoryId: "10000000-0000-4000-8000-000000000001",
      direction: "outflow",
      occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
      notes: "private note",
    },
  });
  expect(created.status).toBe(201);
  const view = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.toCodecJson(DashboardView) }))(
    await (await send(db, 0, "/dashboard/view")).json()
  ).data;
  const viewLeaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
    node.kind === "leaf" ? [node] : node.children.flatMap((child) => viewLeaves(child.node));
  const row = viewLeaves(view.layout).find(
    (node) => node.kind === "leaf" && node.widget.widget.id === list.widget.id
  );
  if (row?.kind !== "leaf" || !("transactions" in row.widget.result)) {
    throw new Error("Missing list result");
  }
  expect(row.widget.result.transactions).toHaveLength(1);
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("projects the current User's Budget with exact outflow spend and remaining Money", async () => {
  const db = await setup();
  const budget = await send(db, 0, {
    path: "/budgets",
    method: "POST",
    body: {
      categoryId: "10000000-0000-4000-8000-000000000001",
      cap: { amount: "100.00", currency: "COP" },
    },
  });
  expect(budget.status).toBe(201);
  const captured = await send(db, 0, {
    path: "/transactions",
    method: "POST",
    body: {
      money: { amount: "25.02", currency: "COP" },
      categoryId: "10000000-0000-4000-8000-000000000001",
      direction: "outflow",
      occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
    },
  });
  expect(captured.status).toBe(201);
  const viewResponse = await send(db, 0, "/dashboard/view");
  expect(viewResponse.status).toBe(200);
  const view = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.toCodecJson(DashboardView) }))(
    await viewResponse.json()
  ).data;
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
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("denies under-scoped and revoked PAT Dashboard work without modifying a document", async () => {
  const db = await setup();
  const readToken = `fin_${"r".repeat(8)}_${"a".repeat(43)}`;
  const writeToken = `fin_${"w".repeat(8)}_${"b".repeat(43)}`;
  const readId = "40000000-0000-4000-8000-000000000091";
  await seedPAT(db, { token: readToken, scope: "read", id: readId });
  await seedPAT(db, {
    token: writeToken,
    scope: "write",
    id: "40000000-0000-4000-8000-000000000092",
  });
  expect((await send(db, writeToken, "/dashboard/view")).status).toBe(403);
  expect(
    (
      await send(db, readToken, {
        path: "/dashboard/edits",
        method: "POST",
        body: {
          op: "set-title",
          title: "Foreign title",
        },
      })
    ).status
  ).toBe(403);
  const before = await db
    .prepare("SELECT COUNT(*) AS count FROM dashboard_documents WHERE user_id = ?")
    .bind(users[0])
    .first<{ count: number }>();
  expect(before?.count).toBe(0);
  expect((await send(db, readToken, "/dashboard/view")).status).toBe(200);
  await db
    .prepare("UPDATE pats SET revoked_at_ms = ? WHERE id = ?")
    .bind(DateTime.nowUnsafe().epochMilliseconds, readId)
    .run();
  expect((await send(db, readToken, "/dashboard/view")).status).not.toBe(200);
  const document = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
  )(await (await send(db, 0, "/dashboard")).json()).data;
  expect(document.title).toBe("Tablero");
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("a stale Dashboard read is replaced by current canonical facts after a Transaction correction", async () => {
  const db = await setup();
  const created = await send(db, 0, {
    path: "/transactions",
    method: "POST",
    body: {
      money: { amount: "10.01", currency: "COP" },
      categoryId: "10000000-0000-4000-8000-000000000001",
      direction: "outflow",
      occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
    },
  });
  expect(created.status).toBe(201);
  const { data: transaction } = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Struct({ id: Transaction.fields.id }) })
  )(await created.json());
  const before = await send(db, 0, "/dashboard/view");
  expect(before.status).toBe(200);
  const correction = await send(db, 0, {
    path: `/transactions/${transaction.id}`,
    method: "PUT",
    body: { expectedRevision: 0, changes: { money: { amount: "25.02", currency: "COP" } } },
  });
  expect(correction.status).toBe(200);
  const after = await send(db, 0, "/dashboard/view");
  expect(after.status).toBe(200);
  const view = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.toCodecJson(DashboardView) }))(
    await after.json()
  ).data;
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
}, 30_000);

// @effect-diagnostics-next-line asyncFunction:off
it("keeps exact Currency totals beyond a small fixed Transaction window", async () => {
  const db = await setup();
  // Spread retained records over days to respect the canonical 100-writes-per-day limit.
  await db
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
    .run();
  const reply = await send(db, 0, "/dashboard/view");
  expect(reply.status).toBe(200);
  const view = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.toCodecJson(DashboardView) }))(
    await reply.json()
  ).data;
  const leaves = (node: DashboardView["layout"]): ReadonlyArray<DashboardView["layout"]> =>
    node.kind === "leaf" ? [node] : node.children.flatMap((child) => leaves(child.node));
  const metric = leaves(view.layout).find(
    (node) => node.kind === "leaf" && node.widget.widget.type === "custom-metric"
  );
  if (metric?.kind !== "leaf" || !("moneyGroups" in metric.widget.result)) {
    throw new Error("Missing metric");
  }
  expect(
    BigDecimal.format(metric.widget.result.moneyGroups[0]?.outflow.amount ?? BigDecimal.make(0n, 0))
  ).toBe("41");
}, 60_000);

// @effect-diagnostics-next-line asyncFunction:off
it("rejects an oversized projection instead of presenting partial Money totals", async () => {
  const db = await setup();
  expect((await send(db, 0, "/dashboard/view")).status).toBe(200);
  // Bypass only the fixture's daily capture quota to exercise the read work budget.
  await db.prepare("DROP TRIGGER transaction_manual_daily_budget").run();
  await db
    .prepare(`INSERT INTO transactions
    (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    WITH RECURSIVE sequence(number) AS (SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < 8193)
    SELECT printf('30000000-0000-4000-8000-%012d', number), ?, '0.01', 'COP', 'outflow', ?, ?, ?
    FROM sequence`)
    .bind(
      users[0],
      "10000000-0000-4000-8000-000000000001",
      DateTime.formatIso(DateTime.nowUnsafe()),
      DateTime.formatIso(DateTime.nowUnsafe())
    )
    .run();
  expect((await send(db, 0, "/dashboard/view")).status).toBe(503);
  const document = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
  )(await (await send(db, 0, "/dashboard")).json()).data;
  expect(document.title).toBe("Tablero");
}, 60_000);

// @effect-diagnostics-next-line asyncFunction:off
it("reads newly committed Transactions as exact separate Currency groups without another User's facts", async () => {
  const db = await setup();
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
  expect((await capture(0, "1.01", "COP")).status).toBe(201);
  expect((await capture(0, "2.02", "COP")).status).toBe(201);
  expect((await capture(0, "5.50", "USD")).status).toBe(201);
  expect((await capture(1, "999", "COP")).status).toBe(201);
  const reply = await send(db, 0, "/dashboard/view");
  expect(reply.status).toBe(200);
  const body = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.toCodecJson(DashboardView) }))(
    await reply.json()
  );
  const leaves = (
    node: DashboardView["layout"]
  ): ReadonlyArray<Extract<DashboardView["layout"], { kind: "leaf" }>["widget"]> =>
    node.kind === "leaf" ? [node.widget] : node.children.flatMap((child) => leaves(child.node));
  const metric = leaves(body.data.layout).find((leaf) => leaf.widget.type === "custom-metric");
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
}, 30_000);
