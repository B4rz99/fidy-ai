import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  type InsightEvent,
  InsightEventId,
  InsightGenerationInput,
} from "@fidy/server/insights-runtime";
import { DeliveredInsight } from "../../src/shell/insights/operations";
import {
  discoverDueInsights,
  findInsight,
  findInsightAttempt,
  generateInsight,
  listPendingInsights,
  prepareInsightTransition,
} from "./insight-store";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";

const users = ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000052"];
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
const active: Array<Miniflare> = [];
let sequence = 0;
afterEach(() => Promise.all(active.splice(0).map((mf) => mf.dispose())));
// @effect-diagnostics-next-line asyncFunction:off
const migrate = async (db: D1Database, migration: string): Promise<void> => {
  const sql = await Bun.file(new URL(`../migrations/${migration}.sql`, import.meta.url)).text();
  const statements = sql
    .replace(/^--.*$/gmu, "")
    .trim()
    .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u);
  await statements.reduce<Promise<void>>(
    (prior, statement) =>
      prior.then(() =>
        db
          .prepare(statement)
          .run()
          .then(() => undefined)
      ),
    Promise.resolve()
  );
};
// @effect-diagnostics-next-line asyncFunction:off
const seedUser = async (db: D1Database, index: number, current: number): Promise<void> => {
  const user = users[index] ?? "";
  await db
    .prepare(
      "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
    )
    .bind(user, current)
    .run();
  const pairing = `10000000-0000-4000-8000-00000000007${index}`;
  await db
    .prepare(
      "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
    )
    .bind(pairing, `ABCD-123${index}`, new Uint8Array(32), user, current, current + 600000)
    .run();
  await db
    .prepare(
      "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      sessions[index],
      pairing,
      user,
      new Uint8Array(32).fill(index + 1),
      current,
      current + 600000,
      current + 3600000,
      current + 7776000000
    )
    .run();
};
// @effect-diagnostics-next-line asyncFunction:off
const setup = async (): Promise<D1Database> => {
  const name = `insights-${++sequence}`;
  const mf = new Miniflare({
    workers: [
      {
        config: {
          compatibilityDate: "2026-09-08",
          env: { DB: { id: name, type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch() {return new Response('ok')}}",
                type: "esm",
              },
            },
          },
          name,
          type: "worker",
        },
      },
    ],
  });
  active.push(mf);
  await mf.ready;
  const db = await mf.getD1Database("DB");
  const migrations = [
    "0001_categories",
    "0002_resource_admission",
    "0003_pending_consent",
    "0004_onboarding_email",
    "0005_verified_onboarding",
    "0006_browser_login",
    "0007_browser_pairing_email",
    "0008_support_recovery",
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
    "0018_insight_events",
  ];
  await migrations.reduce<Promise<void>>(
    (prior, migration) => prior.then(() => migrate(db, migration)),
    Promise.resolve()
  );
  const current = DateTime.nowUnsafe().epochMilliseconds;
  await users.reduce<Promise<void>>(
    (prior, _user, index) => prior.then(() => seedUser(db, index, current)),
    Promise.resolve()
  );
  return db;
};
const input = Schema.decodeSync(Schema.toCodecJson(InsightGenerationInput))({
  kind: "weekly-summary",
  scheduleId: "10000000-0000-4000-8000-000000000080",
  scheduleVersion: 2,
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  scheduledAt: "2026-08-09T23:00:00Z",
  moneyGroups: [
    {
      currency: "COP",
      inflow: { amount: "2000000", currency: "COP" },
      outflow: { amount: "850000", currency: "COP" },
    },
    {
      currency: "USD",
      inflow: { amount: "0", currency: "USD" },
      outflow: { amount: "24.5", currency: "USD" },
    },
  ],
});
const subject = (index: number): Readonly<{ id: string; userId: string; digest: Uint8Array }> => ({
  id: sessions[index] ?? "",
  userId: users[index] ?? "",
  digest: new Uint8Array(32).fill(index + 1),
});
const generated = (db: D1Database, index = 0): Promise<Option.Option<InsightEvent>> =>
  Effect.runPromise(generateInsight({ db, userId: users[index] ?? "", input }));
