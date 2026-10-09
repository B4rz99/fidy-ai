import assert from "node:assert/strict";
import { InsightUnavailable } from "./contract";
import { UserId } from "../../src/core/identity/contract";
import {
  canonicalAdmissionMigrationNames,
  installTestSchema,
  isolatedTestDatabases,
  statementAuditTestMigrations,
} from "../d1-test-fixture";
import { afterAll, expect } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { DateTime, Effect, Exit, Option, Schema } from "effect";
import { InsightEventId, InsightGenerationInput } from "../../src/core/insights/contract";
import { DeliveredInsight } from "../../src/shell/insights/contract";
import {
  discoverDueInsights,
  findInsight,
  findInsightAttempt,
  generateInsight,
  listPendingInsights,
  prepareInsightTransition,
} from "./operations";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { UserTransactionCoordinator } from "../transactions/runtime";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";

const fromTestPromise = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise(() => Promise.resolve(run())).pipe(Effect.orDie);

const users = [
  UserId.make("10000000-0000-4000-8000-000000000051"),
  UserId.make("10000000-0000-4000-8000-000000000052"),
] as const;
const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];
const databases = isolatedTestDatabases();
/** Direct owner-statement tests keep their historical assertion; the unit uses indexed guards. */
const insightCompletion = (db: D1Database): D1PreparedStatement =>
  db.prepare(`INSERT INTO insight_mutation_assertion (id, accepted)
    VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
    ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`);
afterAll(() => databases.dispose());
const seedUser = (db: D1Database, index: number, current: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const user = users[index] ?? users[0];
    yield* fromTestPromise(() =>
      db
        .prepare(
          "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
        )
        .bind(user, current)
        .run()
    );
    const pairing = `10000000-0000-4000-8000-00000000007${index}`;
    yield* fromTestPromise(() =>
      db
        .prepare(
          "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
        )
        .bind(pairing, `ABCD-123${index}`, new Uint8Array(32), user, current, current + 600000)
        .run()
    );
    yield* fromTestPromise(() =>
      db
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
        .run()
    );
  });
const setup = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* fromTestPromise(() => databases.acquire());
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
      "0037_budget_crossing_facts",
      "0016_statement_processing",
      "0017_forwarded_email",
      "0017_statement_dispatch",
      "0018_batch_envelope_audit",
      "0018_insight_events",
      "0019_canonical_child_guards",
      "0020_dashboard_projection",
      "0009_email_replacement",
      "0018_dashboard",
      ...statementAuditTestMigrations,
    ];
    yield* fromTestPromise(() =>
      installTestSchema({
        db,
        sources: canonicalAdmissionMigrationNames(migrations).map(
          (name) => new URL(`../migrations/${name}.sql`, import.meta.url)
        ),
      })
    );
    const current = DateTime.nowUnsafe().epochMilliseconds;
    yield* Effect.forEach(users, (_user, index) => seedUser(db, index, current), {
      concurrency: 1,
      discard: true,
    });
    return db;
  });
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
  userId: users[index] ?? users[0],
  digest: new Uint8Array(32).fill(index + 1),
});
const generated = (db: D1Database, index = 0): ReturnType<typeof generateInsight> =>
  generateInsight({ db, userId: users[index] ?? users[0], input });
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
        "cf-connecting-ip": "192.0.2.35",
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
            WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
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
const authorizeBrowser = (db: D1Database): Promise<void> =>
  Effect.runPromise(
    fromTestPromise(() =>
      Promise.all(
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
      ).then(() => undefined)
    )
  );

effectIt.effect(
  "retains the first schedule context on replay and exposes only bounded due identities",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const first = yield* generated(db);
      expect(Option.isSome(first)).toBe(true);
      const again = yield* generateInsight({
        db,
        userId: users[0],
        input: { ...input, moneyGroups: [] },
      });
      expect(again).toEqual(first);
      const due = yield* discoverDueInsights({
        db,
        now: DateTime.makeUnsafe("2026-08-10T00:00:00Z"),
      });
      expect(due).toEqual(Option.some([{ userId: users[0], id: Option.getOrThrow(first).id }]));
      const second = Option.getOrThrow(
        yield* generateInsight({ db, userId: users[1], input: { ...input, moneyGroups: [] } })
      );
      expect(second.id).not.toBe(Option.getOrThrow(first).id);
      expect(second.moneyGroups).toEqual([]);
      expect(
        Option.getOrThrow(
          yield* findInsight({ db, userId: users[0], id: Option.getOrThrow(first).id })
        ).moneyGroups
      ).toEqual(input.moneyGroups);
      expect(
        Option.isNone(yield* findInsight({ db, userId: users[1], id: Option.getOrThrow(first).id }))
      ).toBe(true);
    })
);

