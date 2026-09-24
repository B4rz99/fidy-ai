import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import {
  CreateTransactionInput,
  Transaction,
  encodeMoneyAmount,
} from "@fidy/server/transactions-runtime";
import { UserTransactionCoordinator } from "./transaction-coordinator";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { createManualTransaction, transactionInput, transactionSession } from "./transactions";
import { browseTransactions } from "./transaction-history";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);
const users = ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000052"];
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
const category = "10000000-0000-4000-8000-000000000016";
let sequence = 0;
const instances: Array<Miniflare> = [];
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));
const replayResponse = (
  result: Readonly<{
    text: () => Promise<string>;
    status: number;
    headers: Iterable<readonly [string, string]>;
  }>
): Promise<Response> =>
  result
    .text()
    .then(
      (text) =>
        new Response(text, { status: result.status, headers: Object.fromEntries(result.headers) })
    );
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
  Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url))
    .text()
    .then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)
        .reduce<Promise<void>>(
          (last, statement) => last.then(() => db.prepare(statement).run()).then(() => undefined),
          Promise.resolve()
        )
    );

const platformModule = (platform: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const built = platform
        ? yield* fromTestPromise(() =>
            Bun.build({
              entrypoints: [new URL("./transaction-platform-fixture.ts", import.meta.url).pathname],
              target: "browser",
            })
          )
        : undefined;
      if (built !== undefined && !built.success) throw new Error("Fixture bundle failed");
      if (built === undefined) return "export default {fetch() {return new Response('ok')}}";
      const output = built.outputs[0];
      if (output === undefined) throw new Error("Fixture module missing");
      return yield* fromTestPromise(() => output.text());
    })
  );

const setup = (platform = false): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixtureModule = yield* fromTestPromise(() => platformModule(platform));
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
      yield* fromTestPromise(() => mf.ready);
      const db = yield* fromTestPromise(() => mf.getD1Database("DB"));
      yield* fromTestPromise(() =>
        [
          "0001_categories",
          "0003_pending_consent",
          "0004_onboarding_email",
          "0005_verified_onboarding",
          "0006_browser_login",
          "0009_transactions",
          "0010_pat_lifecycle",
          "0011_transaction_corrections",
          "0012_transaction_search",
        ].reduce<Promise<void>>(
          (previous, name) => previous.then(() => applyMigration(db, name)),
          Promise.resolve()
        )
      );
      const current = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        users,
        (user, index) =>
          Effect.gen(function* () {
            yield* fromTestPromise(() =>
              db
                .prepare(
                  "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
                )
                .bind(user, current)
                .run()
            );
            const verifierDigest = yield* fromTestPromise(() => digest(`verifier${index}`));
            yield* fromTestPromise(() =>
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
                )
                .run()
            );
            const sessionDigest = yield* fromTestPromise(() => digest(bearer(index)));
            yield* fromTestPromise(() =>
              db
                .prepare(
                  "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                )
                .bind(
                  sessions[index],
                  `10000000-0000-4000-8000-00000000007${index}`,
                  user,
                  sessionDigest,
                  current,
                  current + 600000,
                  current + 3600000,
                  current + 7776000000
                )
                .run()
            );
          }),
        { concurrency: "unbounded" }
      );
      return db;
    })
  );

afterEach(() =>
  Effect.runPromise(
    fromTestPromise(() => Promise.all(instances.splice(0).map((mf) => mf.dispose())))
  )
);
const Created = Schema.Struct({
  data: Schema.toCodecJson(Transaction),
  next: Schema.Array(Schema.Unknown),
});
const BatchResult = Schema.Struct({
  data: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        operation: Schema.String,
        output: Schema.Struct({
          data: Schema.toCodecJson(Transaction),
          next: Schema.Array(Schema.Unknown),
        }),
      })
    ),
  }),
  next: Schema.Array(Schema.Unknown),
});
const CallerFailure = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const BatchRejection = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    failedCallIndex: Schema.Int,
    operation: Schema.String,
    fields: Schema.Array(Schema.Unknown),
  }),
  next: Schema.Array(Schema.Unknown),
});
const batchCallId = (suffix: number): string =>
  `20000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const transactionCall = (suffix: number, payload: object): object => ({
  callId: batchCallId(suffix),
  operation: "transactions.createTransaction",
  input: { payload },
});
const correctionCall = (suffix: number, id: string, payload: object): object => ({
  callId: batchCallId(suffix),
  operation: "transactions.updateTransaction",
  input: { params: { id }, payload },
});
const batchRequest = (index: number, calls: ReadonlyArray<object>): Request =>
  new Request("https://api.fidyapp.com/operations/atomic-batch", {
    method: "POST",
    headers: {
      origin: "https://app.fidyapp.com",
      cookie: `__Host-fidy_session=${bearer(index)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ calls }),
  });
