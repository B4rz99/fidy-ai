// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { Option, Schema } from "effect";
import {
  CreateTransactionInput,
  Transaction,
  encodeMoneyAmount,
} from "@fidy/server/transactions-runtime";
import { UserTransactionCoordinator } from "./transaction-coordinator";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import coreWorker from "./core-worker";
import publicWorker from "./public-worker";
import { createManualTransaction, transactionInput, transactionSession } from "./transactions";
import { browseTransactions } from "./transaction-history";

const users = ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000052"];
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
const category = "10000000-0000-4000-8000-000000000016";
let sequence = 0;
const instances: Array<Miniflare> = [];
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));
const bearer = (index: number): string => String(index + 1).repeat(43);
const request = (index: number, path = "/transactions", body?: object): Request =>
  new Request(`https://core.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: `__Host-fidy_session=${bearer(index)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const input = (changes: object = {}): object => ({
  money: { amount: "9007199254740993.15", currency: "USD" },
  direction: "outflow",
  categoryId: category,
  occurredAt: "2025-01-10T12:00:00.000Z",
  ...changes,
});
const applyMigration = (db: D1Database, name: string): Promise<void> =>
  readFile(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8").then((sql) =>
    sql
      .replace(/^--.*$/gmu, "")
      .trim()
      .split(/;\s*\n(?=CREATE |ALTER |INSERT |$)/u)
      .reduce<Promise<void>>(
        (last, statement) => last.then(() => db.prepare(statement).run()).then(() => undefined),
        Promise.resolve()
      )
  );
// @effect-diagnostics-next-line asyncFunction:off
const platformModule = async (platform: boolean): Promise<string> => {
  const built = platform
    ? await Bun.build({
        entrypoints: [new URL("./transaction-platform-fixture.ts", import.meta.url).pathname],
        target: "browser",
      })
    : undefined;
  if (built !== undefined && !built.success) throw new Error("Fixture bundle failed");
  const fixtureModule =
    built === undefined
      ? "export default {fetch() {return new Response('ok')}}"
      : await built.outputs[0]?.text();
  if (fixtureModule === undefined) throw new Error("Fixture module missing");
  return fixtureModule;
};
// @effect-diagnostics-next-line asyncFunction:off
const setup = async (platform = false): Promise<D1Database> => {
  const fixtureModule = await platformModule(platform);
  const mf = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: `transactions-${++sequence}`, type: "d1" } },
          ...(platform
            ? {
                exports: {
                  UserTransactionCoordinator: {
                    type: "durable-object" as const,
                    storage: "sqlite" as const,
                  },
                },
                env: {
                  DB: { id: `transactions-${sequence}`, type: "d1" as const },
                  USER_TRANSACTION_COORDINATOR: {
                    type: "durable-object" as const,
                    worker: `transactions-${sequence}`,
                    exportName: "UserTransactionCoordinator",
                  },
                },
              }
            : {}),
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: fixtureModule,
                type: "esm",
              },
            },
          },
          name: `transactions-${sequence}`,
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
  ].reduce<Promise<void>>(
    (previous, name) => previous.then(() => applyMigration(db, name)),
    Promise.resolve()
  );
  // @effect-diagnostics-next-line globalDate:off
  const current = Date.now();
  await Promise.all(
    users.map(
      // @effect-diagnostics-next-line asyncFunction:off
      async (user, index) => {
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
      }
    )
  );
  return db;
};
// @effect-diagnostics-next-line asyncFunction:off
afterEach(async () => {
  await Promise.all(instances.splice(0).map((mf) => mf.dispose()));
});
const Created = Schema.Struct({
  data: Schema.toCodecJson(Transaction),
  next: Schema.Array(Schema.Unknown),
});
const sendPublicRequest = (
  db: D1Database,
  request: Request,
  coordinator?: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>
): Promise<Response> =>
  publicWorker.fetch(request, {
    BROWSER_ORIGIN: "https://app.fidyapp.com",
    LOCAL_CANONICAL_READ_BEARER: "",
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CORE: {
      fetch: (internal) =>
        coreWorker.fetch(new Request(internal), {
          DB: db,
          AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
          CONTRACT_DIGEST: "a".repeat(64),
          RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
          HOSTED_AI_MODEL: approvedWorkersAiModel,
          USER_TRANSACTION_COORDINATOR: coordinator ?? {
            getByName: (name) => ({
              fetch: (command) =>
                new UserTransactionCoordinator({ id: { name } }, { DB: db }).fetch(
                  new Request(command)
                ),
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
const Listed = Schema.Struct({
  data: Schema.Array(Schema.toCodecJson(Transaction)),
  next: Schema.Array(Schema.Unknown),
});

// @effect-diagnostics-next-line asyncFunction:off
it("coordinates concurrent public mutations through a real per-User Durable Object binding", async () => {
  const db = await setup(true);
  const instance = instances.at(-1);
  if (instance === undefined) throw new Error("Missing Miniflare runtime");
  const namespace = await instance.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR");
  const coordinator = {
    getByName: (name: string): Readonly<{ fetch: (command: Request) => Promise<Response> }> => ({
      fetch: (command: Request): Promise<Response> =>
        command.text().then((body) =>
          namespace
            .getByName(name)
            .fetch(command.url, {
              method: command.method,
              headers: Object.fromEntries(command.headers),
              body,
            })
            .then((result) =>
              result.text().then(
                (text) =>
                  new Response(text, {
                    status: result.status,
                    headers: Object.fromEntries(result.headers),
                  })
              )
            )
        ),
    }),
  };
  const post = (index: number): Promise<Response> =>
    sendPublicRequest(
      db,
      new Request("https://api.fidyapp.com/transactions", {
        method: "POST",
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: `__Host-fidy_session=${bearer(index)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input()),
      }),
      coordinator
    );
  const results = await Promise.all([post(0), post(0), post(1)]);
  expect(results.map(({ status }) => status)).toEqual([201, 201, 201]);
  const transactions = results.map((response) => response.json());
  const [first, second, other] = await Promise.all(transactions);
  const created = [first, second, other].map(
    (value) => Schema.decodeUnknownSync(Created)(value).data
  );
  expect(new Set(created.map(({ id }) => id)).size).toBe(3);
  const browse = (index: number, path = "/transactions"): Promise<Response> =>
    sendPublicRequest(
      db,
      new Request(`https://api.fidyapp.com${path}`, {
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: `__Host-fidy_session=${bearer(index)}`,
          authorization: `Bearer ${bearer(index)}`,
          "x-provider-id": users[1 - index] ?? "untrusted",
        },
      }),
      coordinator
    );
  const owner = Schema.decodeUnknownSync(Listed)(await (await browse(0)).json()).data;
  const neighbor = Schema.decodeUnknownSync(Listed)(await (await browse(1)).json()).data;
  expect(new Set(owner.map(({ id }) => id))).toEqual(
    new Set(created.slice(0, 2).map(({ id }) => id))
  );
  expect(neighbor).toEqual([created[2]]);
  const protectedTransaction = created[0];
  if (protectedTransaction === undefined) throw new Error("Missing owner capture");
  expect((await browse(1, `/transactions/${protectedTransaction.id}`)).status).toBe(404);
  const attemptedDeletion = sendPublicRequest(
    db,
    new Request(`https://api.fidyapp.com/transactions/${protectedTransaction.id}`, {
      method: "DELETE",
      headers: {
        origin: "https://app.fidyapp.com",
        cookie: `__Host-fidy_session=${bearer(1)}`,
        authorization: `Bearer ${bearer(1)}`,
        "x-provider-id": users[0] ?? "",
      },
    }),
    coordinator
  );
  const [createdAgain, deleted] = await Promise.all([post(0), attemptedDeletion]);
  expect(createdAgain.status).toBe(201);
  expect(deleted.status).not.toBe(200);
  const preserved = Schema.decodeUnknownSync(Listed)(await (await browse(0)).json()).data;
  expect(preserved).toContainEqual(protectedTransaction);
  const evidence = await db
    .prepare("SELECT COUNT(*) AS count FROM source_attestations WHERE transaction_id = ?")
    .bind(protectedTransaction.id)
    .first<{ count: number }>();
  expect(evidence?.count).toBe(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("enforces the stable-User daily write budget atomically and preserves append-only evidence", async () => {
  const db = await setup();
  // @effect-diagnostics-next-line globalDate:off
  const today = new Date().toISOString();
  await db
    .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100)
    INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    SELECT 'seed-' || n, ?, '1', 'COP', 'outflow', ?, ?, ? FROM seq`)
    .bind(users[0], category, today, today)
    .run();
  const session = await transactionSession(request(0), db);
  if (Option.isNone(session)) throw new Error("Missing fixture session");
  const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(CreateTransactionInput))(input());
  expect((await createManualTransaction(db, session.value, decoded)).status).toBe(429);
  const rows = await db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?")
    .bind(users[0])
    .first<{ count: number }>();
  expect(rows?.count).toBe(100);
  expect(
    (
      await createManualTransaction(
        db,
        Option.getOrThrow(await transactionSession(request(1), db)),
        decoded
      )
    ).status
  ).toBe(201);
  const evidence = await db.prepare("SELECT id FROM transaction_audit").first<{ id: string }>();
  if (evidence === null) throw new Error("Missing audit");
  await expect(
    db.prepare("DELETE FROM transaction_audit WHERE id = ?").bind(evidence.id).run()
  ).rejects.toThrow();
  await expect(db.prepare("DELETE FROM source_attestations").run()).rejects.toThrow();
});

// @effect-diagnostics-next-line asyncFunction:off
it("bounds authenticated audit growth atomically per stable User at the public boundary", async () => {
  const db = await setup();
  // @effect-diagnostics-next-line globalDate:off
  const current = Date.now();
  await db
    .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 256)
    INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT 'budget-seed-' || n, ?, ?, 'transactions.listTransactions', 'success', ? FROM seq`)
    .bind(users[0], sessions[0], current)
    .run();
  const call = (index: number, path = "/transactions", body?: object): Promise<Response> =>
    sendPublicRequest(
      db,
      new Request(`https://api.fidyapp.com${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: `__Host-fidy_session=${bearer(index)}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
  expect((await call(0)).status).toBe(429);
  // The expensive history batch must not run once this User is admitted no further reads.
  const cheapDb: D1Database = {
    prepare: (sql) => db.prepare(sql),
    batch: () => Promise.reject(new Error("History batch must not run")),
    exec: (sql) => db.exec(sql),
    withSession: (constraint) => db.withSession(constraint),
    dump: () => db.dump(),
  };
  const cheapRefusal = await sendPublicRequest(
    cheapDb,
    new Request("https://api.fidyapp.com/transactions", {
      headers: { origin: "https://app.fidyapp.com", cookie: `__Host-fidy_session=${bearer(0)}` },
    })
  );
  expect(cheapRefusal.status).toBe(429);
  expect((await call(0, "/transactions?unknown=1")).status).toBe(429);
  expect((await call(0, "/transactions", input())).status).toBe(429);
  expect((await call(1)).status).toBe(200);
  const audit = await db
    .prepare("SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ?")
    .bind(users[0])
    .first<{ count: number }>();
  const transactions = await db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?")
    .bind(users[0])
    .first<{ count: number }>();
  expect(audit?.count).toBe(256);
  expect(transactions?.count).toBe(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects forged browser origins and malformed Money before any public mutation", async () => {
  const db = await setup();
  const post = (origin: string, data: object): Request =>
    new Request("https://api.fidyapp.com/transactions", {
      method: "POST",
      headers: {
        origin,
        cookie: `__Host-fidy_session=${bearer(0)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(data),
    });
  expect((await sendPublicRequest(db, post("https://attacker.test", input()))).status).toBe(403);
  expect(
    (
      await sendPublicRequest(
        db,
        post("https://app.fidyapp.com", input({ money: { amount: "1e4", currency: "COP" } }))
      )
    ).status
  ).toBe(400);
  const counts = await Promise.all(
    ["transactions", "source_attestations", "transaction_audit"].map((table) =>
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
    )
  );
  expect(counts.map((result) => result?.count)).toEqual([0, 0, 1]);
  const created = await sendPublicRequest(db, post("https://app.fidyapp.com", input()));
  expect(created.status).toBe(201);
  const transaction = Schema.decodeUnknownSync(Created)(await created.json()).data;
  const browse = (index: number, path = "/transactions"): Promise<Response> =>
    sendPublicRequest(
      db,
      new Request(`https://api.fidyapp.com${path}`, {
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: `__Host-fidy_session=${bearer(index)}`,
        },
      })
    );
  expect(Schema.decodeUnknownSync(Listed)(await (await browse(0)).json()).data).toEqual([
    transaction,
  ]);
  expect(Schema.decodeUnknownSync(Listed)(await (await browse(1)).json()).data).toEqual([]);
  expect((await browse(1, `/transactions/${transaction.id}`)).status).toBe(404);
  const tokenOnly = await sendPublicRequest(
    db,
    new Request(`https://api.fidyapp.com/transactions/${transaction.id}`, {
      headers: {
        origin: "https://app.fidyapp.com",
        authorization: `Bearer ${bearer(0)}`,
        "x-provider-id": users[0] ?? "",
      },
    })
  );
  expect(tokenOnly.status).toBe(401);
  const foreignWithBearer = await sendPublicRequest(
    db,
    new Request(`https://api.fidyapp.com/transactions/${transaction.id}`, {
      headers: {
        origin: "https://app.fidyapp.com",
        cookie: `__Host-fidy_session=${bearer(1)}`,
        authorization: `Bearer ${bearer(0)}`,
        "x-provider-id": users[0] ?? "",
      },
    })
  );
  expect(foreignWithBearer.status).toBe(404);
  expect((await browse(1, "/transactions/not-an-id")).status).toBe(404);
  expect((await browse(0, "/transactions?unknown=1")).status).toBe(400);
  const outcomes = await db
    .prepare(
      "SELECT outcome FROM transaction_audit WHERE user_id = ? AND operation = 'transactions.getTransaction'"
    )
    .bind(users[1])
    .all<{ outcome: string }>();
  expect(outcomes.results.map(({ outcome }) => outcome)).toEqual([
    "not_found",
    "not_found",
    "not_found",
  ]);
  const invalidAudit = await db
    .prepare(
      "SELECT outcome FROM transaction_audit WHERE user_id = ? AND outcome = 'validation_failed'"
    )
    .bind(users[0])
    .first<{ outcome: string }>();
  expect(invalidAudit?.outcome).toBe("validation_failed");
});

// @effect-diagnostics-next-line asyncFunction:off
it("continues the canonical history beyond its first bounded page without losing tied movements", async () => {
  const db = await setup();
  // @effect-diagnostics-next-line globalDate:off
  const createdAt = new Date().toISOString();
  const previous = "2025-01-09T12:00:00.000Z";
  await db
    .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 101)
    INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    SELECT printf('00000000-0000-4000-8000-%012d', n), ?, '1', 'COP', 'outflow', ?, ?,
      CASE WHEN n = 101 THEN ? ELSE ? END FROM seq`)
    .bind(users[0], category, previous, previous, createdAt)
    .run();
  await db
    .prepare(`INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    VALUES (?, ?, '1', 'COP', 'inflow', ?, '2024-01-09T12:00:00.000Z', ?)`)
    .bind("00000000-0000-4000-8000-000000000999", users[0], category, previous)
    .run();
  const subject = Option.getOrThrow(await transactionSession(request(0), db));
  const first = await browseTransactions(db, {
    request: request(0, "/transactions?direction=outflow"),
    subject,
    id: Option.none(),
  });
  const Page = Schema.Struct({
    data: Schema.Array(Schema.toCodecJson(Transaction)),
    next: Schema.Array(
      Schema.Struct({
        tool: Schema.String,
        hint: Schema.String,
        args: Schema.Struct({
          query: Schema.Struct({ cursor: Schema.String, direction: Schema.String }),
        }),
      })
    ),
  });
  const page = Schema.decodeUnknownSync(Page)(await first.json());
  expect(page.data).toHaveLength(100);
  expect(page.next).toHaveLength(1);
  expect(page.next[0]?.tool).toBe("transactions.listTransactions");
  const cursor = page.next[0]?.args.query.cursor;
  if (cursor === undefined) throw new Error("Missing continuation");
  expect(page.next[0]?.args.query.direction).toBe("outflow");
  const second = await browseTransactions(db, {
    request: request(0, `/transactions?direction=outflow&cursor=${encodeURIComponent(cursor)}`),
    subject,
    id: Option.none(),
  });
  const remainder = Schema.decodeUnknownSync(Page)(await second.json());
  expect(remainder.data).toHaveLength(1);
  expect(remainder.next).toEqual([]);
  expect(new Set([...page.data, ...remainder.data].map(({ id }) => id)).size).toBe(101);
});

// @effect-diagnostics-next-line asyncFunction:off
it("commits exact manual Money, immutable capture context, and audit before canonical browsing", async () => {
  const db = await setup();
  const owner = await transactionSession(request(0), db);
  const parsed = await transactionInput(
    request(0, "/transactions", input({ counterparty: "Acme" }))
  );
  if (Option.isNone(owner) || Option.isNone(parsed)) throw new Error("fixture invalid");
  const response = await createManualTransaction(db, owner.value, parsed.value);
  expect(response.status).toBe(201);
  const created = Schema.decodeUnknownSync(Created)(await response.json());
  expect(encodeMoneyAmount(created.data.money.amount)).toBe("9007199254740993.15");
  expect(Option.getOrNull(created.data.counterparty)).toBe("Acme");
  const listed = await browseTransactions(db, {
    request: request(0),
    subject: owner.value,
    id: Option.none(),
  });
  expect(Schema.decodeUnknownSync(Listed)(await listed.json()).data).toEqual([created.data]);
  const evidence = await db
    .prepare(
      "SELECT kind, service_market, locale, time_zone, interpretation_revision FROM source_attestations WHERE user_id = ?"
    )
    .bind(users[0])
    .all();
  expect(evidence.results).toEqual([
    {
      kind: "manual",
      service_market: "CO",
      locale: "es-CO",
      time_zone: "America/Bogota",
      interpretation_revision: "manual-v1",
    },
  ]);
  const audit = await db
    .prepare("SELECT operation FROM transaction_audit WHERE user_id = ? ORDER BY occurred_at_ms")
    .bind(users[0])
    .all();
  expect(
    audit.results
      .map((row) => row.operation)
      .sort((first, second) => String(first).localeCompare(String(second)))
  ).toEqual(["transactions.createTransaction", "transactions.listTransactions"]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("neither a foreign opaque id nor another session can observe a Transaction", async () => {
  const db = await setup();
  const owner = await transactionSession(request(0), db);
  const other = await transactionSession(request(1), db);
  const parsed = await transactionInput(request(0, "/transactions", input()));
  const tokenOnly = new Request("https://core.internal/transactions", {
    headers: { authorization: `Bearer ${bearer(0)}`, "x-provider-id": users[0] ?? "" },
  });
  expect(Option.isNone(await transactionSession(tokenOnly, db))).toBe(true);
  if (Option.isNone(owner) || Option.isNone(other) || Option.isNone(parsed)) {
    throw new Error("fixture invalid");
  }
  const created = Schema.decodeUnknownSync(Created)(
    await (await createManualTransaction(db, owner.value, parsed.value)).json()
  );
  expect(
    Schema.decodeUnknownSync(Listed)(
      await (
        await browseTransactions(db, {
          request: request(1),
          subject: other.value,
          id: Option.none(),
        })
      ).json()
    ).data
  ).toEqual([]);
  expect(
    (
      await browseTransactions(db, {
        request: request(1, `/transactions/${created.data.id}`),
        subject: other.value,
        id: Option.some(created.data.id),
      })
    ).status
  ).toBe(404);
  await db
    .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
    .bind(1, sessions[0])
    .run();
  expect(Option.isNone(await transactionSession(request(0), db))).toBe(true);
  expect((await createManualTransaction(db, owner.value, parsed.value)).status).toBe(401);
  expect(
    (await browseTransactions(db, { request: request(0), subject: owner.value, id: Option.none() }))
      .status
  ).toBe(401);
  expect(
    Schema.decodeUnknownSync(Listed)(
      await (
        await browseTransactions(db, {
          request: request(1),
          subject: other.value,
          id: Option.none(),
        })
      ).json()
    ).data
  ).toEqual([]);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM transactions").first<{ count: number }>())
      ?.count
  ).toBe(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("serializes concurrent mutations for one User without mixing another User's records", async () => {
  const db = await setup();
  const first = await transactionSession(request(0), db);
  const second = await transactionSession(request(1), db);
  const parsed = await transactionInput(request(0, "/transactions", input()));
  if (Option.isNone(first) || Option.isNone(second) || Option.isNone(parsed)) {
    throw new Error("fixture invalid");
  }
  const coordinatorA = new UserTransactionCoordinator(
    { id: { name: first.value.userId } },
    { DB: db }
  );
  const coordinatorB = new UserTransactionCoordinator(
    { id: { name: second.value.userId } },
    { DB: db }
  );
  const encoded = Schema.encodeSync(Schema.toCodecJson(CreateTransactionInput))(parsed.value);
  const command = (session: typeof first.value): Request =>
    new Request("https://coordinator.internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        userId: session.userId,
        digest: Array.from(session.digest),
        input: encoded,
      }),
    });
  const responses = await Promise.all([
    coordinatorA.fetch(command(first.value)),
    coordinatorA.fetch(command(first.value)),
    coordinatorB.fetch(command(second.value)),
  ]);
  expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
  expect((await coordinatorB.fetch(command(first.value))).status).not.toBe(201);
  const firstList = await browseTransactions(db, {
    request: request(0),
    subject: first.value,
    id: Option.none(),
  });
  const secondList = await browseTransactions(db, {
    request: request(1),
    subject: second.value,
    id: Option.none(),
  });
  expect(Schema.decodeUnknownSync(Listed)(await firstList.json()).data).toHaveLength(2);
  expect(Schema.decodeUnknownSync(Listed)(await secondList.json()).data).toHaveLength(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects an unknown Category without retaining partial Transaction, attestation, or audit state", async () => {
  const db = await setup();
  const owner = await transactionSession(request(0), db);
  const parsed = await transactionInput(
    request(0, "/transactions", input({ categoryId: "10000000-0000-4000-8000-000000009999" }))
  );
  if (Option.isNone(owner) || Option.isNone(parsed)) {
    throw new Error("fixture invalid");
  }
  expect((await createManualTransaction(db, owner.value, parsed.value)).status).not.toBe(201);
  const counts = await Promise.all(
    ["transactions", "source_attestations", "transaction_audit"].map((table) =>
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
    )
  );
  expect(counts.map((result) => result?.count)).toEqual([0, 0, 1]);
});
