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
import coreWorker from "./core-worker";
import publicWorker from "./public-worker";
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
  Bun.file(new URL(`./migrations/${name}.sql`, import.meta.url))
    .text()
    .then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |INSERT |$)/u)
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
      const today = DateTime.formatIso(DateTime.nowUnsafe());
      yield* fromTestPromise(() =>
        db
          .prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100)
    INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    SELECT 'seed-' || n, ?, '1', 'COP', 'outflow', ?, ?, ? FROM seq`)
          .bind(users[0], category, today, today)
          .run()
      );
      const session = yield* fromTestPromise(() => transactionSession(request(0), db));
      if (Option.isNone(session)) throw new Error("Missing fixture session");
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(CreateTransactionInput))(
        input()
      ).pipe(Effect.orDie);
      expect(
        (yield* fromTestPromise(() => createManualTransaction(db, session.value, decoded))).status
      ).toBe(429);
      const rows = yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?")
          .bind(users[0])
          .first<{ count: number }>()
      );
      expect(rows?.count).toBe(100);
      const neighborSession = yield* fromTestPromise(() => transactionSession(request(1), db));
      expect(
        (yield* fromTestPromise(() =>
          createManualTransaction(db, Option.getOrThrow(neighborSession), decoded)
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
    INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at, created_at)
    SELECT printf('00000000-0000-4000-8000-%012d', n), ?, '1', 'COP', 'outflow', ?, ?,
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
        yield* fromTestPromise(() => transactionSession(request(0), db))
      );
      const first = yield* fromTestPromise(() =>
        browseTransactions(db, {
          request: request(0, "/transactions?direction=outflow"),
          subject,
          id: Option.none(),
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
        browseTransactions(db, {
          request: request(
            0,
            `/transactions?direction=outflow&cursor=${encodeURIComponent(cursor)}`
          ),
          subject,
          id: Option.none(),
        })
      );
      const remainder = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => second.json())
      ).pipe(Effect.orDie);
      expect(remainder.data).toHaveLength(1);
      expect(remainder.next).toEqual([]);
      expect(new Set([...page.data, ...remainder.data].map(({ id }) => id)).size).toBe(101);
    })
  ));

it("commits exact manual Money, immutable capture context, and audit before canonical browsing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession(request(0), db));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input({ counterparty: "Acme" })))
      );
      if (Option.isNone(owner) || Option.isNone(parsed)) throw new Error("fixture invalid");
      const response = yield* fromTestPromise(() =>
        createManualTransaction(db, owner.value, parsed.value)
      );
      expect(response.status).toBe(201);
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(encodeMoneyAmount(created.data.money.amount)).toBe("9007199254740993.15");
      expect(Option.getOrNull(created.data.counterparty)).toBe("Acme");
      const listed = yield* fromTestPromise(() =>
        browseTransactions(db, {
          request: request(0),
          subject: owner.value,
          id: Option.none(),
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
      const owner = yield* fromTestPromise(() => transactionSession(request(0), db));
      const other = yield* fromTestPromise(() => transactionSession(request(1), db));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(request(0, "/transactions", input()))
      );
      const tokenOnly = new Request("https://core.internal/transactions", {
        headers: { authorization: `Bearer ${bearer(0)}`, "x-provider-id": users[0] ?? "" },
      });
      expect(Option.isNone(yield* fromTestPromise(() => transactionSession(tokenOnly, db)))).toBe(
        true
      );
      if (Option.isNone(owner) || Option.isNone(other) || Option.isNone(parsed)) {
        throw new Error("fixture invalid");
      }
      const ownerLookupResponse = yield* fromTestPromise(() =>
        createManualTransaction(db, owner.value, parsed.value)
      );
      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => ownerLookupResponse.json())
      ).pipe(Effect.orDie);

      const foreignLookupResponse = yield* fromTestPromise(() =>
        browseTransactions(db, {
          request: request(1),
          subject: other.value,
          id: Option.none(),
        })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => foreignLookupResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() =>
          browseTransactions(db, {
            request: request(1, `/transactions/${created.data.id}`),
            subject: other.value,
            id: Option.some(created.data.id),
          })
        )).status
      ).toBe(404);
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(1, sessions[0])
          .run()
      );
      expect(Option.isNone(yield* fromTestPromise(() => transactionSession(request(0), db)))).toBe(
        true
      );
      expect(
        (yield* fromTestPromise(() => createManualTransaction(db, owner.value, parsed.value)))
          .status
      ).toBe(401);
      expect(
        (yield* fromTestPromise(() =>
          browseTransactions(db, { request: request(0), subject: owner.value, id: Option.none() })
        )).status
      ).toBe(401);
      const otherSessionLookupResponse = yield* fromTestPromise(() =>
        browseTransactions(db, {
          request: request(1),
          subject: other.value,
          id: Option.none(),
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
      const first = yield* fromTestPromise(() => transactionSession(request(0), db));
      const second = yield* fromTestPromise(() => transactionSession(request(1), db));
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
            _tag: "WebSession",
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
        browseTransactions(db, {
          request: request(0),
          subject: first.value,
          id: Option.none(),
        })
      );
      const secondList = yield* fromTestPromise(() =>
        browseTransactions(db, {
          request: request(1),
          subject: second.value,
          id: Option.none(),
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

it("rejects an unknown Category without retaining partial Transaction, attestation, or audit state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const owner = yield* fromTestPromise(() => transactionSession(request(0), db));
      const parsed = yield* fromTestPromise(() =>
        transactionInput(
          request(0, "/transactions", input({ categoryId: "10000000-0000-4000-8000-000000009999" }))
        )
      );
      if (Option.isNone(owner) || Option.isNone(parsed)) {
        throw new Error("fixture invalid");
      }
      expect(
        (yield* fromTestPromise(() => createManualTransaction(db, owner.value, parsed.value)))
          .status
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