effectIt.effect(
  "commits one delivery with immutable evidence, then rejects replay and stale lifecycle transitions",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const event = Option.getOrThrow(yield* generated(db));
      const evidence = yield* Schema.decodeEffect(
        Schema.toCodecJson(InsightGenerationInput.fields.scheduledAt)
      )("2026-08-09T23:00:08Z");
      const prepared = yield* prepareInsightTransition({
        db,
        subject: subject(0),
        operation: "insights.markInsightDelivered",
        id: event.id,
        evidence: {
          sentAt: evidence,
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: "wamid.1",
        },
        current: DateTime.nowUnsafe().epochMilliseconds,
      });
      expect(prepared._tag).toBe("Prepared");
      if (prepared._tag !== "Prepared") return;
      yield* fromTestPromise(() =>
        db.batch([...prepared.mutation.statements, insightCompletion(db)])
      );
      expect(
        Option.getOrThrow(yield* findInsight({ db, userId: users[0], id: event.id })).lifecycleState
      ).toBe("delivered");
      const replay = yield* prepareInsightTransition({
        db,
        subject: subject(0),
        operation: "insights.markInsightDelivered",
        id: event.id,
        evidence: {
          sentAt: evidence,
          channel: "whatsapp",
          provider: "kapso",
          providerMessageId: "wamid.2",
        },
        current: DateTime.nowUnsafe().epochMilliseconds,
      });
      expect(replay._tag).toBe("Refused");
      const read = yield* prepareInsightTransition({
        db,
        subject: subject(0),
        operation: "insights.markInsightRead",
        id: event.id,
        current: DateTime.nowUnsafe().epochMilliseconds,
      });
      if (read._tag !== "Prepared") throw new Error("read should be prepared");
      yield* fromTestPromise(() => db.batch([...read.mutation.statements, insightCompletion(db)]));
      expect(
        (yield* listPendingInsights({
          db,
          subject: subject(0),
          request: new Request("https://api.fidyapp.com/insights/pending"),
        })).status
      ).toBe(200);
      expect(
        Option.getOrThrow(yield* findInsight({ db, userId: users[0], id: event.id })).lifecycleState
      ).toBe("read");
    })
);

effectIt.effect("rejects a foreign event before writing any lifecycle or delivery evidence", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const event = Option.getOrThrow(yield* generated(db));
    const result = yield* prepareInsightTransition({
      db,
      subject: subject(1),
      operation: "insights.dismissInsight",
      id: InsightEventId.make(event.id),
      current: DateTime.nowUnsafe().epochMilliseconds,
    });
    expect(result._tag).toBe("Refused");
    expect(
      Option.getOrThrow(yield* findInsight({ db, userId: users[0], id: event.id })).lifecycleState
    ).toBe("pending");
  })
);

effectIt.effect("a stale read prepared before dismissal cannot regress the dismissed event", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const event = Option.getOrThrow(yield* generated(db));
    const current = DateTime.nowUnsafe().epochMilliseconds;
    const read = yield* prepareInsightTransition({
      db,
      subject: subject(0),
      operation: "insights.markInsightRead",
      id: event.id,
      current,
    });
    const dismiss = yield* prepareInsightTransition({
      db,
      subject: subject(0),
      operation: "insights.dismissInsight",
      id: event.id,
      current,
    });
    if (read._tag !== "Prepared" || dismiss._tag !== "Prepared") {
      throw new Error("expected pending");
    }
    yield* fromTestPromise(() => db.batch([...dismiss.mutation.statements, insightCompletion(db)]));
    yield* fromTestPromise(() =>
      expect(db.batch([...read.mutation.statements, insightCompletion(db)])).rejects.toThrow()
    );
    expect(
      Option.getOrThrow(yield* findInsight({ db, userId: users[0], id: event.id })).lifecycleState
    ).toBe("dismissed");
    const audits = yield* fromTestPromise(() =>
      db
        .prepare("SELECT COUNT(*) AS count FROM insight_audit WHERE user_id = ?")
        .bind(users[0])
        .first<{ count: number }>()
    );
    expect(audits?.count).toBe(1);
  })
);