const bearerRequest = (index: number, token: string, calls: ReadonlyArray<object>): Request =>
  new Request("https://api.fidyapp.com/operations/atomic-batch", {
    method: "POST",
    headers: {
      origin: "https://app.fidyapp.com",
      authorization: `Bearer ${token}`,
      "x-provider-id": users[index] ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({ calls }),
  });
const countRows = (
  db: D1Database,
  sql: string,
  ...bindings: ReadonlyArray<string>
): Promise<number> =>
  db
    .prepare(sql)
    .bind(...bindings)
    .first<{ count: number }>()
    .then((row) => row?.count ?? -1);
const seedDailyTransactions = (db: D1Database, count: number): Promise<unknown> => {
  const today = DateTime.formatIso(DateTime.nowUnsafe());
  return db
    .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
    INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    SELECT 'seed-' || n, ?, '1', 'COP', 'outflow', ?, ?, ? FROM seq`)
    .bind(count, users[0], category, today, today)
    .run();
};
const seedTransaction = ({
  db,
  userId,
  id,
  categoryId,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: string;
  categoryId: string;
}>): Promise<unknown> =>
  db
    .prepare(`INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, notes, occurred_at, created_at)
      VALUES (?, ?, '10.00', 'COP', 'outflow', ?, 'seed', '2025-01-05T12:00:00.000Z', '2025-01-05T12:00:00.000Z')`)
    .bind(id, userId, categoryId)
    .run();
let seededPATSequence = 0;
const seedPAT = ({
  db,
  userId,
  token,
  scopes,
  current,
}: Readonly<{
  db: D1Database;
  userId: string;
  token: string;
  scopes: ReadonlyArray<string>;
  current: number;
}>): Effect.Effect<void> =>
  Effect.gen(function* () {
    seededPATSequence += 1;
    const suffix = String(seededPATSequence).padStart(12, "0");
    const bearerDigest = yield* fromTestPromise(() => digest(token));
    yield* fromTestPromise(() =>
      db
        .prepare(`INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json, lifetime_days,
          created_at_ms, issued_at_ms, expires_at_ms, request_id) VALUES (?, ?, ?, ?, 'Atomic batch agent', ?, 7, ?, ?, ?, ?)`)
        .bind(
          `40000000-0000-4000-8000-${suffix}`,
          userId,
          token.slice("fin_".length, "fin_".length + 8),
          bearerDigest,
          JSON.stringify(scopes),
          current,
          current,
          current + 7 * 86_400_000,
          `40000000-0000-4000-9000-${suffix}`
        )
        .run()
    );
  });
const countingDb = (db: D1Database): Readonly<{ db: D1Database; batches: () => number }> => {
  let batches = 0;
  return {
    db: {
      prepare: (sql) => db.prepare(sql),
      batch: (statements) => {
        batches += 1;
        return db.batch(statements);
      },
      exec: (sql) => db.exec(sql),
      withSession: (constraint) => db.withSession(constraint),
      dump: () => db.dump(),
    },
    batches: () => batches,
  };
};
const racingBatch = (db: D1Database, before: () => Promise<unknown>): D1Database => ({
  prepare: (sql) => db.prepare(sql),
  batch: (statements) => before().then(() => db.batch(statements)),
  exec: (sql) => db.exec(sql),
  withSession: (constraint) => db.withSession(constraint),
  dump: () => db.dump(),
});
const concurrentCorrection = ({
  db,
  userId,
  transactionId,
  evidenceId,
}: Readonly<{
  db: D1Database;
  userId: string;
  transactionId: string;
  evidenceId: string;
}>): Promise<unknown> =>
  db
    .prepare(`INSERT INTO transaction_corrections (id, user_id, transaction_id, previous_revision, changed_fields, before_facts, after_facts, corrected_at)
      VALUES (?, ?, ?, 0, '["notes"]', '{"notes":"seed"}', '{"notes":"concurrent"}', '2025-01-06T12:00:00.000Z')`)
    .bind(evidenceId, userId, transactionId)
    .run()
    .then(() =>
      db
        .prepare(
          "UPDATE transactions SET notes = 'concurrent', revision = 1 WHERE user_id = ? AND id = ? AND revision = 0"
        )
        .bind(userId, transactionId)
        .run()
    );
const sendPublicRequest = (
  db: D1Database,
  request: Request,
  coordinator?: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>
): Promise<Response> =>
  publicWorker.fetch(request, {
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

it("searches only the caller's FinancialRecord with bounded literal terms", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const send = (index: number, path: string, body?: object): Promise<Response> =>
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
      const own = yield* fromTestPromise(() =>
        send(0, "/transactions", input({ counterparty: "Café 100%", notes: "Almuerzo" }))
      );
      const foreign = yield* fromTestPromise(() =>
        send(1, "/transactions", input({ counterparty: "Café 100%" }))
      );
      expect(own.status).toBe(201);
      expect(foreign.status).toBe(201);
      const ownId = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => own.json())
      )).data.id;
      const foreignId = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => foreign.json())
      )).data.id;
      const found = yield* fromTestPromise(() =>
        send(0, "/transactions/search?q=%20%20Caf%C3%A9%20100%25%20")
      );
      expect(found.status).toBe(200);
      const result = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => found.json())
      );
      expect(result.data.map((item) => item.id)).toEqual([ownId]);
      expect(result.next).toEqual([]);
      for (const [index, term] of [
        [1, ownId],
        [0, foreignId],
        [0, "100_"],
      ] as const) {
        const response = yield* fromTestPromise(() =>
          send(index, `/transactions/search?q=${encodeURIComponent(term)}`)
        );
        expect(
          (yield* Schema.decodeUnknownEffect(Listed)(yield* fromTestPromise(() => response.json())))
            .data
        ).toEqual([]);
      }
      const unicodeTerm = encodeURIComponent("é".repeat(80));
      expect(
        (yield* fromTestPromise(() => send(0, `/transactions/search?q=${unicodeTerm}`))).status
      ).toBe(200);
      for (const path of [
        `/transactions/search?q=${"a".repeat(3000)}`,
        "/transactions/search?q=%25",
        "/transactions/search?q=a",
        `/transactions/search?q=${"x".repeat(100)}`,
        "/transactions/search?q=valid&q=valid",
        "/transactions/search?q=valid&cursor=bad",
        "/transactions/search?q=%ZZ",
        "/transactions/search?q=%FF%FF",
      ]) {
        const rejected = yield* fromTestPromise(() => send(0, path));
        expect(rejected.status).toBe(400);
        expect(rejected.headers.get("cache-control")).toBe("no-store");
      }
    })
  ));

it("corrects selected facts once, retains decisions and evidence, and rejects stale or foreign corrections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const methodFor = (path: string, body?: object): string => {
        if (body === undefined) return "GET";
        return path === "/transactions" ? "POST" : "PUT";
      };
      const send = (index: number, path: string, body?: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method: methodFor(path, body),
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
      const createdResponse = yield* fromTestPromise(() =>
        send(0, "/transactions", input({ counterparty: "Acme" }))
      );
      expect(createdResponse.status).toBe(201);
      const created = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => createdResponse.json())
      ).pipe(Effect.orDie)).data;
      const path = `/transactions/${created.id}`;
      const correction = {
        expectedRevision: 0,
        changes: { categoryId: "10000000-0000-4000-8000-000000000001", counterparty: null },
      };
      expect((yield* fromTestPromise(() => send(1, path, correction))).status).toBe(404);
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            new Request(`https://api.fidyapp.com${path}`, {
              method: "PUT",
              headers: {
                origin: "https://app.fidyapp.com",
                authorization: `Bearer ${bearer(0)}`,
                "x-provider-id": users[0] ?? "",
                "content-type": "application/json",
              },
              body: JSON.stringify(correction),
            })
          )
        )).status
      ).toBe(401);
      expect(
        (yield* fromTestPromise(() => send(0, path, { expectedRevision: 0, changes: {} }))).status
      ).toBe(400);
      const changed = yield* fromTestPromise(() => send(0, path, correction));
      expect(changed.status).toBe(200);
      const result = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => changed.json())
      ).pipe(Effect.orDie)).data;
      expect(result.id).toBe(created.id);
      expect(result.revision).toBe(1);
      expect(result.money).toEqual(created.money);
      expect(Option.isNone(result.counterparty)).toBe(true);
      expect(result.categoryId).toBe(correction.changes.categoryId);
      expect((yield* fromTestPromise(() => send(0, path, correction))).status).toBe(400);
      const fetched = yield* fromTestPromise(() => send(0, path));
      expect(fetched.status).toBe(200);
      const stored = yield* fromTestPromise(() =>
        db
          .prepare("SELECT revision, user_decisions FROM transactions WHERE id = ?")
          .bind(created.id)
          .first<{ revision: number; user_decisions: string }>()
      );
      expect(stored?.revision).toBe(1);
      expect(
        yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean))
        )(stored?.user_decisions).pipe(Effect.orDie)
      ).toEqual({
        money: true,
        direction: true,
        occurredAt: true,
        categoryId: true,
        counterparty: true,
      });
      const evidence = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT before_facts, after_facts FROM transaction_corrections WHERE transaction_id = ?"
          )
          .bind(created.id)
          .first<{ before_facts: string; after_facts: string }>()
      );
      expect(evidence?.before_facts).toContain("Acme");
      expect(evidence?.after_facts).not.toContain("Acme");
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM source_attestations WHERE transaction_id = ?")
            .bind(created.id)
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
      yield* fromTestPromise(() =>
        expect(
          db.prepare("UPDATE transaction_corrections SET changed_fields = '[]'").run()
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(
          db
            .prepare("UPDATE transactions SET user_decisions = '{}' WHERE id = ?")
            .bind(created.id)
            .run()
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(
          db
            .prepare("UPDATE transactions SET category_id = ? WHERE id = ?")
            .bind(category, created.id)
            .run()
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(
          db
            .prepare(
              "UPDATE transactions SET category_id = ?, revision = revision + 1 WHERE id = ?"
            )
            .bind(category, created.id)
            .run()
        ).rejects.toThrow()
      );
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare("SELECT revision FROM transactions WHERE id = ?")
            .bind(created.id)
            .first<{ revision: number }>()
        ))?.revision
      ).toBe(1);
    })
  ));

