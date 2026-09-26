import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";

const instances: Array<Miniflare> = [];
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "20000000-0000-4000-8000-000000000002";
const domicilios = "10000000-0000-4000-8000-000000000002";
const mercado = "10000000-0000-4000-8000-000000000003";
const transporte = "10000000-0000-4000-8000-000000000004";
const ingresos = "10000000-0000-4000-8000-000000000015";
const otros = "10000000-0000-4000-8000-000000000016";
const foreignCategory = "90000000-0000-4000-8000-000000000009";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure")<{ cause: unknown }> {}
const awaitPromise = <A>(
  promise: PromiseLike<A> | A
): Effect.Effect<Awaited<A>, TestPromiseFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise),
    catch: (cause) => new TestPromiseFailure({ cause }),
  });
const runTest = <A, E>(work: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(work);
const decodeJson = <A>(
  schema: Schema.Codec<A, unknown>,
  response: Response
): Effect.Effect<A, TestPromiseFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const body: unknown = yield* awaitPromise(response.json());
    return yield* Schema.decodeUnknownEffect(schema)(body);
  });
const clock = (): number => Effect.runSync(Clock.currentTimeMillis);
const dig = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));

const StoredRule = Schema.Struct({
  id: Schema.String,
  keyword: Schema.String,
  categoryId: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const RuleEnvelope = Schema.Struct({ data: StoredRule, next: Schema.Array(Schema.Unknown) });
const RuleListEnvelope = Schema.Struct({
  data: Schema.Array(StoredRule),
  next: Schema.Array(Schema.Unknown),
});
const RemovedEnvelope = Schema.Struct({ data: Schema.String, next: Schema.Array(Schema.Unknown) });
const TransactionEnvelope = Schema.Struct({
  data: Schema.Struct({ id: Schema.String, categoryId: Schema.String }),
  next: Schema.Array(Schema.Unknown),
});
const Issued = Schema.Struct({
  pat: Schema.Struct({ shortId: Schema.String }),
  bearer: Schema.String,
});
const IssuedEnvelope = Schema.Struct({ data: Issued });
const FailedBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  next: Schema.Array(Schema.Unknown),
});

type Send = Readonly<{ path: string; method: "GET" | "POST" | "PUT" | "DELETE" }> &
  Partial<
    Readonly<{
      payload: object;
      session: string;
      bearer: string;
      origin: string;
      originless: boolean;
    }>
  >;