effectIt.effect(
  "pages pending InsightEvents past the per-request bound without hiding older occurrences",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      yield* fromTestPromise(() => authorizeBrowser(db));
      const seed = Option.getOrThrow(yield* generated(db));
      // Seed the remaining occurrences in one native batch; generator behavior is covered above.
      yield* fromTestPromise(() =>
        db.batch(
          Array.from({ length: 64 }, (_, index) =>
            db
              .prepare(
                `INSERT INTO insight_events
                  (id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,
                    scheduled_at,money_groups_json,lifecycle_state)
                SELECT ?,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,
                  ?,money_groups_json,lifecycle_state FROM insight_events WHERE id = ?`
              )
              .bind(
                `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                DateTime.formatIso(DateTime.add(input.scheduledAt, { seconds: index + 1 })),
                seed.id
              )
          )
        )
      );
      const due = Option.getOrThrow(
        yield* discoverDueInsights({ db, now: DateTime.add(input.scheduledAt, { minutes: 2 }) })
      );
      expect(due).toHaveLength(64);
      expect(
        due.every((identity) => identity.userId === users[0] && Object.keys(identity).length === 2)
      ).toBe(true);
      const firstDue = Option.getOrThrow(Option.fromUndefinedOr(due[0]));
      const earliest = Option.getOrThrow(yield* findInsight({ db, ...firstDue }));
      expect(DateTime.formatIso(earliest.scheduledAt)).toBe("2026-08-09T23:00:00.000Z");
      const first = yield* fromTestPromise(() =>
        send({ db, index: 0, path: "/insights/pending", method: "GET" })
      );
      expect(first.status).toBe(200);
      const firstIds = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Array(Schema.Struct({ id: InsightEventId })) })
      )(yield* fromTestPromise(() => first.json()))).data.map((item) => item.id);
      expect(firstIds).toHaveLength(64);
      const link = first.headers.get("link") ?? "";
      expect(link).toContain('rel="next"');
      const path =
        new URL(link.slice(1, link.indexOf(">"))).pathname +
        new URL(link.slice(1, link.indexOf(">"))).search;
      const second = yield* fromTestPromise(() => send({ db, index: 0, path, method: "GET" }));
      expect(second.status).toBe(200);
      const lastIds = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Array(Schema.Struct({ id: InsightEventId })) })
      )(yield* fromTestPromise(() => second.json()))).data.map((item) => item.id);
      expect(lastIds).toHaveLength(1);
      expect(firstIds).not.toContain(lastIds[0]);
      expect(second.headers.get("link")).toBeNull();
    })
);

effectIt.effect("rejects an under-scoped or revoked PAT before an InsightEvent write", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    yield* fromTestPromise(() => authorizeBrowser(db));
    const event = Option.getOrThrow(yield* generated(db));
    const issue = yield* fromTestPromise(() =>
      send({
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
      })
    );
    expect(issue.status, yield* fromTestPromise(() => issue.clone().text())).toBe(200);
    const { data } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        data: Schema.Struct({
          bearer: Schema.String,
          pat: Schema.Struct({ shortId: Schema.String }),
        }),
      })
    )(yield* fromTestPromise(() => issue.json()));
    const readable = yield* fromTestPromise(() =>
      send({ db, pat: data.bearer, path: "/insights/pending", method: "GET" })
    );
    expect(readable.status).toBe(200);
    const visible = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.Array(Schema.Struct({ id: InsightEventId })) })
    )(yield* fromTestPromise(() => readable.json()));
    expect(visible.data.map((insight) => insight.id)).toEqual([event.id]);
    const denied = yield* fromTestPromise(() =>
      send({
        db,
        pat: data.bearer,
        path: `/insights/${event.id}/read`,
        method: "POST",
        body: Option.none(),
      })
    );
    expect(denied.status).toBe(403);
    yield* fromTestPromise(() =>
      db
        .prepare(
          'UPDATE pats SET scopes_json = \'["read","write"]\', revoked_at_ms = ? WHERE short_id = ?'
        )
        .bind(DateTime.nowUnsafe().epochMilliseconds, data.pat.shortId)
        .run()
    );
    const revoked = yield* fromTestPromise(() =>
      send({
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
      })
    );
    expect(revoked.status).toBe(401);
    expect(
      Option.getOrThrow(yield* findInsight({ db, userId: users[0], id: event.id })).lifecycleState
    ).toBe("pending");
    expect(
      (yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM insight_delivery_attempts")
          .first<{ count: number }>()
      ))?.count
    ).toBe(0);
    expect(
      (yield* fromTestPromise(() =>
        db.prepare("SELECT COUNT(*) AS count FROM insight_audit").first<{ count: number }>()
      ))?.count
    ).toBe(0);
  })
);

effectIt.effect(
  "does not report absent delivery evidence when its authoritative table cannot be read",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const event = Option.getOrThrow(yield* generated(db));
      yield* fromTestPromise(() => db.prepare("DROP TABLE insight_delivery_attempts").run());
      yield* fromTestPromise(() =>
        expect(
          Effect.runPromiseExit(findInsightAttempt({ db, userId: users[0], id: event.id }))
        ).resolves.toMatchObject({ _tag: "Failure" })
      );
    })
);

effectIt.effect(
  "returns unavailable when recording a missing InsightEvent refusal cannot retain Audit evidence",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      yield* fromTestPromise(() => authorizeBrowser(db));
      const event = Option.getOrThrow(yield* generated(db));
      const missingId = InsightEventId.make("30000000-0000-4000-8000-000000000099");
      const request = {
        db,
        index: 0,
        path: `/insights/${missingId}/read`,
        method: "POST" as const,
        body: Option.none<object>(),
      };
      expect(Option.isNone(yield* findInsight({ db, userId: users[0], id: missingId }))).toBe(true);
      const healthy = yield* fromTestPromise(() => send(request));
      expect(healthy.status).toBe(404);
      const snapshot = (): Promise<ReadonlyArray<ReadonlyArray<Record<string, unknown>>>> =>
        Promise.all([
          db.prepare("SELECT * FROM insight_events ORDER BY user_id, id").all(),
          db.prepare("SELECT * FROM insight_delivery_attempts ORDER BY user_id, id").all(),
          db.prepare("SELECT * FROM insight_audit ORDER BY user_id, id").all(),
        ]).then((results) => results.map((result) => result.results));
      const before = yield* fromTestPromise(snapshot);
      yield* fromTestPromise(() =>
        db
          .prepare(
            `CREATE TRIGGER refuse_missing_insight_audit BEFORE INSERT ON insight_audit
             WHEN NEW.operation = 'insights.markInsightRead' AND NEW.outcome = 'rejected'
             BEGIN SELECT RAISE(ABORT, 'test_refusal_audit_unavailable'); END`
          )
          .run()
      );
      const response = yield* fromTestPromise(() => send(request));
      expect(response.status).toBe(503);
      const canonicalError = yield* fromTestPromise(() => response.json());
      expect(canonicalError).toEqual({ status: "unavailable" });
      expect(yield* fromTestPromise(snapshot)).toEqual(before);
      expect(
        Option.getOrThrow(yield* findInsight({ db, userId: users[0], id: event.id })).lifecycleState
      ).toBe("pending");
    })
);

effectIt.effect(
  "returns unavailable rather than not_found when an owned InsightEvent cannot be read",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      yield* fromTestPromise(() => authorizeBrowser(db));
      const event = Option.getOrThrow(yield* generated(db));
      yield* fromTestPromise(() => db.prepare("DROP TABLE insight_events").run());
      const response = yield* fromTestPromise(() =>
        send({
          db,
          index: 0,
          path: `/insights/${event.id}/read`,
          method: "POST",
          body: Option.none(),
        })
      );
      expect(response.status).toBe(503);
    })
);

effectIt.effect(
  "canonical reads and writes share the delivered record without leaking it to another User",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      yield* fromTestPromise(() => authorizeBrowser(db));
      const event = Option.getOrThrow(yield* generated(db));
      const pending = yield* fromTestPromise(() =>
        send({ db, index: 0, path: "/insights/pending", method: "GET" })
      );
      expect(pending.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Array(Schema.Struct({ id: InsightEventId })) })
        )(yield* fromTestPromise(() => pending.json()))).data[0]?.id
      ).toBe(event.id);
      const foreign = yield* fromTestPromise(() =>
        send({
          db,
          index: 1,
          path: `/insights/${event.id}/read`,
          method: "POST",
          body: Option.none(),
        })
      );
      expect(foreign.status).toBe(404);
      expect(
        Option.getOrThrow(yield* findInsight({ db, userId: users[0], id: event.id })).lifecycleState
      ).toBe("pending");
      const delivered = yield* fromTestPromise(() =>
        send({
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
        })
      );
      expect(delivered.status, yield* fromTestPromise(() => delivered.clone().text())).toBe(200);
      const data = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.toCodecJson(DeliveredInsight) })
      )(yield* fromTestPromise(() => delivered.json()))).data;
      expect(data.insight.lifecycleState).toBe("delivered");
      expect(data.deliveryAttempt.providerMessageId).toBe("wamid.1");
      const pendingAgain = yield* fromTestPromise(() =>
        send({ db, index: 0, path: "/insights/pending", method: "GET" })
      );
      expect(
        (yield* Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))(
          yield* fromTestPromise(() => pendingAgain.json())
        )).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() =>
          send({
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
        )).status
      ).toBe(400);
    })
);

effectIt.effect("refuses a malformed retained occurrence without misclassifying it as absent", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    yield* fromTestPromise(() => authorizeBrowser(db));
    const event = Option.getOrThrow(yield* generated(db));
    yield* fromTestPromise(() => db.prepare("DROP TRIGGER insight_events_immutable").run());
    yield* fromTestPromise(() =>
      db
        .prepare("UPDATE insight_events SET money_groups_json = 'invalid' WHERE id = ?")
        .bind(event.id)
        .run()
    );
    const response = yield* fromTestPromise(() =>
      send({
        db,
        index: 0,
        path: `/insights/${event.id}/read`,
        method: "POST",
        body: Option.none(),
      })
    );
    expect(response.status).toBe(503);
    expect(
      (yield* fromTestPromise(() =>
        db
          .prepare("SELECT lifecycle_state FROM insight_events WHERE id = ?")
          .bind(event.id)
          .first<{ lifecycle_state: string }>()
      ))?.lifecycle_state
    ).toBe("pending");
    expect(
      (yield* fromTestPromise(() =>
        db
          .prepare("SELECT COUNT(*) AS count FROM insight_audit WHERE outcome = 'accepted'")
          .first<{ count: number }>()
      ))?.count
    ).toBe(0);
  })
);

effectIt.effect(
  "does not release pending facts when live authority disappears during query accountability",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      yield* fromTestPromise(() => authorizeBrowser(db));
      const event = Option.getOrThrow(yield* generated(db));
      yield* fromTestPromise(() =>
        db
          .prepare(`CREATE TRIGGER insight_test_revocation AFTER INSERT ON insight_audit
      WHEN NEW.operation = 'insights.listPendingInsights'
      BEGIN UPDATE web_sessions SET revoked_at_ms = 1 WHERE user_id = NEW.user_id; END`)
          .run()
      );
      const response = yield* fromTestPromise(() =>
        send({ db, index: 0, path: "/insights/pending", method: "GET" })
      );
      expect(response.status).toBe(503);
      expect(
        (yield* fromTestPromise(() =>
          db.prepare("SELECT COUNT(*) AS count FROM insight_audit").first<{ count: number }>()
        ))?.count
      ).toBe(0);
      expect(
        Option.getOrThrow(yield* findInsight({ db, userId: users[0], id: event.id })).lifecycleState
      ).toBe("pending");
    })
);

effectIt.effect(
  "fails closed when schedule replay finds a malformed retained occurrence identity",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const event = Option.getOrThrow(yield* generated(db));
      yield* fromTestPromise(() => db.prepare("DROP TRIGGER insight_events_immutable").run());
      yield* fromTestPromise(() =>
        db.prepare("UPDATE insight_events SET id = 'invalid' WHERE id = ?").bind(event.id).run()
      );
      const replay = yield* Effect.exit(generated(db));
      assert.deepStrictEqual(replay, Exit.fail(new InsightUnavailable()));
      expect(
        (yield* fromTestPromise(() =>
          db.prepare("SELECT COUNT(*) AS count FROM insight_events").first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
);
