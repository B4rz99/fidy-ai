import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { DateTime, Schema } from "effect";
import {
  Budget,
  BudgetStatusReport,
  IanaTimeZone,
  deriveCurrentBudgetMonth,
} from "@fidy/server/budgets-runtime";
import { Transaction, encodeMoneyAmount } from "@fidy/server/transactions-runtime";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";

const users = ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000052"];
const category = "10000000-0000-4000-8000-000000000016";
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
let sequence = 0;
const instances: Array<Miniflare> = [];
const bearer = (index: number): string => String(index + 1).repeat(43);
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));
// The Miniflare fixture owns foreign Promise APIs, not application workflow.
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
const seedUser = async (
  db: D1Database,
  input: Readonly<{ user: string; index: number; current: number }>
): Promise<void> => {
  const { user, index, current } = input;
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
  const id = `budgets-${++sequence}`;
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
  const migrations = [
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
  ];
  await migrations.reduce<Promise<void>>(
    (previous, name) => previous.then(() => migrate(db, name)),
    Promise.resolve()
  );
  const current = DateTime.nowUnsafe().epochMilliseconds;
  await users.reduce<Promise<void>>(
    (previous, user, index) => previous.then(() => seedUser(db, { user, index, current })),
    Promise.resolve()
  );
  return db;
};
afterEach(() => Promise.all(instances.splice(0).map((mf) => mf.dispose())));
const coordinatorByDatabase = new WeakMap<D1Database, Map<string, UserTransactionCoordinator>>();
const send = (db: D1Database, request: Request): Promise<Response> => {
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
// @effect-diagnostics-next-line asyncFunction:off
const seedPAT = async (
  db: D1Database,
  input: Readonly<{ token: string; scope: "read" | "write"; id: string }>
): Promise<void> => {
  const { token, scope, id } = input;
  const current = DateTime.nowUnsafe().epochMilliseconds;
  await db
    .prepare(`INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json, lifetime_days,
    created_at_ms, issued_at_ms, expires_at_ms, request_id)
    VALUES (?, ?, ?, ?, 'Budget security fixture', ?, 7, ?, ?, ?, ?)`)
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
// @effect-diagnostics-next-line asyncFunction:off
const seedMonthlyMovements = async (
  db: D1Database,
  input: Readonly<{
    categoryId: string;
    currency: string;
    occurredAt: string;
    count: number;
    offset: number;
  }>
): Promise<void> => {
  await db
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
    .run();
};
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
      "x-provider-id": users[0] ?? "",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};
const payload = (cap = "100"): object => ({
  categoryId: category,
  cap: { amount: cap, currency: "COP" },
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

// @effect-diagnostics-next-line asyncFunction:off
it("creates a positive User-owned Budget and never reveals it to another User", async () => {
  const db = await setup();
  const created = await send(db, request(0, "/budgets", "POST", payload()));
  expect(created.status).toBe(201);
  const body = Schema.decodeUnknownSync(Created)(await created.json());
  expect(encodeMoneyAmount(body.data.cap.amount)).toBe("100");
  const foreign = await send(db, request(1, `/budgets/${body.data.id}`));
  expect(foreign.status).toBe(404);
  const own = await send(db, request(0, `/budgets/${body.data.id}`));
  expect(own.status).toBe(200);
});

// @effect-diagnostics-next-line asyncFunction:off
it("revises a Budget without changing Currency and deletes only its owner's Budget", async () => {
  const db = await setup();
  const created = Schema.decodeUnknownSync(Created)(
    await (await send(db, request(0, "/budgets", "POST", payload()))).json()
  );
  const id = created.data.id;
  const foreign = await send(db, request(1, `/budgets/${id}`, "PUT", payload("200")));
  expect(foreign.status).toBe(404);
  expect((await send(db, request(1, `/budgets/${id}`, "DELETE"))).status).toBe(404);
  const refused = await db
    .prepare("SELECT operation, outcome FROM budget_audit WHERE user_id = ? ORDER BY operation")
    .bind(users[1])
    .all<{ operation: string; outcome: string }>();
  expect(refused.results).toEqual([
    { operation: "budgets.deleteBudget", outcome: "rejected" },
    { operation: "budgets.updateBudget", outcome: "rejected" },
  ]);
  expect((await send(db, request(0, `/budgets/${id}`))).status).toBe(200);
  expect((await send(db, request(0, "/budgets/not-a-budget", "DELETE"))).status).toBe(404);
  expect(
    (
      await send(
        db,
        request(0, "/budgets", "POST", {
          categoryId: category,
          cap: { amount: "-1", currency: "COP" },
        })
      )
    ).status
  ).toBe(400);
  expect((await send(db, request(0, "/budget-status?timeZone=not-a-zone"))).status).toBe(400);
  const invalidAudits = await db
    .prepare(`SELECT operation FROM budget_audit
    WHERE user_id = ? AND outcome = 'rejected' ORDER BY operation`)
    .bind(users[0])
    .all<{ operation: string }>();
  expect(invalidAudits.results.map((row) => row.operation)).toEqual([
    "budgets.createBudget",
    "budgets.deleteBudget",
    "budgets.getBudgetStatus",
  ]);
  const wrongCurrency = await send(
    db,
    request(0, `/budgets/${id}`, "PUT", {
      categoryId: category,
      cap: { amount: "200", currency: "USD" },
    })
  );
  expect(wrongCurrency.status).toBe(400);
  const duplicate = await send(db, request(0, "/budgets", "POST", payload("300")));
  expect(duplicate.status).toBe(400);
  const updated = await send(db, request(0, `/budgets/${id}`, "PUT", payload("250.25")));
  expect(updated.status).toBe(200);
  const changed = Schema.decodeUnknownSync(Created)(await updated.json());
  expect(encodeMoneyAmount(changed.data.cap.amount)).toBe("250.25");
  expect((await send(db, request(0, `/budgets/${id}`, "DELETE"))).status).toBe(200);
  expect((await send(db, request(0, `/budgets/${id}`))).status).toBe(404);
  expect((await send(db, request(1, "/budgets", "POST", payload()))).status).toBe(201);
});

// @effect-diagnostics-next-line asyncFunction:off
it("reports only this User's exact same-Currency outflows in the applied half-open month", async () => {
  const db = await setup();
  expect((await send(db, request(0, "/budgets", "POST", payload()))).status).toBe(201);
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
    (await capture(0, "80.01", "COP", "outflow", DateTime.formatIso(period.from))).status
  ).toBe(201);
  expect(
    (await capture(0, "19.98", "COP", "outflow", DateTime.formatIso(period.from))).status
  ).toBe(201);
  expect((await capture(0, "5", "USD", "outflow", DateTime.formatIso(period.from))).status).toBe(
    201
  );
  expect((await capture(0, "5", "COP", "inflow", DateTime.formatIso(period.from))).status).toBe(
    201
  );
  expect((await capture(1, "5", "COP", "outflow", DateTime.formatIso(period.from))).status).toBe(
    201
  );
  const before = DateTime.makeUnsafe(period.from.epochMilliseconds - 1);
  expect((await capture(0, "5", "COP", "outflow", DateTime.formatIso(before))).status).toBe(201);
  // Capture rejects future Transactions. Seed that boundary to exercise the canonical GET projection.
  await db
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
    .run();
  const response = await send(db, request(0, "/budget-status?timeZone=America%2FBogota"));
  expect(response.status).toBe(200);
  const report = Schema.decodeUnknownSync(Report)(await response.json());
  expect(report.data.statuses).toHaveLength(1);
  const [first] = report.data.statuses;
  if (first === undefined) throw new Error("Budget status missing");
  expect(encodeMoneyAmount(first.spent.amount)).toBe("99.99");
  const other = await send(db, request(1, "/budget-status?timeZone=America%2FBogota"));
  expect(other.status).toBe(200);
  expect(Schema.decodeUnknownSync(Report)(await other.json()).data.statuses).toEqual([]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("ignores more than five thousand unrelated outflows without blocking a Budget mutation", async () => {
  const db = await setup();
  expect((await send(db, request(0, "/budgets", "POST", payload()))).status).toBe(201);
  await seedMonthlyMovements(db, {
    categoryId: "10000000-0000-4000-8000-000000000001",
    count: 5001,
    offset: 0,
    currency: "COP",
    occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
  });
  const report = await send(db, request(0, "/budget-status?timeZone=America%2FBogota"));
  expect(report.status).toBe(200);
  const [status] = Schema.decodeUnknownSync(Report)(await report.json()).data.statuses;
  expect(status === undefined ? undefined : encodeMoneyAmount(status.spent.amount)).toBe("0");
  const capture = await send(
    db,
    request(0, "/transactions", "POST", {
      money: { amount: "1", currency: "COP" },
      categoryId: category,
      direction: "outflow",
      occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
    })
  );
  expect(capture.status).toBe(201);
}, 90000);

// @effect-diagnostics-next-line asyncFunction:off
it("pages past five thousand qualifying outflows without losing exact totals or blocking mutations", async () => {
  const db = await setup();
  expect((await send(db, request(0, "/budgets", "POST", payload()))).status).toBe(201);
  await seedMonthlyMovements(db, {
    categoryId: category,
    currency: "COP",
    count: 5001,
    offset: 0,
    occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
  });
  expect((await send(db, request(0, "/budget-status?timeZone=America%2FBogota"))).status).toBe(503);
  const report = await send(db, request(0, "/budget-status?timeZone=America%2FBogota"));
  expect(report.status).toBe(200);
  const [status] = Schema.decodeUnknownSync(Report)(await report.json()).data.statuses;
  expect(status === undefined ? undefined : encodeMoneyAmount(status.spent.amount)).toBe("50.01");
  expect((await send(db, request(0, "/budgets"))).status).toBe(200);
  const capture = await send(
    db,
    request(0, "/transactions", "POST", {
      money: { amount: "30", currency: "COP" },
      categoryId: category,
      direction: "outflow",
      occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
    })
  );
  expect(capture.status).toBe(201);
  const updated = await send(db, request(0, "/budget-status?timeZone=America%2FBogota"));
  expect(updated.status).toBe(200);
  const [next] = Schema.decodeUnknownSync(Report)(await updated.json()).data.statuses;
  expect(next === undefined ? undefined : encodeMoneyAmount(next.spent.amount)).toBe("80.01");
}, 90000);

// @effect-diagnostics-next-line asyncFunction:off
it("shares a bounded page quota across Budgets rather than applying it per Budget", async () => {
  const db = await setup();
  const otherCategory = "10000000-0000-4000-8000-000000000001";
  expect((await send(db, request(0, "/budgets", "POST", payload()))).status).toBe(201);
  expect(
    (
      await send(
        db,
        request(0, "/budgets", "POST", {
          categoryId: otherCategory,
          cap: { amount: "100", currency: "COP" },
        })
      )
    ).status
  ).toBe(201);
  const occurredAt = DateTime.formatIso(DateTime.nowUnsafe());
  await seedMonthlyMovements(db, {
    categoryId: category,
    currency: "COP",
    count: 2500,
    offset: 0,
    occurredAt,
  });
  await seedMonthlyMovements(db, {
    categoryId: otherCategory,
    currency: "COP",
    count: 2500,
    offset: 2500,
    occurredAt,
  });
  expect((await send(db, request(0, "/budget-status?timeZone=America%2FBogota"))).status).toBe(503);
  const checkpoint = await db
    .prepare(`SELECT COUNT(*) AS count FROM budget_report_progress
    WHERE user_id = ? AND complete = 0`)
    .bind(users[0])
    .first<{ count: number }>();
  expect(checkpoint?.count).toBe(1);
  const report = await send(db, request(0, "/budget-status?timeZone=America%2FBogota"));
  expect(report.status).toBe(200);
  const statuses = Schema.decodeUnknownSync(Report)(await report.json()).data.statuses;
  expect(statuses.map((status) => encodeMoneyAmount(status.spent.amount))).toEqual(["25", "25"]);
}, 90000);

// @effect-diagnostics-next-line asyncFunction:off
it("refuses an expensive capture without partial effects, then resumes the month on retry", async () => {
  const db = await setup();
  expect((await send(db, request(0, "/budgets", "POST", payload()))).status).toBe(201);
  await seedMonthlyMovements(db, {
    categoryId: category,
    currency: "COP",
    count: 5001,
    offset: 0,
    occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
  });
  const capture = (): Promise<Response> =>
    send(
      db,
      request(0, "/transactions", "POST", {
        money: { amount: "30", currency: "COP" },
        categoryId: category,
        direction: "outflow",
        occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
      })
    );
  expect((await capture()).status).toBe(503);
  const afterRefusal = await db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?")
    .bind(users[0])
    .first<{ count: number }>();
  expect(afterRefusal?.count).toBe(5001);
  expect((await capture()).status).toBe(201);
  const report = await send(db, request(0, "/budget-status?timeZone=America%2FBogota"));
  expect(report.status).toBe(200);
  const [status] = Schema.decodeUnknownSync(Report)(await report.json()).data.statuses;
  expect(status === undefined ? undefined : encodeMoneyAmount(status.spent.amount)).toBe("80.01");
}, 90000);

// @effect-diagnostics-next-line asyncFunction:off
it("does not publish a total if a Transaction moves across a paging cursor", async () => {
  const db = await setup();
  expect((await send(db, request(0, "/budgets", "POST", payload()))).status).toBe(201);
  const period = deriveCurrentBudgetMonth({
    now: DateTime.nowUnsafe(),
    timeZone: IanaTimeZone.make("America/Bogota"),
  });
  await seedMonthlyMovements(db, {
    categoryId: category,
    currency: "COP",
    count: 513,
    offset: 0,
    occurredAt: DateTime.formatIso(period.from),
  });
  let moved = false;
  const intercept = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind") {
          return (...values: Parameters<D1PreparedStatement["bind"]>): D1PreparedStatement =>
            intercept(target.bind(...values));
        }
        if (property === "all") {
          // @effect-diagnostics-next-line asyncFunction:off
          return async (): Promise<D1Result<Record<string, unknown>>> => {
            const result = await target.all();
            if (!moved) {
              moved = true;
              await db
                .prepare("UPDATE transactions SET occurred_at = ? WHERE user_id = ? AND id = ?")
                .bind(
                  DateTime.formatIso(DateTime.makeUnsafe(period.from.epochMilliseconds + 1000)),
                  users[0],
                  "30000000-0000-4000-8000-000000000001"
                )
                .run();
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });
  const racingDb: D1Database = {
    prepare: (sql) =>
      sql.includes("ORDER BY occurred_at, id LIMIT") ? intercept(db.prepare(sql)) : db.prepare(sql),
    batch: (statements) => db.batch(statements),
    exec: (sql) => db.exec(sql),
    withSession: (constraint) => db.withSession(constraint),
    dump: () => db.dump(),
  };
  expect(
    (await send(racingDb, request(0, "/budget-status?timeZone=America%2FBogota"))).status
  ).toBe(503);
  expect(moved).toBe(true);
  expect((await send(db, request(0, "/budget-status?timeZone=America%2FBogota"))).status).toBe(503);
  const report = await send(db, request(0, "/budget-status?timeZone=America%2FBogota"));
  expect(report.status).toBe(200);
  const [status] = Schema.decodeUnknownSync(Report)(await report.json()).data.statuses;
  expect(status === undefined ? undefined : encodeMoneyAmount(status.spent.amount)).toBe("5.13");
}, 90000);

// @effect-diagnostics-next-line asyncFunction:off
it("latches 80% and 100% only once across concurrent capture and correction", async () => {
  const db = await setup();
  expect((await send(db, request(0, "/budgets", "POST", payload()))).status).toBe(201);
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
  const [one, two] = await Promise.all([capture(), capture()]);
  expect([one.status, two.status]).toEqual([201, 201]);
  const first = Schema.decodeUnknownSync(Captured)(await one.json());
  const recorded = await db
    .prepare("SELECT threshold FROM budget_threshold_alerts WHERE user_id = ? ORDER BY threshold")
    .bind(users[0])
    .all<{ threshold: number }>();
  expect(recorded.results.map((row) => row.threshold)).toEqual([80, 100]);
  expect(
    (
      await send(
        db,
        request(0, `/transactions/${first.data.id}`, "PUT", {
          expectedRevision: 0,
          changes: { money: { amount: "10", currency: "COP" } },
        })
      )
    ).status
  ).toBe(200);
  expect((await capture()).status).toBe(201);
  const after = await db
    .prepare("SELECT threshold FROM budget_threshold_alerts WHERE user_id = ? ORDER BY threshold")
    .bind(users[0])
    .all<{ threshold: number }>();
  expect(after.results.map((row) => row.threshold)).toEqual([80, 100]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("latches a backdated month and does not reopen it after a correction", async () => {
  const db = await setup();
  expect((await send(db, request(0, "/budgets", "POST", payload()))).status).toBe(201);
  const previous = DateTime.makeUnsafe(DateTime.nowUnsafe().epochMilliseconds - 40 * 86400000);
  const priorPeriod = deriveCurrentBudgetMonth({
    now: previous,
    timeZone: IanaTimeZone.make("America/Bogota"),
  });
  const captured = await send(
    db,
    request(0, "/transactions", "POST", {
      money: { amount: "100", currency: "COP" },
      direction: "outflow",
      categoryId: category,
      occurredAt: DateTime.formatIso(priorPeriod.from),
    })
  );
  expect(captured.status).toBe(201);
  const first = Schema.decodeUnknownSync(Captured)(await captured.json());
  const alerts = (): Promise<D1Result<{ threshold: number }>> =>
    db
      .prepare("SELECT threshold FROM budget_threshold_alerts WHERE user_id = ? ORDER BY threshold")
      .bind(users[0])
      .all<{ threshold: number }>();
  expect((await alerts()).results.map((row) => row.threshold)).toEqual([80, 100]);
  expect(
    (
      await send(
        db,
        request(0, `/transactions/${first.data.id}`, "PUT", {
          expectedRevision: 0,
          changes: { money: { amount: "1", currency: "COP" } },
        })
      )
    ).status
  ).toBe(200);
  expect((await alerts()).results.map((row) => row.threshold)).toEqual([80, 100]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("blocks a correcting mutation until its versioned work backlog has drained", async () => {
  const db = await setup();
  expect((await send(db, request(0, "/budgets", "POST", payload()))).status).toBe(201);
  const instant = DateTime.nowUnsafe();
  const created = await send(
    db,
    request(0, "/transactions", "POST", {
      money: { amount: "100", currency: "COP" },
      direction: "outflow",
      categoryId: category,
      occurredAt: DateTime.formatIso(instant),
    })
  );
  expect(created.status).toBe(201);
  const transaction = Schema.decodeUnknownSync(Captured)(await created.json());
  const earlier = DateTime.makeUnsafe(instant.epochMilliseconds - 40 * 86400000);
  const work = Array.from({ length: 9 }, (_, index) =>
    db
      .prepare(`INSERT INTO budget_reconciliation_work
    (user_id, occurred_at) VALUES (?, ?)`)
      .bind(
        users[0],
        DateTime.formatIso(DateTime.makeUnsafe(earlier.epochMilliseconds + index * 1000))
      )
  );
  await db.batch(work);
  const correction = (): Promise<Response> =>
    send(
      db,
      request(0, `/transactions/${transaction.data.id}`, "PUT", {
        expectedRevision: 0,
        changes: { money: { amount: "1", currency: "COP" } },
      })
    );
  expect((await correction()).status).toBe(503);
  const pending = await db
    .prepare("SELECT COUNT(*) AS count FROM budget_reconciliation_work WHERE user_id = ?")
    .bind(users[0])
    .first<{ count: number }>();
  expect(pending?.count).toBe(8);
  const retryCount = 7;
  const refusals = await Promise.all(Array.from({ length: retryCount }, correction));
  expect(refusals.map((response) => response.status)).toEqual(Array(retryCount).fill(503));
  expect((await correction()).status).toBe(200);
  const alerts = await db
    .prepare("SELECT threshold FROM budget_threshold_alerts WHERE user_id = ? ORDER BY threshold")
    .bind(users[0])
    .all<{ threshold: number }>();
  expect(alerts.results.map((row) => row.threshold)).toEqual([80, 100]);
}, 30000);

// @effect-diagnostics-next-line asyncFunction:off
it("denies read-scoped PAT writes and write-scoped PAT reads without disclosure or mutation", async () => {
  const db = await setup();
  const readToken = `fin_${"r".repeat(8)}_${"a".repeat(43)}`;
  const writeToken = `fin_${"w".repeat(8)}_${"b".repeat(43)}`;
  await seedPAT(db, {
    token: readToken,
    scope: "read",
    id: "40000000-0000-4000-8000-000000000031",
  });
  await seedPAT(db, {
    token: writeToken,
    scope: "write",
    id: "40000000-0000-4000-8000-000000000032",
  });
  expect((await send(db, patRequest(readToken, "/budgets", "POST", payload()))).status).toBe(403);
  const created = await send(db, request(0, "/budgets", "POST", payload()));
  expect(created.status).toBe(201);
  const owner = Schema.decodeUnknownSync(Created)(await created.json()).data;
  expect((await send(db, patRequest(readToken, `/budgets/${owner.id}`, "DELETE"))).status).toBe(
    403
  );
  const denied = await send(db, patRequest(writeToken, `/budgets/${owner.id}`));
  expect(denied.status).toBe(403);
  expect(
    (await send(db, patRequest(writeToken, "/budget-status?timeZone=America%2FBogota"))).status
  ).toBe(403);
  expect((await send(db, request(0, `/budgets/${owner.id}`))).status).toBe(200);
  const count = await db
    .prepare("SELECT COUNT(*) AS count FROM budgets WHERE user_id = ?")
    .bind(users[0])
    .first<{ count: number }>();
  expect(count?.count).toBe(1);
});