const setup = (): Promise<{
  db: D1Database;
  send: (input: Send) => Promise<Response>;
  sessions: readonly [string, string];
}> =>
  runTest(
    Effect.gen(function* () {
      const mf = new Miniflare({
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: { DB: { id: "keyword-rules", type: "d1" } },
              manifest: {
                mainModule: "index.mjs",
                modules: {
                  "index.mjs": {
                    contents: "export default {fetch(){return new Response('ok')}}",
                    type: "esm",
                  },
                },
              },
              name: "keyword-rules",
              type: "worker",
            },
          },
        ],
      });
      instances.push(mf);
      yield* awaitPromise(mf.ready);
      const db = yield* awaitPromise(mf.getD1Database("DB"));
      const migrationNames = [
        "0001_categories",
        "0002_resource_admission",
        "0003_pending_consent",
        "0004_onboarding_email",
        "0005_verified_onboarding",
        "0006_browser_login",
        "0007_browser_pairing_email",
        "0008_support_recovery",
        "0009_email_replacement",
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
        "0016_hosted_turn",
        "0017_forwarded_email",
        "0017_statement_dispatch",
        "0018_batch_envelope_audit",
      ];
      for (const name of migrationNames) {
        const sql = yield* awaitPromise(
          Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text()
        );
        for (const statement of sql
          .replace(/^--.*$/gmu, "")
          .trim()
          .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)) {
          yield* awaitPromise(db.prepare(statement).run());
        }
      }
      const createSession = (user: string, index: number): Promise<string> =>
        runTest(
          Effect.gen(function* () {
            const current = clock();
            const token = String(index).repeat(43);
            const pairing = `30000000-0000-4000-8000-00000000000${index}`;
            const session = `40000000-0000-4000-8000-00000000000${index}`;
            yield* awaitPromise(
              db
                .prepare(
                  "INSERT INTO users (id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
                )
                .bind(user, current)
                .run()
            );
            yield* awaitPromise(
              db
                .prepare(`INSERT INTO browser_login_pairings (id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms)
      VALUES (?,?,?,?,'consumed',?,?)`)
                .bind(
                  pairing,
                  `BCDF-GHJ${index}`,
                  yield* awaitPromise(dig(token)),
                  user,
                  current - 1_000,
                  current + 599_000
                )
                .run()
            );
            yield* awaitPromise(
              db
                .prepare(`INSERT INTO web_sessions (id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`)
                .bind(
                  session,
                  pairing,
                  user,
                  yield* awaitPromise(dig(token)),
                  current,
                  current + 600_000,
                  current + 2_592_000_000,
                  current + 7_776_000_000
                )
                .run()
            );
            return `__Host-fidy_session=${token}`;
          })
        );
      const sessions = [
        yield* awaitPromise(createSession(userA, 1)),
        yield* awaitPromise(createSession(userB, 2)),
      ] as const;
      const coordinators = new Map<string, UserTransactionCoordinator>();
      const coreEnvironment = {
        DB: db,
        USER_TRANSACTION_COORDINATOR: {
          getByName: (name: string): Pick<Fetcher, "fetch"> => {
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
            return { fetch: (input) => coordinator.fetch(new Request(input)) };
          },
        },
        AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
        CONTRACT_DIGEST: "a".repeat(64),
        RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
        HOSTED_AI_MODEL: approvedWorkersAiModel,
        BROWSER_ORIGIN: "https://app.fidyapp.com",
        WOMPI_ENVIRONMENT: "",
        WOMPI_PUBLIC_KEY: "",
        WOMPI_PRIVATE_KEY: "",
        WOMPI_INTEGRITY_SECRET: "",
        KAPSO_API_KEY: "",
        KAPSO_WEBHOOK_SECRET: "unused",
        WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
        CLOUDFLARE_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
        CLOUDFLARE_ACCESS_AUDIENCE: "test",
      };
      const send = ({
        path,
        method,
        payload,
        session,
        bearer,
        origin,
        originless,
      }: Send): Promise<Response> => {
        const headers = new Headers({ "cf-connecting-ip": "198.51.100.10" });
        if (originless !== true) headers.set("origin", origin ?? "https://app.fidyapp.com");
        if (payload !== undefined) headers.set("content-type", "application/json");
        if (session !== undefined) headers.set("cookie", session);
        if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);
        return publicWorker.fetch(
          new Request(`https://api.fidyapp.com${path}`, {
            method,
            headers,
            body: payload === undefined ? undefined : JSON.stringify(payload),
          }),
          {
            BROWSER_ORIGIN: "https://app.fidyapp.com",
            LOCAL_CANONICAL_READ_BEARER: "",
            PAT_ADMISSION_KEY: "test-only-admission-keyword-rules",
            RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
            CORE: { fetch: (incoming) => coreWorker.fetch(new Request(incoming), coreEnvironment) },
          }
        );
      };
      return { db, send, sessions };
    })
  );

type SendFn = (input: Send) => Promise<Response>;
type RuleRequest = Readonly<{
  send: SendFn;
  session: string;
  keyword: string;
  categoryId: string;
}>;

const createRule = (
  request: Partial<RuleRequest> & Pick<RuleRequest, "send" | "session" | "keyword">
): Promise<Response> => {
  const { send, session, keyword, categoryId = domicilios } = request;
  return send({
    path: "/category-keyword-rules",
    method: "POST",
    session,
    payload: { keyword, categoryId },
  });
};

type CaptureRequest = Readonly<{
  send: SendFn;
  session: string;
  direction: "inflow" | "outflow";
  counterparty: string;
  categoryId: string;
}>;

const capture = (
  request: Partial<CaptureRequest> & Pick<CaptureRequest, "send" | "session">
): Promise<Response> => {
  const { send, session, direction = "outflow", counterparty, categoryId } = request;
  return send({
    path: "/transactions",
    method: "POST",
    session,
    payload: {
      money: { amount: "25000.00", currency: "COP" },
      direction,
      occurredAt: DateTime.formatIso(DateTime.makeUnsafe(clock() - 60_000)),
      ...(counterparty === undefined ? {} : { counterparty }),
      ...(categoryId === undefined ? {} : { categoryId }),
    },
  });
};