it("serializes competing corrections and rolls back evidence when the correction audit refuses a write", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const send = (path: string, method: string, body?: object): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com${path}`, {
            method,
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
      const created = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() =>
          send("/transactions", "POST", input()).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;
      const path = `/transactions/${created.id}`;
      const first = { expectedRevision: 0, changes: { notes: "first" } };
      yield* fromTestPromise(() =>
        db
          .prepare(`CREATE TRIGGER refuse_correction_audit BEFORE INSERT ON transaction_audit
      WHEN NEW.operation = 'transactions.updateTransaction' BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      expect((yield* fromTestPromise(() => send(path, "PUT", first))).status).not.toBe(200);
      const empty = yield* fromTestPromise(() =>
        db
          .prepare("SELECT revision FROM transactions WHERE id = ?")
          .bind(created.id)
          .first<{ revision: number }>()
      );
      expect(empty?.revision).toBe(0);
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM transaction_corrections")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
      yield* fromTestPromise(() => db.prepare("DROP TRIGGER refuse_correction_audit").run());
      const results = yield* fromTestPromise(() =>
        Promise.all([
          send(path, "PUT", first),
          send(path, "PUT", { expectedRevision: 0, changes: { notes: "second" } }),
        ])
      );
      expect(results.map(({ status }) => status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      expect(
        (yield* fromTestPromise(() =>
          db
            .prepare("SELECT COUNT(*) AS count FROM transaction_corrections")
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
  ));

it("rolls back public Transaction capture when its audit silently refuses a write, then permits retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise({ try: () => setup(), catch: () => undefined });
      const post = (): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input()),
          })
        );
      yield* Effect.tryPromise({
        try: () =>
          db
            .prepare(`CREATE TRIGGER refuse_capture_audit BEFORE INSERT ON transaction_audit
    WHEN NEW.operation = 'transactions.createTransaction' BEGIN SELECT RAISE(IGNORE); END`)
            .run(),
        catch: () => undefined,
      });
      expect((yield* Effect.tryPromise({ try: post, catch: () => undefined })).status).not.toBe(
        201
      );
      const count = (
        table: "transactions" | "source_attestations"
      ): Effect.Effect<Option.Option<{ total: number }>, void> =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(`SELECT count(*) AS total FROM ${table} WHERE user_id = ?`)
              .bind(users[0])
              .first<{ total: number }>(),
          catch: () => undefined,
        }).pipe(Effect.map(Option.fromNullishOr));
      expect(Option.getOrUndefined(yield* count("transactions"))?.total).toBe(0);
      expect(Option.getOrUndefined(yield* count("source_attestations"))?.total).toBe(0);
      yield* Effect.tryPromise({
        try: () => db.prepare("DROP TRIGGER refuse_capture_audit").run(),
        catch: () => undefined,
      });
      expect((yield* Effect.tryPromise({ try: post, catch: () => undefined })).status).toBe(201);
      expect(Option.getOrUndefined(yield* count("transactions"))?.total).toBe(1);
    })
  ));

it("coordinates concurrent public mutations through a real per-User Durable Object binding", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup(true));
      const instance = instances.at(-1);
      if (instance === undefined) throw new Error("Missing Miniflare runtime");
      const namespace = yield* fromTestPromise(() =>
        instance.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR")
      );
      const coordinator = {
        getByName: (
          name: string
        ): Readonly<{ fetch: (command: Request) => Promise<Response> }> => ({
          fetch: (command: Request): Promise<Response> =>
            command.text().then((body) =>
              namespace
                .getByName(name)
                .fetch(command.url, {
                  method: command.method,
                  headers: Object.fromEntries(command.headers),
                  body,
                })
                .then(replayResponse)
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
      const results = yield* fromTestPromise(() => Promise.all([post(0), post(0), post(1)]));
      expect(results.map(({ status }) => status)).toEqual([201, 201, 201]);
      const transactions = results.map((response) => response.json());
      const [first, second, other] = yield* fromTestPromise(() => Promise.all(transactions));
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
      const ownerListResponse = yield* fromTestPromise(() => browse(0));
      const owner = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => ownerListResponse.json())
      ).pipe(Effect.orDie)).data;
      const neighborListResponse = yield* fromTestPromise(() => browse(1));
      const neighbor = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => neighborListResponse.json())
      ).pipe(Effect.orDie)).data;
      expect(new Set(owner.map(({ id }) => id))).toEqual(
        new Set(created.slice(0, 2).map(({ id }) => id))
      );
      expect(neighbor).toEqual([created[2]]);
      const protectedTransaction = created[0];
      if (protectedTransaction === undefined) throw new Error("Missing owner capture");
      expect(
        (yield* fromTestPromise(() => browse(1, `/transactions/${protectedTransaction.id}`))).status
      ).toBe(404);
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
      const [createdAgain, deleted] = yield* fromTestPromise(() =>
        Promise.all([post(0), attemptedDeletion])
      );
      expect(createdAgain.status).toBe(201);
      expect(deleted.status).not.toBe(200);
      const preservedListResponse = yield* fromTestPromise(() => browse(0));
      const preserved = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => preservedListResponse.json())
      ).pipe(Effect.orDie)).data;
      expect(preserved).toContainEqual(protectedTransaction);
      const evidence = yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM source_attestations WHERE transaction_id = ?")
          .bind(protectedTransaction.id)
          .first<{ count: number }>()
      );
      expect(evidence?.count).toBe(1);
    })
  ));

it("enforces the stable-User daily write budget atomically and preserves append-only evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      yield* fromTestPromise(() => seedDailyTransactions(db, 100));
      const session = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      if (Option.isNone(session)) throw new Error("Missing fixture session");
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(CreateTransactionInput))(
        input()
      ).pipe(Effect.orDie);
      expect(
        (yield* fromTestPromise(() =>
          createManualTransaction({ db, subject: session.value, input: decoded })
        )).status
      ).toBe(429);
      const rows = yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?")
          .bind(users[0])
          .first<{ count: number }>()
      );
      expect(rows?.count).toBe(100);
      const neighborSession = yield* fromTestPromise(() =>
        transactionSession({ request: request(1), db })
      );
      expect(
        (yield* fromTestPromise(() =>
          createManualTransaction({
            db,
            subject: Option.getOrThrow(neighborSession),
            input: decoded,
          })
        )).status
      ).toBe(201);
      const evidence = yield* fromTestPromise(() =>
        db.prepare("SELECT id FROM transaction_audit").first<{ id: string }>()
      );
      if (evidence === null) throw new Error("Missing audit");
      yield* fromTestPromise(() =>
        expect(
          db.prepare("DELETE FROM transaction_audit WHERE id = ?").bind(evidence.id).run()
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(db.prepare("DELETE FROM source_attestations").run()).rejects.toThrow()
      );
    })
  ));