const send = (
  input: Readonly<{ db: D1Database; path: string }> &
    (Readonly<{ index: number }> | Readonly<{ pat: string }>) &
    (Readonly<{ method: "GET" }> | Readonly<{ method: "POST"; body: Option.Option<object> }>)
): Promise<Response> => {
  const { db, path, method } = input;
  const body = method === "POST" ? input.body : Option.none<object>();
  const coordinators = new Map<string, UserTransactionCoordinator>();
  return publicWorker.fetch(
    new Request(`https://api.fidyapp.com${path}`, {
      method,
      headers: {
        origin: "https://app.fidyapp.com",
        ...("pat" in input
          ? { authorization: `Bearer ${input.pat}` }
          : { cookie: `__Host-fidy_session=${String(input.index + 1).repeat(43)}` }),
        ...(Option.isNone(body) ? {} : { "content-type": "application/json" }),
      },
      ...(Option.isNone(body) ? {} : { body: JSON.stringify(body.value) }),
    }),
    {
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      LOCAL_CANONICAL_READ_BEARER: "",
      PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
      RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
      CORE: {
        fetch: (request) =>
          coreWorker.fetch(new Request(request), {
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
            KAPSO_API_KEY: "",
            KAPSO_WEBHOOK_SECRET: "",
            WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
            CLOUDFLARE_ACCESS_ISSUER: "",
            CLOUDFLARE_ACCESS_AUDIENCE: "",
            USER_TRANSACTION_COORDINATOR: {
              getByName: (name) => ({
                fetch: (command) => {
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
          }),
      },
    }
  );
};
// @effect-diagnostics-next-line asyncFunction:off
const authorizeBrowser = async (db: D1Database): Promise<void> => {
  await Promise.all(
    sessions.map((session, index) =>
      crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(String(index + 1).repeat(43)))
        .then((digest) =>
          db
            .prepare("UPDATE web_sessions SET token_digest = ? WHERE id = ?")
            .bind(new Uint8Array(digest), session)
            .run()
        )
    )
  );
};

// @effect-diagnostics-next-line asyncFunction:off
it("retains the first schedule context on replay and exposes only bounded due identities", async () => {
  const db = await setup();
  const first = await generated(db);
  expect(Option.isSome(first)).toBe(true);
  const again = await Effect.runPromise(
    generateInsight({ db, userId: users[0] ?? "", input: { ...input, moneyGroups: [] } })
  );
  expect(again).toEqual(first);
  const due = await Effect.runPromise(discoverDueInsights(db, "2026-08-10T00:00:00Z"));
  expect(due).toEqual(Option.some([{ userId: users[0], id: Option.getOrThrow(first).id }]));
  expect(
    Option.isNone(
      await Effect.runPromise(findInsight(db, users[1] ?? "", Option.getOrThrow(first).id))
    )
  ).toBe(true);
});

// @effect-diagnostics-next-line asyncFunction:off
it("commits one delivery with immutable evidence, then rejects replay and stale lifecycle transitions", async () => {
  const db = await setup();
  const event = Option.getOrThrow(await generated(db));
  const evidence = Schema.decodeSync(Schema.toCodecJson(InsightGenerationInput.fields.scheduledAt))(
    "2026-08-09T23:00:08Z"
  );
  const prepared = await Effect.runPromise(
    prepareInsightTransition({
      db,
      subject: subject(0),
      operation: "insights.markInsightDelivered",
      id: event.id,
      evidence: Option.some({
        sentAt: evidence,
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: "wamid.1",
      }),
      current: DateTime.nowUnsafe().epochMilliseconds,
    })
  );
  expect(prepared._tag).toBe("Prepared");
  if (prepared._tag !== "Prepared") return;
  await db.batch([...prepared.mutation.statements, prepared.mutation.completion]);
  expect(
    Option.getOrThrow(await Effect.runPromise(findInsight(db, users[0] ?? "", event.id)))
      .lifecycleState
  ).toBe("delivered");
  const replay = await Effect.runPromise(
    prepareInsightTransition({
      db,
      subject: subject(0),
      operation: "insights.markInsightDelivered",
      id: event.id,
      evidence: Option.some({
        sentAt: evidence,
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: "wamid.2",
      }),
      current: DateTime.nowUnsafe().epochMilliseconds,
    })
  );
  expect(replay._tag).toBe("Refused");
  const read = await Effect.runPromise(
    prepareInsightTransition({
      db,
      subject: subject(0),
      operation: "insights.markInsightRead",
      id: event.id,
      evidence: Option.none(),
      current: DateTime.nowUnsafe().epochMilliseconds,
    })
  );
  if (read._tag !== "Prepared") throw new Error("read should be prepared");
  await db.batch([...read.mutation.statements, read.mutation.completion]);
  expect(
    (
      await Effect.runPromise(
        listPendingInsights({
          db,
          subject: subject(0),
          request: new Request("https://api.fidyapp.com/insights/pending"),
        })
      )
    ).status
  ).toBe(200);
  expect(
    Option.getOrThrow(await Effect.runPromise(findInsight(db, users[0] ?? "", event.id)))
      .lifecycleState
  ).toBe("read");
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects a foreign event before writing any lifecycle or delivery evidence", async () => {
  const db = await setup();
  const event = Option.getOrThrow(await generated(db));
  const result = await Effect.runPromise(
    prepareInsightTransition({
      db,
      subject: subject(1),
      operation: "insights.dismissInsight",
      id: InsightEventId.make(event.id),
      evidence: Option.none(),
      current: DateTime.nowUnsafe().epochMilliseconds,
    })
  );
  expect(result._tag).toBe("Refused");
  expect(
    Option.getOrThrow(await Effect.runPromise(findInsight(db, users[0] ?? "", event.id)))
      .lifecycleState
  ).toBe("pending");
});

// @effect-diagnostics-next-line asyncFunction:off
it("a stale read prepared before dismissal cannot regress the dismissed event", async () => {
  const db = await setup();
  const event = Option.getOrThrow(await generated(db));
  const current = DateTime.nowUnsafe().epochMilliseconds;
  const read = await Effect.runPromise(
    prepareInsightTransition({
      db,
      subject: subject(0),
      operation: "insights.markInsightRead",
      id: event.id,
      evidence: Option.none(),
      current,
    })
  );
  const dismiss = await Effect.runPromise(
    prepareInsightTransition({
      db,
      subject: subject(0),
      operation: "insights.dismissInsight",
      id: event.id,
      evidence: Option.none(),
      current,
    })
  );
  if (read._tag !== "Prepared" || dismiss._tag !== "Prepared") throw new Error("expected pending");
  await db.batch([...dismiss.mutation.statements, dismiss.mutation.completion]);
  await expect(db.batch([...read.mutation.statements, read.mutation.completion])).rejects.toThrow();
  expect(
    Option.getOrThrow(await Effect.runPromise(findInsight(db, users[0] ?? "", event.id)))
      .lifecycleState
  ).toBe("dismissed");
  const audits = await db
    .prepare("SELECT COUNT(*) AS count FROM insight_audit WHERE user_id = ?")
    .bind(users[0])
    .first<{ count: number }>();
  expect(audits?.count).toBe(1);
});

// @effect-diagnostics-next-line asyncFunction:off
it("pages pending InsightEvents past the per-request bound without hiding older occurrences", async () => {
  const db = await setup();
  await authorizeBrowser(db);
  await Array.from({ length: 65 }, (_, index) => index).reduce<Promise<void>>(
    (prior, index) =>
      prior.then(() =>
        Effect.runPromise(
          generateInsight({
            db,
            userId: users[0] ?? "",
            input: { ...input, scheduledAt: DateTime.add(input.scheduledAt, { seconds: index }) },
          })
        ).then(() => undefined)
      ),
    Promise.resolve()
  );
  const first = await send({ db, index: 0, path: "/insights/pending", method: "GET" });
  expect(first.status).toBe(200);
  const firstIds = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Array(Schema.Struct({ id: InsightEventId })) })
  )(await first.json()).data.map((item) => item.id);
  expect(firstIds).toHaveLength(64);
  const link = first.headers.get("link") ?? "";
  expect(link).toContain('rel="next"');
  const path =
    new URL(link.slice(1, link.indexOf(">"))).pathname +
    new URL(link.slice(1, link.indexOf(">"))).search;
  const second = await send({ db, index: 0, path, method: "GET" });
  expect(second.status).toBe(200);
  const lastIds = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Array(Schema.Struct({ id: InsightEventId })) })
  )(await second.json()).data.map((item) => item.id);
  expect(lastIds).toHaveLength(1);
  expect(firstIds).not.toContain(lastIds[0]);
  expect(second.headers.get("link")).toBeNull();
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects an under-scoped or revoked PAT before an InsightEvent write", async () => {
  const db = await setup();
  await authorizeBrowser(db);
  const event = Option.getOrThrow(await generated(db));
  const issue = await send({
    db,
    index: 0,
    path: "/pats",
    method: "POST",
    body: Option.some({
      requestId: "20000000-0000-4000-8000-000000000081",
      grant: {
        recipientLabel: "Agent",
        scopes: ["read"],
        lifetimeDays: 7,
        reviewExpiresAt: DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { days: 7 })),
      },
    }),
  });
  expect(issue.status, await issue.clone().text()).toBe(200);
  const { data } = Schema.decodeUnknownSync(
    Schema.Struct({
      data: Schema.Struct({
        bearer: Schema.String,
        pat: Schema.Struct({ shortId: Schema.String }),
      }),
    })
  )(await issue.json());
  const denied = await send({
    db,
    pat: data.bearer,
    path: `/insights/${event.id}/read`,
    method: "POST",
    body: Option.none(),
  });
  expect(denied.status).toBe(403);
  await db
    .prepare(
      'UPDATE pats SET scopes_json = \'["read","write"]\', revoked_at_ms = ? WHERE short_id = ?'
    )
    .bind(DateTime.nowUnsafe().epochMilliseconds, data.pat.shortId)
    .run();
  const revoked = await send({
    db,
    pat: data.bearer,
    path: `/insights/${event.id}/delivered`,
    method: "POST",
    body: Option.some({
      sentAt: "2026-08-09T23:00:08Z",
      channel: "whatsapp",
      provider: "kapso",
      providerMessageId: "wamid.1",
    }),
  });
  expect(revoked.status).toBe(401);
  expect(
    Option.getOrThrow(await Effect.runPromise(findInsight(db, users[0] ?? "", event.id)))
      .lifecycleState
  ).toBe("pending");
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS count FROM insight_delivery_attempts")
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
  expect(
    (await db.prepare("SELECT COUNT(*) AS count FROM insight_audit").first<{ count: number }>())
      ?.count
  ).toBe(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("does not report absent delivery evidence when its authoritative table cannot be read", async () => {
  const db = await setup();
  const event = Option.getOrThrow(await generated(db));
  await db.prepare("DROP TABLE insight_delivery_attempts").run();
  await expect(
    Effect.runPromiseExit(findInsightAttempt(db, users[0] ?? "", event.id))
  ).resolves.toMatchObject({ _tag: "Failure" });
});

// @effect-diagnostics-next-line asyncFunction:off
it("returns unavailable rather than not_found when an owned InsightEvent cannot be read", async () => {
  const db = await setup();
  await authorizeBrowser(db);
  const event = Option.getOrThrow(await generated(db));
  await db.prepare("DROP TABLE insight_events").run();
  const response = await send({
    db,
    index: 0,
    path: `/insights/${event.id}/read`,
    method: "POST",
    body: Option.none(),
  });
  expect(response.status).toBe(503);
});

// @effect-diagnostics-next-line asyncFunction:off
it("canonical reads and writes share the delivered record without leaking it to another User", async () => {
  const db = await setup();
  await authorizeBrowser(db);
  const event = Option.getOrThrow(await generated(db));
  const pending = await send({ db, index: 0, path: "/insights/pending", method: "GET" });
  expect(pending.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(
      Schema.Struct({ data: Schema.Array(Schema.Struct({ id: InsightEventId })) })
    )(await pending.json()).data[0]?.id
  ).toBe(event.id);
  const foreign = await send({
    db,
    index: 1,
    path: `/insights/${event.id}/read`,
    method: "POST",
    body: Option.none(),
  });
  expect(foreign.status).toBe(404);
  expect(
    Option.getOrThrow(await Effect.runPromise(findInsight(db, users[0] ?? "", event.id)))
      .lifecycleState
  ).toBe("pending");
  const delivered = await send({
    db,
    index: 0,
    path: `/insights/${event.id}/delivered`,
    method: "POST",
    body: Option.some({
      sentAt: "2026-08-09T23:00:08Z",
      channel: "whatsapp",
      provider: "kapso",
      providerMessageId: "wamid.1",
    }),
  });
  expect(delivered.status, await delivered.clone().text()).toBe(200);
  const data = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.toCodecJson(DeliveredInsight) })
  )(await delivered.json()).data;
  expect(data.insight.lifecycleState).toBe("delivered");
  expect(data.deliveryAttempt.providerMessageId).toBe("wamid.1");
  expect(
    Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))(
      await (await send({ db, index: 0, path: "/insights/pending", method: "GET" })).json()
    ).data
  ).toEqual([]);
  expect(
    (
      await send({
        db,
        index: 0,
        path: `/insights/${event.id}/delivered`,
        method: "POST",
        body: Option.some({
          sentAt: "2026-08-09T23:00:09Z",
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: "wamid.2",
        }),
      })
    ).status
  ).toBe(400);
});