const issuePAT = (
  request: Readonly<{
    send: SendFn;
    session: string;
    scopes: ReadonlyArray<string>;
    index: number;
  }>
): Effect.Effect<typeof Issued.Type, TestPromiseFailure | Schema.SchemaError> => {
  const { send, session, scopes, index } = request;
  return Effect.gen(function* () {
    const response = yield* awaitPromise(
      send({
        path: "/pats",
        method: "POST",
        session,
        payload: {
          requestId: `70000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          grant: {
            recipientLabel: `Agent ${index}`,
            scopes,
            lifetimeDays: 7,
            reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(clock() + 7 * 86_400_000)),
          },
        },
      })
    );
    expect(response.status).toBe(200);
    return (yield* decodeJson(IssuedEnvelope, response)).data;
  });
};

const ruleCount = (db: D1Database, userId: string): Effect.Effect<number, TestPromiseFailure> =>
  awaitPromise(
    db
      .prepare("SELECT count(*) AS total FROM keyword_rules WHERE user_id = ?")
      .bind(userId)
      .first<{ total: number }>()
  ).pipe(Effect.map((row) => row?.total ?? 0));

const storedCategory = (
  db: D1Database,
  userId: string,
  id: string
): Effect.Effect<Option.Option<string>, TestPromiseFailure> =>
  awaitPromise(
    db
      .prepare("SELECT category_id FROM transactions WHERE user_id = ? AND id = ?")
      .bind(userId, id)
      .first<{ category_id: string }>()
  ).pipe(Effect.map((row) => Option.fromUndefinedOr(row?.category_id)));

afterEach(() => runTest(awaitPromise(Promise.all(instances.splice(0).map((mf) => mf.dispose())))));

it("lists and creates rules for exactly one User through the derived canonical contract", () =>
  runTest(
    Effect.gen(function* () {
      const { send, sessions } = yield* awaitPromise(setup());
      const created = yield* awaitPromise(
        createRule({ send, session: sessions[0], keyword: "Rappi Turbo", categoryId: domicilios })
      );
      expect(created.status).toBe(201);
      const rule = (yield* decodeJson(RuleEnvelope, created)).data;
      expect(rule.keyword).toBe("Rappi Turbo");
      expect(rule.categoryId).toBe(domicilios);

      const listed = yield* awaitPromise(
        send({ path: "/category-keyword-rules", method: "GET", session: sessions[0] })
      );
      expect(listed.status).toBe(200);
      const own = (yield* decodeJson(RuleListEnvelope, listed)).data;
      expect(own.map((entry) => entry.id)).toEqual([rule.id]);

      const other = yield* awaitPromise(
        send({ path: "/category-keyword-rules", method: "GET", session: sessions[1] })
      );
      expect(other.status).toBe(200);
      expect((yield* decodeJson(RuleListEnvelope, other)).data).toEqual([]);
    })
  ));

it("rejects a case- and accent-folded duplicate keyword without a partial effect", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      expect(
        (yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Rappi" }))).status
      ).toBe(201);
      const duplicate = yield* awaitPromise(
        createRule({ send, session: sessions[0], keyword: "RÁPPI", categoryId: mercado })
      );
      expect(duplicate.status).toBe(400);
      const body = yield* decodeJson(FailedBody, duplicate);
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.message).toContain("already");
      expect(yield* ruleCount(db, userA)).toBe(1);
    })
  ));

it("rejects an unknown Category, an oversized keyword, and a malformed body without storing a rule", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      expect(
        (yield* awaitPromise(
          createRule({
            send,
            session: sessions[0],
            keyword: "Fantasma",
            categoryId: foreignCategory,
          })
        )).status
      ).toBe(404);
      expect(
        (yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "x".repeat(81) })))
          .status
      ).toBe(400);
      expect(
        (yield* awaitPromise(
          send({
            path: "/category-keyword-rules",
            method: "POST",
            session: sessions[0],
            payload: { keyword: "   ", categoryId: domicilios },
          })
        )).status
      ).toBe(400);
      expect(
        (yield* awaitPromise(
          send({ path: "/category-keyword-rules", method: "GET", session: "unused" })
        )).status
      ).toBe(401);
      expect(yield* ruleCount(db, userA)).toBe(0);
    })
  ));

it("refuses the hundred-and-first retained rule while every earlier rule stays stored", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const current = DateTime.formatIso(DateTime.makeUnsafe(clock()));
      for (let index = 0; index < 100; index++) {
        yield* awaitPromise(
          db
            .prepare(
              `INSERT INTO keyword_rules (id,user_id,keyword,normalized_keyword,category_id,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?)`
            )
            .bind(
              `80000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
              userA,
              `tienda ${index}`,
              `tienda ${index}`,
              domicilios,
              current,
              current
            )
            .run()
        );
      }
      const refused = yield* awaitPromise(
        createRule({ send, session: sessions[0], keyword: "demasiada" })
      );
      expect(refused.status).toBe(400);
      expect(yield* ruleCount(db, userA)).toBe(100);
    })
  ));