it("bounds authenticated audit growth atomically per stable User at the public boundary", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const current = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 256)
    INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT 'budget-seed-' || n, ?, ?, 'transactions.listTransactions', 'success', ? FROM seq`)
          .bind(users[0], sessions[0], current)
          .run()
      );
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
      expect((yield* fromTestPromise(() => call(0))).status).toBe(429);
      // The expensive history batch must not run once this User is admitted no further reads.
      const cheapDb: D1Database = {
        prepare: (sql) => db.prepare(sql),
        batch: () => Promise.reject(new Error("History batch must not run")),
        exec: (sql) => db.exec(sql),
        withSession: (constraint) => db.withSession(constraint),
        dump: () => db.dump(),
      };
      const cheapRefusal = yield* fromTestPromise(() =>
        sendPublicRequest(
          cheapDb,
          new Request("https://api.fidyapp.com/transactions", {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
            },
          })
        )
      );
      expect(cheapRefusal.status).toBe(429);
      expect((yield* fromTestPromise(() => call(0, "/transactions?unknown=1"))).status).toBe(429);
      expect((yield* fromTestPromise(() => call(0, "/transactions", input()))).status).toBe(429);
      expect((yield* fromTestPromise(() => call(1))).status).toBe(200);
      const audit = yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ?")
          .bind(users[0])
          .first<{ count: number }>()
      );
      const transactions = yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?")
          .bind(users[0])
          .first<{ count: number }>()
      );
      expect(audit?.count).toBe(256);
      expect(transactions?.count).toBe(0);
    })
  ));

it("rejects forged browser origins and malformed Money before any public mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
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
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(db, post("https://attacker.test", input()))
        )).status
      ).toBe(403);
      expect(
        (yield* fromTestPromise(() =>
          sendPublicRequest(
            db,
            post("https://app.fidyapp.com", input({ money: { amount: "1e4", currency: "COP" } }))
          )
        )).status
      ).toBe(400);
      const counts = yield* fromTestPromise(() =>
        Promise.all(
          ["transactions", "source_attestations", "transaction_audit"].map((table) =>
            db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
          )
        )
      );
      expect(counts.map((result) => result?.count)).toEqual([0, 0, 1]);
      const created = yield* fromTestPromise(() =>
        sendPublicRequest(db, post("https://app.fidyapp.com", input()))
      );
      expect(created.status).toBe(201);
      const transaction = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => created.json())
      ).pipe(Effect.orDie)).data;
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
      const ownerBrowseResponse = yield* fromTestPromise(() => browse(0));
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => ownerBrowseResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([transaction]);
      const neighborBrowseResponse = yield* fromTestPromise(() => browse(1));
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => neighborBrowseResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() => browse(1, `/transactions/${transaction.id}`))).status
      ).toBe(404);
      const tokenOnly = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com/transactions/${transaction.id}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              authorization: `Bearer ${bearer(0)}`,
              "x-provider-id": users[0] ?? "",
            },
          })
        )
      );
      expect(tokenOnly.status).toBe(401);
      const foreignWithBearer = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com/transactions/${transaction.id}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(1)}`,
              authorization: `Bearer ${bearer(0)}`,
              "x-provider-id": users[0] ?? "",
            },
          })
        )
      );
      expect(foreignWithBearer.status).toBe(404);
      expect((yield* fromTestPromise(() => browse(1, "/transactions/not-an-id"))).status).toBe(404);
      expect((yield* fromTestPromise(() => browse(0, "/transactions?unknown=1"))).status).toBe(400);
      const outcomes = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT outcome FROM transaction_audit WHERE user_id = ? AND operation = 'transactions.getTransaction'"
          )
          .bind(users[1])
          .all<{ outcome: string }>()
      );
      expect(outcomes.results.map(({ outcome }) => outcome)).toEqual([
        "not_found",
        "not_found",
        "not_found",
      ]);
      const invalidAudit = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT outcome FROM transaction_audit WHERE user_id = ? AND outcome = 'validation_failed'"
          )
          .bind(users[0])
          .first<{ outcome: string }>()
      );
      expect(invalidAudit?.outcome).toBe("validation_failed");
    })
  ));

it("continues the canonical history beyond its first bounded page without losing tied movements", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
      const previous = "2025-01-09T12:00:00.000Z";
      yield* fromTestPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 101)
    INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, notes, occurred_at, created_at)
    SELECT printf('00000000-0000-4000-8000-%012d', n), ?, '1', 'COP', 'outflow', ?, 'Pago literal', ?,
      CASE WHEN n = 101 THEN ? ELSE ? END FROM seq`)
          .bind(users[0], category, previous, previous, createdAt)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    VALUES (?, ?, '1', 'COP', 'inflow', ?, '2024-01-09T12:00:00.000Z', ?)`)
          .bind("00000000-0000-4000-8000-000000000999", users[0], category, previous)
          .run()
      );
      const subject = Option.getOrThrow(
        yield* fromTestPromise(() => transactionSession({ request: request(0), db }))
      );
      const first = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(0, "/transactions?direction=outflow"),
            subject,
            search: false,
            id: Option.none(),
          },
        })
      );
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
      const page = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => first.json())
      ).pipe(Effect.orDie);
      expect(page.data).toHaveLength(100);
      expect(page.next).toHaveLength(1);
      expect(page.next[0]?.tool).toBe("transactions.listTransactions");
      const cursor = page.next[0]?.args.query.cursor;
      if (cursor === undefined) throw new Error("Missing continuation");
      expect(page.next[0]?.args.query.direction).toBe("outflow");
      const second = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(
              0,
              `/transactions?direction=outflow&cursor=${encodeURIComponent(cursor)}`
            ),
            subject,
            search: false,
            id: Option.none(),
          },
        })
      );
      const remainder = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => second.json())
      ).pipe(Effect.orDie);
      expect(remainder.data).toHaveLength(1);
      expect(remainder.next).toEqual([]);
      expect(new Set([...page.data, ...remainder.data].map(({ id }) => id)).size).toBe(101);

      const search = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(0, "/transactions/search?q=Pago%20literal"),
            subject,
            id: Option.none(),
            search: true,
          },
        })
      );
      const SearchPage = Schema.Struct({
        data: Schema.Array(Schema.toCodecJson(Transaction)),
        next: Schema.Array(
          Schema.Struct({
            tool: Schema.String,
            args: Schema.Struct({
              query: Schema.Struct({ cursor: Schema.String, q: Schema.String }),
            }),
          })
        ),
      });
      const matches = yield* Schema.decodeUnknownEffect(SearchPage)(
        yield* fromTestPromise(() => search.json())
      );
      expect(matches.data).toHaveLength(100);
      expect(matches.next[0]?.tool).toBe("transactions.searchTransactions");
      expect(matches.next[0]?.args.query.q).toBe("Pago literal");
      const searchCursor = Option.getOrThrow(
        Option.fromUndefinedOr(matches.next[0]?.args.query.cursor)
      );
      const nextSearch = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(
              0,
              `/transactions/search?q=Pago%20literal&cursor=${encodeURIComponent(searchCursor)}`
            ),
            subject,
            id: Option.none(),
            search: true,
          },
        })
      );
      const lastPage = yield* Schema.decodeUnknownEffect(SearchPage)(
        yield* fromTestPromise(() => nextSearch.json())
      );
      expect(lastPage.data).toHaveLength(1);
      expect(lastPage.next).toEqual([]);
      expect(new Set([...matches.data, ...lastPage.data].map(({ id }) => id)).size).toBe(101);
    })
  ));