it("updates and deletes only the caller's own rule", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const created = (yield* decodeJson(
        RuleEnvelope,
        yield* awaitPromise(
          createRule({ send, session: sessions[0], keyword: "Rappi", categoryId: domicilios })
        )
      )).data;

      const foreignUpdate = yield* awaitPromise(
        send({
          path: `/category-keyword-rules/${created.id}`,
          method: "PUT",
          session: sessions[1],
          payload: { keyword: "Ajeno", categoryId: mercado },
        })
      );
      expect(foreignUpdate.status).toBe(404);
      const foreignDelete = yield* awaitPromise(
        send({
          path: `/category-keyword-rules/${created.id}`,
          method: "DELETE",
          session: sessions[1],
        })
      );
      expect(foreignDelete.status).toBe(404);

      const untouched = yield* awaitPromise(
        db
          .prepare("SELECT keyword, category_id, user_id FROM keyword_rules WHERE id = ?")
          .bind(created.id)
          .first<{ keyword: string; category_id: string; user_id: string }>()
      );
      expect(untouched).toEqual({ keyword: "Rappi", category_id: domicilios, user_id: userA });

      const updated = yield* awaitPromise(
        send({
          path: `/category-keyword-rules/${created.id}`,
          method: "PUT",
          session: sessions[0],
          payload: { keyword: "Rappi Turbo", categoryId: mercado },
        })
      );
      expect(updated.status).toBe(200);
      expect((yield* decodeJson(RuleEnvelope, updated)).data).toMatchObject({
        id: created.id,
        keyword: "Rappi Turbo",
        categoryId: mercado,
      });

      const removed = yield* awaitPromise(
        send({
          path: `/category-keyword-rules/${created.id}`,
          method: "DELETE",
          session: sessions[0],
        })
      );
      expect(removed.status).toBe(200);
      expect((yield* decodeJson(RemovedEnvelope, removed)).data).toBe(created.id);
      expect(yield* ruleCount(db, userA)).toBe(0);
    })
  ));

it("answers a path segment that is not a stable rule identity as not found on both routes", () =>
  runTest(
    Effect.gen(function* () {
      const { send, sessions } = yield* awaitPromise(setup());
      const malformedUpdate = yield* awaitPromise(
        send({
          path: "/category-keyword-rules/not-a-rule-id",
          method: "PUT",
          session: sessions[0],
          payload: { keyword: "Malformado", categoryId: mercado },
        })
      );
      expect(malformedUpdate.status).toBe(404);
      const malformedDelete = yield* awaitPromise(
        send({
          path: "/category-keyword-rules/not-a-rule-id",
          method: "DELETE",
          session: sessions[0],
        })
      );
      expect(malformedDelete.status).toBe(404);
    })
  ));