it("commits exact manual Money, immutable capture context, and audit before canonical browsing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input({ counterparty: "Acme" })))
      );
      if (Option.isNone(owner) || Option.isNone(parsed)) throw new Error("fixture invalid");
      const response = yield* fromTestPromise(() =>
        createManualTransaction({ db, subject: owner.value, input: parsed.value })
      );
      expect(response.status).toBe(201);
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(encodeMoneyAmount(created.data.money.amount)).toBe("9007199254740993.15");
      expect(Option.getOrNull(created.data.counterparty)).toBe("Acme");
      const listed = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(0),
            subject: owner.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => listed.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([created.data]);
      const evidence = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT kind, service_market, locale, time_zone, interpretation_revision FROM source_attestations WHERE user_id = ?"
          )
          .bind(users[0])
          .all()
      );
      expect(evidence.results).toEqual([
        {
          kind: "manual",
          service_market: "CO",
          locale: "es-CO",
          time_zone: "America/Bogota",
          interpretation_revision: "manual-v1",
        },
      ]);
      const audit = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation FROM transaction_audit WHERE user_id = ? ORDER BY occurred_at_ms"
          )
          .bind(users[0])
          .all()
      );
      expect(
        audit.results
          .map((row) => row.operation)
          .sort((first, second) => String(first).localeCompare(String(second)))
      ).toEqual(["transactions.createTransaction", "transactions.listTransactions"]);
    })
  ));

it("neither a foreign opaque id nor another session can observe a Transaction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const other = yield* fromTestPromise(() => transactionSession({ request: request(1), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input()))
      );
      const tokenOnly = new Request("https://core.internal/transactions", {
        headers: { authorization: `Bearer ${bearer(0)}`, "x-provider-id": users[0] ?? "" },
      });
      expect(
        Option.isNone(yield* fromTestPromise(() => transactionSession({ request: tokenOnly, db })))
      ).toBe(true);
      if (Option.isNone(owner) || Option.isNone(other) || Option.isNone(parsed)) {
        throw new Error("fixture invalid");
      }
      const ownerLookupResponse = yield* fromTestPromise(() =>
        createManualTransaction({ db, subject: owner.value, input: parsed.value })
      );
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => ownerLookupResponse.json())
      ).pipe(Effect.orDie);

      const foreignLookupResponse = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(1),
            subject: other.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => foreignLookupResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() =>
          browseTransactions({
            db,
            selection: {
              request: request(1, `/transactions/${created.data.id}`),
              subject: other.value,
              search: false,
              id: Option.some(created.data.id),
            },
          })
        )).status
      ).toBe(404);
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(1, sessions[0])
          .run()
      );
      expect(
        Option.isNone(yield* fromTestPromise(() => transactionSession({ request: request(0), db })))
      ).toBe(true);
      expect(
        (yield* fromTestPromise(() =>
          createManualTransaction({ db, subject: owner.value, input: parsed.value })
        )).status
      ).toBe(401);
      expect(
        (yield* fromTestPromise(() =>
          browseTransactions({
            db,
            selection: {
              request: request(0),
              subject: owner.value,
              search: false,
              id: Option.none(),
            },
          })
        )).status
      ).toBe(401);
      const otherSessionLookupResponse = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(1),
            subject: other.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => otherSessionLookupResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() =>
          db.prepare("SELECT COUNT(*) AS count FROM transactions").first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
  ));

it("serializes concurrent mutations for one User without mixing another User's records", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const first = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const second = yield* fromTestPromise(() => transactionSession({ request: request(1), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input()))
      );
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
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(CreateTransactionInput))(
        parsed.value
      ).pipe(Effect.orDie);
      const command = (session: typeof first.value): Request =>
        new Request("https://coordinator.internal/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            _tag: "WebSessionCapture",
            sessionId: session.id,
            userId: session.userId,
            digest: Array.from(session.digest),
            input: encoded,
          }),
        });
      const responses = yield* fromTestPromise(() =>
        Promise.all([
          coordinatorA.fetch(command(first.value)),
          coordinatorA.fetch(command(first.value)),
          coordinatorB.fetch(command(second.value)),
        ])
      );
      expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
      expect(
        (yield* fromTestPromise(() => coordinatorB.fetch(command(first.value)))).status
      ).not.toBe(201);
      const firstList = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(0),
            subject: first.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      const secondList = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: {
            request: request(1),
            subject: second.value,
            search: false,
            id: Option.none(),
          },
        })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => firstList.json())
        ).pipe(Effect.orDie)).data
      ).toHaveLength(2);
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => secondList.json())
        ).pipe(Effect.orDie)).data
      ).toHaveLength(1);
    })
  ));

it("records one rejected audit when an atomic capture hits its resource limit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input()))
      );
      if (Option.isNone(owner) || Option.isNone(parsed)) throw new Error("fixture invalid");
      const limitedDb: D1Database = {
        prepare: (sql) => db.prepare(sql),
        batch: () => Promise.reject(new Error("transaction_resource_limit")),
        exec: (sql) => db.exec(sql),
        withSession: (constraint) => db.withSession(constraint),
        dump: () => db.dump(),
      };
      const response = yield* fromTestPromise(() =>
        createManualTransaction({ db: limitedDb, subject: owner.value, input: parsed.value })
      );
      expect(response.status).toBe(429);
      const audit = yield* fromTestPromise(() =>
        db.prepare("SELECT outcome FROM transaction_audit WHERE user_id = ?").bind(users[0]).all()
      );
      expect(audit.results).toEqual([{ outcome: "resource_limit" }]);
      const transactions = yield* fromTestPromise(() =>
        db.prepare("SELECT COUNT(*) AS count FROM transactions").first<{ count: number }>()
      );
      expect(transactions?.count).toBe(0);
    })
  ));

it("rejects an unknown Category without retaining partial Transaction, attestation, or audit state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession({ request: request(0), db }));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(
          request(0, "/transactions", input({ categoryId: "10000000-0000-4000-8000-000000009999" }))
        )
      );
      if (Option.isNone(owner) || Option.isNone(parsed)) {
        throw new Error("fixture invalid");
      }
      expect(
        (yield* fromTestPromise(() =>
          createManualTransaction({ db, subject: owner.value, input: parsed.value })
        )).status
      ).not.toBe(201);
      const counts = yield* fromTestPromise(() =>
        Promise.all(
          ["transactions", "source_attestations", "transaction_audit"].map((table) =>
            db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>()
          )
        )
      );
      expect(counts.map((result) => result?.count)).toEqual([0, 0, 1]);
    })
  ));

it("commits an ordered two-child batch in one D1 unit and agrees with immediate canonical reads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const counted = countingDb(db);
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          counted.db,
          batchRequest(0, [
            transactionCall(1, input({ counterparty: "Acme" })),
            transactionCall(
              2,
              input({
                counterparty: "Bravo",
                categoryId: "10000000-0000-4000-8000-000000000001",
              })
            ),
          ])
        )
      );
      expect(response.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(BatchResult)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(body.data.results.map(({ callId }) => callId)).toEqual([
        batchCallId(1),
        batchCallId(2),
      ]);
      expect(body.data.results.map(({ operation }) => operation)).toEqual([
        "transactions.createTransaction",
        "transactions.createTransaction",
      ]);
      const [first, second] = body.data.results.map(({ output }) => output.data);
      if (first === undefined || second === undefined) throw new Error("Missing results");
      expect(Option.getOrNull(first.counterparty)).toBe("Acme");
      expect(Option.getOrNull(second.counterparty)).toBe("Bravo");
      expect([first.revision, second.revision]).toEqual([0, 0]);
      expect(counted.batches()).toBe(1);

      const session = Option.getOrThrow(
        yield* fromTestPromise(() => transactionSession({ request: request(0), db }))
      );
      const listed = yield* fromTestPromise(() =>
        browseTransactions({
          db,
          selection: { request: request(0), subject: session, id: Option.none() },
        })
      );
      const page = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => listed.json())
      ).pipe(Effect.orDie);
      expect(new Set(page.data.map(({ id }) => id))).toEqual(new Set([first.id, second.id]));
      expect(page.data.find(({ id }) => id === first.id)).toEqual(first);
      expect(page.data.find(({ id }) => id === second.id)).toEqual(second);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(2);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ? AND outcome = 'success' AND operation = 'transactions.createTransaction'",
            users[0] ?? ""
          )
        )
      ).toBe(2);
    })
  ));

it("rolls back an earlier child when a later child's revision is stale", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000001";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, seededId, {
              expectedRevision: 1,
              changes: { notes: "late" },
            }),
          ])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM source_attestations")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_corrections")
        )
      ).toBe(0);
      const audits = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM transaction_audit WHERE user_id = ? ORDER BY occurred_at_ms"
          )
          .bind(users[0])
          .all<{ operation: string; outcome: string }>()
      );
      expect(audits.results).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
      ]);
    })
  ));

it("aborts the D1 unit and attributes the child when a guarded correction changes no row", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000002";
      const evidenceId = "30000000-0000-4000-8000-000000000012";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          racingBatch(db, () =>
            concurrentCorrection({
              db,
              userId: users[0] ?? "",
              transactionId: seededId,
              evidenceId,
            })
          ),
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, seededId, {
              expectedRevision: 0,
              changes: { notes: "batch" },
            }),
          ])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      // The earlier capture must not survive a guard that aborts at commit time, not after it.
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM source_attestations")
        )
      ).toBe(0);
      const evidence = yield* fromTestPromise(() =>
        db.prepare("SELECT id FROM transaction_corrections").all<{ id: string }>()
      );
      expect(evidence.results).toEqual([{ id: evidenceId }]);
      const audits = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM transaction_audit WHERE user_id = ? ORDER BY occurred_at_ms"
          )
          .bind(users[0])
          .all<{ operation: string; outcome: string }>()
      );
      expect(audits.results).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
      ]);
    })
  ));

it("rolls back earlier children and every success Audit when a child audit is silently refused", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000003";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`CREATE TRIGGER refuse_batch_correction_audit BEFORE INSERT ON transaction_audit
            WHEN NEW.operation = 'transactions.updateTransaction' BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, seededId, {
              expectedRevision: 0,
              changes: { notes: "refused audit" },
            }),
          ])
        )
      );
      expect(response.status).toBe(503);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM source_attestations")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_corrections")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("rejects a duplicate call identity before any child commits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const duplicate = transactionCall(1, input());
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [duplicate, transactionCall(1, input({ counterparty: "Dup" }))])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("fails closed on a canonical mutation without a batch adapter", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            {
              callId: batchCallId(2),
              operation: "transactions.deleteTransaction",
              input: { params: { id: "30000000-0000-4000-8000-000000000009" } },
            },
          ])
        )
      );
      expect(response.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("unavailable");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.deleteTransaction");
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("gives a stale correction the same refusal Audit alone and inside a batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const firstId = "30000000-0000-4000-8000-000000000004";
      const secondId = "30000000-0000-4000-8000-000000000005";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: firstId, categoryId: category })
      );
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: secondId, categoryId: category })
      );
      const individual = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request(`https://api.fidyapp.com/transactions/${firstId}`, {
            method: "PUT",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ expectedRevision: 1, changes: { notes: "alone" } }),
          })
        )
      );
      expect(individual.status).toBe(400);
      const batch = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, secondId, { expectedRevision: 1, changes: { notes: "batched" } }),
          ])
        )
      );
      expect(batch.status).toBe(400);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(2);
      const audits = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM transaction_audit WHERE user_id = ? ORDER BY occurred_at_ms"
          )
          .bind(users[0])
          .all<{ operation: string; outcome: string }>()
      );
      expect(audits.results).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
      ]);
    })
  ));

it("enforces each child's live PAT scope and commits a mixed two-child batch under one PAT unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000006";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const current = yield* Clock.currentTimeMillis;
      const writeToken = `fin_${"w".repeat(8)}_${"a".repeat(43)}`;
      const readToken = `fin_${"r".repeat(8)}_${"b".repeat(43)}`;
      yield* seedPAT({ db, userId: users[0] ?? "", token: writeToken, scopes: ["write"], current });
      yield* seedPAT({ db, userId: users[0] ?? "", token: readToken, scopes: ["read"], current });
      const refused = yield* fromTestPromise(() =>
        sendPublicRequest(db, bearerRequest(0, readToken, [transactionCall(1, input())]))
      );
      expect(refused.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => refused.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("scope_missing");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM pat_audit WHERE outcome = 'accepted'")
        )
      ).toBe(0);

      const committed = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          bearerRequest(0, writeToken, [
            transactionCall(1, input({ counterparty: "Agent capture" })),
            correctionCall(2, seededId, { expectedRevision: 0, changes: { notes: "agent" } }),
          ])
        )
      );
      expect(committed.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(BatchResult)(
        yield* fromTestPromise(() => committed.json())
      ).pipe(Effect.orDie);
      expect(body.data.results).toHaveLength(2);
      const audits = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM pat_audit WHERE operation LIKE 'transactions.%' ORDER BY operation"
          )
          .all<{ operation: string; outcome: string }>()
      );
      expect(audits.results).toEqual([
        { operation: "transactions.createTransaction", outcome: "accepted" },
        { operation: "transactions.updateTransaction", outcome: "accepted" },
      ]);
      const activity = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ last_used_at_ms: Schema.Int })
      )(
        yield* fromTestPromise(() =>
          db
            .prepare("SELECT last_used_at_ms FROM pats WHERE short_id = ?")
            .bind(writeToken.slice(4, 12))
            .first()
        )
      ).pipe(Effect.orDie);
      expect(activity.last_used_at_ms).toBeGreaterThan(0);
    })
  ));