it("applies an explicit Category, then the most specific caller rule, then the direction fallback", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Rappi" }));
      yield* awaitPromise(
        createRule({ send, session: sessions[0], keyword: "Rappi Turbo", categoryId: mercado })
      );

      const specific = (yield* decodeJson(
        TransactionEnvelope,
        yield* awaitPromise(
          capture({ send, session: sessions[0], counterparty: "RAPPI TURBO Bogotá" })
        )
      )).data;
      expect(specific.categoryId).toBe(mercado);

      const general = (yield* decodeJson(
        TransactionEnvelope,
        yield* awaitPromise(capture({ send, session: sessions[0], counterparty: "Rappi" }))
      )).data;
      expect(general.categoryId).toBe(domicilios);

      const explicit = (yield* decodeJson(
        TransactionEnvelope,
        yield* awaitPromise(
          capture({ send, session: sessions[0], counterparty: "Rappi", categoryId: transporte })
        )
      )).data;
      expect(explicit.categoryId).toBe(transporte);

      const fallback = (yield* decodeJson(
        TransactionEnvelope,
        yield* awaitPromise(capture({ send, session: sessions[0] }))
      )).data;
      expect(fallback.categoryId).toBe(otros);
      expect(yield* storedCategory(db, userA, fallback.id)).toEqual(Option.some(otros));
      expect(yield* storedCategory(db, userA, specific.id)).toEqual(Option.some(mercado));
      expect(yield* storedCategory(db, userA, general.id)).toEqual(Option.some(domicilios));

      const inflow = (yield* decodeJson(
        TransactionEnvelope,
        yield* awaitPromise(capture({ send, session: sessions[0], direction: "inflow" }))
      )).data;
      expect(inflow.categoryId).toBe(ingresos);
    })
  ));

it("keeps a prior Transaction Category when its rule is replaced and when it is deleted", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const created = (yield* decodeJson(
        RuleEnvelope,
        yield* awaitPromise(
          createRule({ send, session: sessions[0], keyword: "Rappi", categoryId: domicilios })
        )
      )).data;
      const captured = (yield* decodeJson(
        TransactionEnvelope,
        yield* awaitPromise(capture({ send, session: sessions[0], counterparty: "Rappi" }))
      )).data;
      expect(captured.categoryId).toBe(domicilios);

      expect(
        (yield* awaitPromise(
          send({
            path: `/category-keyword-rules/${created.id}`,
            method: "PUT",
            session: sessions[0],
            payload: { keyword: "Rappi", categoryId: mercado },
          })
        )).status
      ).toBe(200);
      expect(yield* storedCategory(db, userA, captured.id)).toEqual(Option.some(domicilios));

      expect(
        (yield* awaitPromise(
          send({
            path: `/category-keyword-rules/${created.id}`,
            method: "DELETE",
            session: sessions[0],
          })
        )).status
      ).toBe(200);
      expect(yield* storedCategory(db, userA, captured.id)).toEqual(Option.some(domicilios));
      const afterDelete = (yield* decodeJson(
        TransactionEnvelope,
        yield* awaitPromise(capture({ send, session: sessions[0], counterparty: "Rappi" }))
      )).data;
      expect(afterDelete.categoryId).toBe(otros);
    })
  ));

it("does not let another User's rule categorize a capture or be read", () =>
  runTest(
    Effect.gen(function* () {
      const { send, sessions } = yield* awaitPromise(setup());
      yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Rappi" }));
      const captured = (yield* decodeJson(
        TransactionEnvelope,
        yield* awaitPromise(capture({ send, session: sessions[1], counterparty: "Rappi" }))
      )).data;
      expect(captured.categoryId).toBe(otros);
      const listed = yield* awaitPromise(
        send({ path: "/category-keyword-rules", method: "GET", session: sessions[1] })
      );
      expect((yield* decodeJson(RuleListEnvelope, listed)).data).toEqual([]);
    })
  ));

it("stores no rule when its guarded audit evidence cannot commit", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      yield* awaitPromise(
        db
          .prepare(`CREATE TRIGGER refuse_keyword_rule_audit BEFORE INSERT ON category_audit
    WHEN NEW.operation = 'categories.createKeywordRule' BEGIN SELECT RAISE(IGNORE); END`)
          .run()
      );
      const refused = yield* awaitPromise(
        createRule({ send, session: sessions[0], keyword: "Sin evidencia" })
      );
      expect(refused.status).not.toBe(201);
      expect(yield* ruleCount(db, userA)).toBe(0);
      yield* awaitPromise(db.prepare("DROP TRIGGER refuse_keyword_rule_audit").run());
      expect(
        (yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Sin evidencia" })))
          .status
      ).toBe(201);
    })
  ));