it("serializes concurrent batches and individual mutations through one User coordination turn", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup(true));
      const instance = instances.at(-1);
      if (instance === undefined) throw new Error("Missing Miniflare runtime");
      const namespace = yield* fromTestPromise(() =>
        instance.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR")
      );
      const coordinator = {
        getByName: (
          name: string
        ): Readonly<{ fetch: (command: Request) => Promise<Response> }> => ({
          fetch: (command: Request): Promise<Response> =>
            command.text().then((body) =>
              namespace
                .getByName(name)
                .fetch(command.url, {
                  method: command.method,
                  headers: Object.fromEntries(command.headers),
                  body,
                })
                .then(replayResponse)
            ),
        }),
      };
      const individual = (index: number): Promise<Response> =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input({ counterparty: "Single" })),
          }),
          coordinator
        );
      const batch = (index: number, suffix: number): Promise<Response> =>
        sendPublicRequest(
          db,
          batchRequest(index, [
            transactionCall(suffix, input({ counterparty: `Batch ${suffix}` })),
            transactionCall(suffix + 1, input({ counterparty: `Batch ${suffix + 1}` })),
          ]),
          coordinator
        );
      const responses = yield* fromTestPromise(() =>
        Promise.all([individual(0), batch(0, 10), batch(0, 20), individual(1)])
      );
      expect(responses.map(({ status }) => status)).toEqual([201, 200, 200, 201]);
      const ownerList = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions", {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
            },
          }),
          coordinator
        )
      );
      const owner = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => ownerList.json())
      ).pipe(Effect.orDie);
      expect(owner.data).toHaveLength(5);
      expect(new Set(owner.data.map(({ id }) => id)).size).toBe(5);
      const neighborList = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/transactions", {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(1)}`,
            },
          }),
          coordinator
        )
      );
      const neighbor = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => neighborList.json())
      ).pipe(Effect.orDie);
      expect(neighbor.data).toHaveLength(1);
    })
  ));

it("attributes a per-day budget guard abort to the capture child that met it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const movementDb = yield* fromTestPromise(() => setup());
      yield* fromTestPromise(() => seedDailyTransactions(movementDb, 99));
      const limited = yield* fromTestPromise(() =>
        sendPublicRequest(
          movementDb,
          batchRequest(0, [transactionCall(1, input()), transactionCall(2, input())])
        )
      );
      expect(limited.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => limited.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("rate_limited");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.createTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            movementDb,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(99);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            movementDb,
            "SELECT COUNT(*) AS count FROM transaction_audit WHERE user_id = ? AND outcome = 'resource_limit'",
            users[0] ?? ""
          )
        )
      ).toBe(1);

      const auditDb = yield* fromTestPromise(() => setup());
      const current = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        auditDb
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 254)
    INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
    SELECT 'budget-seed-' || n, ?, ?, 'transactions.listTransactions', 'success', ? FROM seq`)
          .bind(users[0], sessions[0], current)
          .run()
      );
      const exhausted = yield* fromTestPromise(() =>
        sendPublicRequest(
          auditDb,
          batchRequest(0, [transactionCall(1, input()), transactionCall(2, input())])
        )
      );
      expect(exhausted.status).toBe(400);
      const exhaustedRejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => exhausted.json())
      ).pipe(Effect.orDie);
      expect(exhaustedRejection.error.code).toBe("rate_limited");
      expect(exhaustedRejection.error.failedCallIndex).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          countRows(auditDb, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(auditDb, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(255);
    })
  ));

it("fails closed on a foreign Transaction or an unknown Category without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const neighborId = "30000000-0000-4000-8000-000000000007";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[1] ?? "", id: neighborId, categoryId: category })
      );
      const foreign = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, neighborId, { expectedRevision: 0, changes: { notes: "foreign" } }),
          ])
        )
      );
      expect(foreign.status).toBe(400);
      const foreignRejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => foreign.json())
      ).pipe(Effect.orDie);
      expect(foreignRejection.error.code).toBe("not_found");
      expect(foreignRejection.error.failedCallIndex).toBe(1);
      expect(foreignRejection.error.operation).toBe("transactions.updateTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      const neighborRows = yield* fromTestPromise(() =>
        db
          .prepare("SELECT notes, revision FROM transactions WHERE user_id = ?")
          .bind(users[1])
          .all<{ notes: string; revision: number }>()
      );
      expect(neighborRows.results).toEqual([{ notes: "seed", revision: 0 }]);

      const unknown = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            transactionCall(1, input()),
            transactionCall(2, input({ categoryId: "10000000-0000-4000-8000-000000009999" })),
          ])
        )
      );
      expect(unknown.status).toBe(400);
      const unknownRejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => unknown.json())
      ).pipe(Effect.orDie);
      expect(unknownRejection.error.code).toBe("not_found");
      expect(unknownRejection.error.failedCallIndex).toBe(1);
      expect(unknownRejection.error.operation).toBe("transactions.createTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      const refusals = yield* fromTestPromise(() =>
        db
          .prepare("SELECT operation, outcome FROM transaction_audit WHERE user_id = ?")
          .bind(users[0])
          .all<{ operation: string; outcome: string }>()
      );
      expect(refusals.results.map(({ outcome }) => outcome)).toEqual(["not_found", "not_found"]);
      expect(new Set(refusals.results.map(({ operation }) => operation)).size).toBe(2);
    })
  ));

it("maps a batch dependency defect to the closed unavailable failure without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const brokenDb: D1Database = {
        prepare: (sql) => db.prepare(sql),
        batch: () => Promise.reject(new Error("database defect")),
        exec: (sql) => db.exec(sql),
        withSession: (constraint) => db.withSession(constraint),
        dump: () => db.dump(),
      };
      const response = yield* fromTestPromise(() =>
        sendPublicRequest(
          brokenDb,
          batchRequest(0, [transactionCall(1, input()), transactionCall(2, input())])
        )
      );
      expect(response.status).toBe(503);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("records a PAT refusal Audit for a refused batch child and attributes a PAT budget abort", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000008";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const current = yield* Clock.currentTimeMillis;
      const writeToken = `fin_${"t".repeat(8)}_${"c".repeat(43)}`;
      yield* seedPAT({ db, userId: users[0] ?? "", token: writeToken, scopes: ["write"], current });
      const refused = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          bearerRequest(0, writeToken, [
            transactionCall(1, input()),
            correctionCall(2, seededId, { expectedRevision: 9, changes: { notes: "stale" } }),
          ])
        )
      );
      expect(refused.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => refused.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      const refusals = yield* fromTestPromise(() =>
        db
          .prepare("SELECT operation, outcome FROM pat_audit WHERE user_id = ?")
          .bind(users[0])
          .all<{ operation: string; outcome: string }>()
      );
      expect(refusals.results).toEqual([
        { operation: "transactions.updateTransaction", outcome: "rejected" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          countRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);

      const budgetDb = yield* fromTestPromise(() => setup());
      yield* fromTestPromise(() => seedDailyTransactions(budgetDb, 99));
      const budgetToken = `fin_${"u".repeat(8)}_${"d".repeat(43)}`;
      yield* seedPAT({
        db: budgetDb,
        userId: users[0] ?? "",
        token: budgetToken,
        scopes: ["write"],
        current,
      });
      const limited = yield* fromTestPromise(() =>
        sendPublicRequest(
          budgetDb,
          bearerRequest(0, budgetToken, [transactionCall(1, input()), transactionCall(2, input())])
        )
      );
      expect(limited.status).toBe(400);
      const limitedRejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => limited.json())
      ).pipe(Effect.orDie);
      expect(limitedRejection.error.code).toBe("rate_limited");
      expect(limitedRejection.error.failedCallIndex).toBe(1);
      expect(limitedRejection.error.operation).toBe("transactions.createTransaction");
      expect(
        yield* fromTestPromise(() =>
          countRows(
            budgetDb,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(99);
      const budgetRefusals = yield* fromTestPromise(() =>
        budgetDb
          .prepare("SELECT operation, outcome FROM pat_audit WHERE user_id = ?")
          .bind(users[0])
          .all<{ operation: string; outcome: string }>()
      );
      expect(budgetRefusals.results).toEqual([
        { operation: "transactions.createTransaction", outcome: "rejected" },
      ]);
    })
  ));

it("refuses a batch under a revoked session, revoked PAT, or withdrawn Consent without writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const current = yield* Clock.currentTimeMillis;
      const token = `fin_${"v".repeat(8)}_${"e".repeat(43)}`;
      yield* seedPAT({ db, userId: users[0] ?? "", token, scopes: ["write"], current });
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(current, sessions[0])
          .run()
      );
      const revokedSession = yield* fromTestPromise(() =>
        sendPublicRequest(db, batchRequest(0, [transactionCall(1, input())]))
      );
      expect(revokedSession.status).toBe(401);
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE pats SET revoked_at_ms = ? WHERE short_id = ?")
          .bind(current, token.slice(4, 12))
          .run()
      );
      const revokedPAT = yield* fromTestPromise(() =>
        sendPublicRequest(db, bearerRequest(0, token, [transactionCall(1, input())]))
      );
      expect(revokedPAT.status).toBe(401);

      const neighborToken = `fin_${"w".repeat(8)}_${"f".repeat(43)}`;
      yield* seedPAT({
        db,
        userId: users[1] ?? "",
        token: neighborToken,
        scopes: ["write"],
        current,
      });
      const grantId = "50000000-0000-4000-8000-000000000001";
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO onboarding_consent_records
            (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
            VALUES (?,?,'{}','disclosure','decision',?,?)`)
          .bind(grantId, users[1], current, current)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO consent_user_revocations (id,user_id,grant_record_id,session_id,occurred_at_ms)
            VALUES (?,?,?,?,?)`)
          .bind("50000000-0000-4000-8000-000000000002", users[1], grantId, sessions[1], current)
          .run()
      );
      const withdrawn = yield* fromTestPromise(() =>
        sendPublicRequest(db, bearerRequest(1, neighborToken, [transactionCall(1, input())]))
      );
      expect(withdrawn.status).toBe(403);
      const withdrawal = yield* Schema.decodeUnknownEffect(CallerFailure)(
        yield* fromTestPromise(() => withdrawn.json())
      ).pipe(Effect.orDie);
      expect(withdrawal.error.code).toBe("user_action_required");
      const neighborSession = yield* fromTestPromise(() =>
        sendPublicRequest(db, batchRequest(1, [transactionCall(1, input())]))
      );
      expect(neighborSession.status).toBe(401);

      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(0);
    })
  ));

it("attributes a malformed child to its index and Audit while an unshaped body stays unattributed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const malformed = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              calls: [
                {
                  callId: "not-a-uuid",
                  operation: "transactions.createTransaction",
                  input: { payload: {} },
                },
              ],
            }),
          })
        )
      );
      expect(malformed.status).toBe(400);
      const childFailure = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => malformed.json())
      ).pipe(Effect.orDie);
      expect(childFailure.error.code).toBe("validation_failed");
      expect(childFailure.error.failedCallIndex).toBe(0);
      expect(childFailure.error.operation).toBe("transactions.createTransaction");
      const refusals = yield* fromTestPromise(() =>
        db
          .prepare("SELECT operation, outcome FROM transaction_audit WHERE user_id = ?")
          .bind(users[0])
          .all<{ operation: string; outcome: string }>()
      );
      expect(refusals.results).toEqual([
        { operation: "transactions.createTransaction", outcome: "validation_failed" },
      ]);
      expect(
        yield* fromTestPromise(() => countRows(db, "SELECT COUNT(*) AS count FROM transactions"))
      ).toBe(0);

      const unshaped = yield* fromTestPromise(() => sendPublicRequest(db, batchRequest(0, [])));
      expect(unshaped.status).toBe(400);
      const unshapedFailure = yield* Schema.decodeUnknownEffect(CallerFailure)(
        yield* fromTestPromise(() => unshaped.json())
      ).pipe(Effect.orDie);
      expect(unshapedFailure.error.code).toBe("validation_failed");
      expect(
        yield* fromTestPromise(() =>
          countRows(db, "SELECT COUNT(*) AS count FROM transaction_audit")
        )
      ).toBe(1);
    })
  ));

it("attributes a repeated observed revision to the later correction without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const seededId = "30000000-0000-4000-8000-000000000009";
      yield* fromTestPromise(() =>
        seedTransaction({ db, userId: users[0] ?? "", id: seededId, categoryId: category })
      );
      const repeated = yield* fromTestPromise(() =>
        sendPublicRequest(
          db,
          batchRequest(0, [
            correctionCall(1, seededId, { expectedRevision: 0, changes: { notes: "first" } }),
            correctionCall(2, seededId, { expectedRevision: 0, changes: { notes: "second" } }),
          ])
        )
      );
      expect(repeated.status).toBe(400);
      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => repeated.json())
      ).pipe(Effect.orDie);
      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      const retained = yield* fromTestPromise(() =>
        db
          .prepare("SELECT notes, revision FROM transactions WHERE user_id = ? AND id = ?")
          .bind(users[0], seededId)
          .all<{ notes: string; revision: number }>()
      );
      expect(retained.results).toEqual([{ notes: "seed", revision: 0 }]);
      const refusedAudits = yield* fromTestPromise(() =>
        db
          .prepare("SELECT operation, outcome FROM transaction_audit WHERE user_id = ?")
          .bind(users[0])
          .all<{ operation: string; outcome: string }>()
      );
      expect(refusedAudits.results).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
      ]);
    })
  ));