it("lets a write-scoped PAT manage rules while a read-scoped PAT cannot", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());

      const writer = (yield* issuePAT({ send, session: sessions[0], scopes: ["write"], index: 1 }))
        .bearer;
      const reader = (yield* issuePAT({ send, session: sessions[0], scopes: ["read"], index: 2 }))
        .bearer;

      const refused = yield* awaitPromise(
        send({
          path: "/category-keyword-rules",
          method: "POST",
          bearer: reader,
          payload: { keyword: "Agente", categoryId: domicilios },
        })
      );
      expect(refused.status).toBe(403);
      expect(yield* ruleCount(db, userA)).toBe(0);

      const created = yield* awaitPromise(
        send({
          path: "/category-keyword-rules",
          method: "POST",
          bearer: writer,
          payload: { keyword: "Agente", categoryId: mercado },
        })
      );
      expect(created.status).toBe(201);
      const rule = (yield* decodeJson(RuleEnvelope, created)).data;

      const listed = yield* awaitPromise(
        send({ path: "/category-keyword-rules", method: "GET", bearer: reader })
      );
      expect(listed.status).toBe(200);
      expect((yield* decodeJson(RuleListEnvelope, listed)).data).toMatchObject([
        { id: rule.id, keyword: "Agente", categoryId: mercado },
      ]);

      const refusedDelete = yield* awaitPromise(
        send({ path: `/category-keyword-rules/${rule.id}`, method: "DELETE", bearer: reader })
      );
      expect(refusedDelete.status).toBe(403);

      const audited = yield* awaitPromise(
        db
          .prepare("SELECT operation FROM pat_audit WHERE operation = ?")
          .bind("categories.createKeywordRule")
          .first()
      );
      expect(audited).not.toBeNull();
    })
  ));

it("refuses a rule change from a revoked WebSession without storing anything", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      yield* awaitPromise(
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE user_id = ?")
          .bind(clock(), userA)
          .run()
      );
      const refused = yield* awaitPromise(
        createRule({ send, session: sessions[0], keyword: "Revocada" })
      );
      expect(refused.status).toBe(401);
      expect(yield* ruleCount(db, userA)).toBe(0);
    })
  ));

it("refuses cookie-admitted keyword-rule work without the matching browser Origin", () =>
  runTest(
    Effect.gen(function* () {
      const { db, send, sessions } = yield* awaitPromise(setup());
      const created = (yield* decodeJson(
        RuleEnvelope,
        yield* awaitPromise(createRule({ send, session: sessions[0], keyword: "Rappi" }))
      )).data;
      const refusedRequests: ReadonlyArray<Send> = [
        { path: "/category-keyword-rules", method: "GET" },
        {
          path: "/category-keyword-rules",
          method: "POST",
          payload: { keyword: "Sin origen", categoryId: domicilios },
        },
        {
          path: `/category-keyword-rules/${created.id}`,
          method: "PUT",
          payload: { keyword: "Sin origen", categoryId: mercado },
        },
        { path: `/category-keyword-rules/${created.id}`, method: "DELETE" },
      ];
      for (const request of refusedRequests) {
        const originless = yield* awaitPromise(
          send({ ...request, session: sessions[0], originless: true })
        );
        expect(originless.status).toBe(403);
        const foreignOrigin = yield* awaitPromise(
          send({ ...request, session: sessions[0], origin: "https://evil.example" })
        );
        expect(foreignOrigin.status).toBe(403);
      }
      expect(yield* ruleCount(db, userA)).toBe(1);
      const untouched = yield* awaitPromise(
        db
          .prepare("SELECT keyword, category_id FROM keyword_rules WHERE id = ?")
          .bind(created.id)
          .first<{ keyword: string; category_id: string }>()
      );
      expect(untouched).toEqual({ keyword: "Rappi", category_id: domicilios });
      const audits = yield* awaitPromise(
        db
          .prepare("SELECT count(*) AS total FROM category_audit WHERE user_id = ?")
          .bind(userA)
          .first<{ total: number }>()
      );
      expect(audits?.total).toBe(1);

      const machine = yield* issuePAT({ send, session: sessions[0], scopes: ["write"], index: 9 });
      const machineCreate = yield* awaitPromise(
        send({
          path: "/category-keyword-rules",
          method: "POST",
          bearer: machine.bearer,
          originless: true,
          payload: { keyword: "Sin origen", categoryId: domicilios },
        })
      );
      expect(machineCreate.status).toBe(201);
    })
  ));
