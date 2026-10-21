import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { UserId } from "../../src/core/identity/contract";
import { Money } from "../../src/core/_shared/money";
import { RecurringSeriesPage } from "../../src/core/recurring/contract";
import { Transaction } from "../../src/core/transactions/contract";
import { installTestSchema, isolatedTestDatabases, observeRetentionCost } from "../d1-test-fixture";
import {
  discoverRecurringWork,
  evaluateRecurringSeries,
  listRecurringSeries,
  prepareRecurringDigestSourceGuard,
  readRecurringConfirmations,
  readRecurringDigestSource,
} from "./operations";
import { projections } from "./internal/erasure";
import { advanceRecurringWork } from "./runtime";
import { makeCoordinators, sendBackground } from "./recurring.test-fixture";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { executeCanonicalQuery } from "../canonical-operations/operations";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";

const contractDigestLength = 64;
const unusedAI = (): Promise<never> =>
  Promise.reject(new Error("Inference is not part of recurring detection"));
const coreEnvironment = (db: D1Database): Parameters<typeof coreWorker.fetch>[1] => ({
  DB: db,
  AI: { run: unusedAI },
  HOSTED_AI_MODEL: approvedWorkersAiModel,
  CONTRACT_DIGEST: "a".repeat(contractDigestLength),
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
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
  USER_TRANSACTION_COORDINATOR: makeCoordinators(db),
});
const sendPublic = ({
  db,
  request,
}: Readonly<{ db: D1Database; request: Request }>): Promise<Response> =>
  publicWorker.fetch(request, {
    BROWSER_ORIGIN: "https://app.fidyapp.com",
    LOCAL_CANONICAL_READ_BEARER: "",
    PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CORE: { fetch: (input) => coreWorker.fetch(new Request(input), coreEnvironment(db)) },
  });
const fromPromise = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise(() => Promise.resolve(run())).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = UserId.make("10000000-0000-4000-8000-000000000051");
const otherUserId = UserId.make("10000000-0000-4000-8000-000000000052");
const sessionId = "10000000-0000-4000-8000-000000000061";
const digest = new Uint8Array(32).fill(1);
const setup = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.nowUnsafe().epochMilliseconds);
    const db = yield* fromPromise(() => databases.acquire());

    yield* fromPromise(() => installTestSchema({ db }));
    for (const subject of [userId, otherUserId]) {
      yield* fromPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
            )
            .bind(subject),
          db
            .prepare(
              "INSERT INTO consent_history (record_type,id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, occurred_at_ms) VALUES ('processing_grant',?, ?, '{}', 'disclosure', 'decision', 0, 0)"
            )
            .bind(subject, subject),
        ])
      );
    }
    const current = DateTime.nowUnsafe().epochMilliseconds;
    yield* fromPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, 'ABCD-1234', ?, ?, 'consumed', ?, ?)"
          )
          .bind(sessionId, digest, userId, current, current + 600000),
        db
          .prepare(
            "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(
            sessionId,
            sessionId,
            userId,
            digest,
            current,
            current + 600000,
            current + 3600000,
            current + 7776000000
          ),
      ])
    );
    return db;
  });
const captureDefaults = {
  userId: String(userId),
  currency: "COP",
  counterparty: "Netflix",
  amount: "30000",
  createdAt: "",
  direction: "outflow",
  idPrefix: "20000000",
};
const captureStatement = (
  db: D1Database,
  month: number,
  overrides: Readonly<Partial<typeof captureDefaults>> = {}
): D1PreparedStatement => {
  const input = { ...captureDefaults, ...overrides };
  const occurredAt = `2026-${String(month).padStart(2, "0")}-15T12:00:00.000Z`;
  return db
    .prepare(
      `INSERT INTO transactions (id, user_id, amount, currency, direction, counterparty, category_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, '10000000-0000-4000-8000-000000000016', ?, ?)`
    )
    .bind(
      `${input.idPrefix}-0000-4000-8000-${String(month).padStart(12, "0")}`,
      input.userId,
      input.amount,
      input.currency,
      input.direction,
      input.counterparty === "" ? null : input.counterparty,
      occurredAt,
      input.createdAt || occurredAt
    );
};
const capture = (
  db: D1Database,
  month: number,
  overrides: Readonly<Partial<typeof captureDefaults>> = {}
): Effect.Effect<D1Result> => fromPromise(() => captureStatement(db, month, overrides).run());
const query = (
  db: D1Database,
  cursor: Option.Option<string> = Option.none()
): Effect.Effect<typeof RecurringSeriesPage.Type> =>
  Effect.gen(function* () {
    const response = yield* listRecurringSeries({
      db,
      subject: { id: sessionId, userId, digest },
      request: new Request(
        Option.match(cursor, {
          onNone: () => "https://api.fidyapp.com/recurring-series",
          onSome: (value) =>
            `https://api.fidyapp.com/recurring-series?cursor=${encodeURIComponent(value)}`,
        })
      ),
    });
    expect(response.status).toBe(200);
    const value: unknown = yield* fromPromise(() => response.json());
    return (yield* Schema.decodeUnknownEffect(
      Schema.toCodecJson(Schema.Struct({ data: RecurringSeriesPage }))
    )(value).pipe(Effect.orDie)).data;
  });
const confirmations = (db: D1Database): ReturnType<typeof readRecurringConfirmations> =>
  readRecurringConfirmations({ db, userId, cursor: Option.none() });
const evaluate = (db: D1Database, steps = 6): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let step = 0; step < steps; step += 1) {
      yield* evaluateRecurringSeries({ db, userId }).pipe(Effect.orDie);
    }
  });

it.effect(
  "public capture, correction and deletion invalidate and repair the same historical pattern",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const bearer = "2".repeat(43);
      const tokenDigest = new Uint8Array(
        yield* fromPromise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)))
      );
      yield* fromPromise(() =>
        db
          .prepare("UPDATE web_sessions SET token_digest=? WHERE id=?")
          .bind(tokenDigest, sessionId)
          .run()
      );
      const request = (path: string, method = "GET", payload?: unknown): Effect.Effect<Response> =>
        fromPromise(() => Bun.sleep(1000)).pipe(
          Effect.andThen(
            fromPromise(() =>
              sendPublic({
                db,
                request: new Request(`https://api.fidyapp.com${path}`, {
                  method,
                  headers: {
                    origin: "https://app.fidyapp.com",
                    "content-type": "application/json",
                    "Fidy-Session-Binding": sessionId,
                    cookie: `__Host-fidy_session=${bearer}`,
                  },
                  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
                }),
              })
            )
          )
        );
      const read = (): Effect.Effect<typeof RecurringSeriesPage.Type> =>
        Effect.gen(function* () {
          const response = yield* request("/recurring-series");
          expect(response.status).toBe(200);
          return (yield* Schema.decodeUnknownEffect(
            Schema.toCodecJson(Schema.Struct({ data: RecurringSeriesPage }))
          )(yield* fromPromise(() => response.json())).pipe(Effect.orDie)).data;
        });
      const created: Array<Transaction> = [];
      for (const month of [1, 2, 3]) {
        const response = yield* request("/transactions", "POST", {
          money: { amount: "30000.25", currency: "COP" },
          counterparty: "Netflix",
          direction: "outflow",
          categoryId: "10000000-0000-4000-8000-000000000016",
          occurredAt: `2026-${String(month).padStart(2, "0")}-15T12:00:00.000Z`,
        });
        expect(response.status).toBe(201);
        created.push(
          (yield* Schema.decodeUnknownEffect(
            Schema.toCodecJson(Schema.Struct({ data: Transaction }))
          )(yield* fromPromise(() => response.json())).pipe(Effect.orDie)).data
        );
      }
      yield* evaluate(db);
      const initial = yield* read();
      expect(initial.evaluation.kind).toBe("current");
      expect(initial.series).toHaveLength(1);
      const original = initial.series[0];
      const middle = created[1];
      if (original === undefined || middle === undefined) {
        return yield* Effect.die("Missing captured pattern");
      }
      const correction = yield* request(`/transactions/${middle.id}`, "PUT", {
        expectedRevision: 0,
        changes: { counterparty: null },
      });
      expect(correction.status).toBe(200);
      expect((yield* read()).evaluation.kind).toBe("updating");
      yield* evaluate(db);
      expect((yield* read()).series).toHaveLength(0);
      const restored = yield* request(`/transactions/${middle.id}`, "PUT", {
        expectedRevision: 1,
        changes: { counterparty: "Netflix" },
      });
      expect(restored.status).toBe(200);
      yield* evaluate(db);
      expect((yield* read()).series).toEqual([original]);
      const deleted = yield* request(`/transactions/${middle.id}`, "DELETE");
      expect(deleted.status).toBe(200);
      yield* evaluate(db);
      expect((yield* read()).series).toHaveLength(0);
    }),
  { timeout: 30_000 }
);

it.effect("serves the same canonical result through public HTTP and hosted query execution", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    for (const month of [1, 2, 3]) yield* capture(db, month);
    yield* evaluate(db);
    const bearer = "1".repeat(43);
    const tokenDigest = new Uint8Array(
      yield* fromPromise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)))
    );
    yield* fromPromise(() =>
      db
        .prepare("UPDATE web_sessions SET token_digest = ? WHERE id = ?")
        .bind(tokenDigest, sessionId)
        .run()
    );
    const response = yield* fromPromise(() =>
      sendPublic({
        db,
        request: new Request("https://api.fidyapp.com/recurring-series", {
          headers: {
            origin: "https://app.fidyapp.com",
            "Fidy-Session-Binding": sessionId,
            cookie: `__Host-fidy_session=${bearer}`,
          },
        }),
      })
    );
    expect(response.status).toBe(200);
    const hosted = Option.getOrThrow(
      yield* executeCanonicalQuery({
        db,
        subject: { id: sessionId, userId, digest: tokenDigest },
        operation: CanonicalOperationId.make("recurring.listRecurringSeries"),
        input: { query: {} },
        bucket: Option.none(),
      })
    );
    expect(hosted.status).toBe(200);
    expect(yield* fromPromise(() => hosted.json())).toEqual(
      yield* fromPromise(() => response.json())
    );
    const anonymous = yield* fromPromise(() =>
      sendPublic({ db, request: new Request("https://api.fidyapp.com/recurring-series") })
    );
    expect(anonymous.status).toBe(401);
  })
);

it.effect(
  "rejects a foreign User in private recurring work before retaining evaluation progress",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      const substituted = yield* fromPromise(() =>
        sendBackground({
          db,
          coordinatorUser: otherUserId,
          body: Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ userId: UserId })))({
            userId,
          }),
        })
      );
      expect(substituted.status).toBe(503);
      expect((yield* query(db)).evaluation.kind).toBe("not-evaluated");
      const steps = 5;
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ userId: UserId }))
      )({ userId });
      for (let step = 0; step < steps; step += 1) {
        const result = yield* fromPromise(() =>
          sendBackground({ db, coordinatorUser: userId, body })
        );
        expect(result.status).toBe(200);
      }
      expect((yield* query(db)).evaluation.kind).toBe("current");
      expect((yield* confirmations(db)).confirmations).toHaveLength(1);
    })
);

it.effect("keeps each Currency separate and skips absent Counterparties and inflows", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    for (const month of [1, 2, 3]) {
      yield* capture(db, month);
      yield* capture(db, month, { currency: "USD", amount: "12.99", idPrefix: "21000000" });
      yield* capture(db, month, { counterparty: "", idPrefix: "22000000" });
      yield* capture(db, month, {
        counterparty: "Salary",
        direction: "inflow",
        idPrefix: "23000000",
      });
    }
    yield* evaluate(db);
    const page = yield* query(db);
    expect(page.series.map((series) => series.money.currency)).toEqual(["COP", "USD"]);
  })
);

it.effect(
  "retains suppression and immutable confirmation context when resumed charges update a pattern",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const capturedAt = DateTime.formatIso(DateTime.nowUnsafe());
      for (const month of [1, 2, 3]) yield* capture(db, month, { createdAt: capturedAt });
      yield* evaluate(db);
      const before = yield* confirmations(db);
      expect(before.confirmations).toHaveLength(1);
      expect(before.confirmations[0]?.occurrence.announcement).toEqual({
        kind: "suppressed",
        reason: "backfill",
      });
      yield* fromPromise(() =>
        db
          .prepare("UPDATE users SET time_zone = 'Pacific/Honolulu' WHERE id = ?")
          .bind(userId)
          .run()
      );
      yield* capture(db, 6, { amount: "31000" });
      expect((yield* query(db)).evaluation.kind).toBe("updating");
      yield* evaluate(db);
      const after = yield* confirmations(db);
      expect(after).toEqual(before);
      const page = yield* query(db);
      expect(page.series[0]?.id).toBe(before.confirmations[0]?.occurrence.seriesId);
      expect(page.series[0]?.announcement).toEqual({ kind: "suppressed", reason: "backfill" });
      expect(
        DateTime.formatIso(Option.getOrThrow(Option.fromUndefinedOr(page.series[0])).lastOccurredAt)
      ).toBe("2026-06-15T12:00:00.000Z");
    })
);

it.effect(
  "restarts persisted evaluation after a changed revision without publishing mixed financial facts",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluateRecurringSeries({ db, userId });
      yield* evaluateRecurringSeries({ db, userId });
      yield* fromPromise(() =>
        db
          .prepare("UPDATE transactions SET currency = 'USD' WHERE user_id = ? AND id = ?")
          .bind(userId, "20000000-0000-4000-8000-000000000003")
          .run()
      );
      yield* evaluate(db);
      const page = yield* query(db);
      expect(page.evaluation.kind).toBe("current");
      expect(page.series).toEqual([]);
      expect((yield* confirmations(db)).confirmations).toEqual([]);
    })
);

it.effect(
  "invalidates corrected confirmation evidence but does not confirm the same restored pattern again",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluate(db);
      const before = yield* confirmations(db);
      yield* fromPromise(() =>
        db
          .prepare("UPDATE transactions SET direction = 'inflow' WHERE user_id = ? AND id = ?")
          .bind(userId, "20000000-0000-4000-8000-000000000002")
          .run()
      );
      yield* evaluate(db);
      expect((yield* query(db)).series).toEqual([]);
      expect((yield* confirmations(db)).confirmations).toEqual([]);
      yield* fromPromise(() =>
        db
          .prepare("UPDATE transactions SET direction = 'outflow' WHERE user_id = ? AND id = ?")
          .bind(userId, "20000000-0000-4000-8000-000000000002")
          .run()
      );
      yield* evaluate(db);
      expect(yield* confirmations(db)).toEqual(before);
    })
);

it.effect(
  "refuses substituted ownership and revoked Consent without partial financial or audit changes",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluate(db);
      const foreign = yield* listRecurringSeries({
        db,
        subject: { id: sessionId, userId: otherUserId, digest },
        request: new Request("https://api.fidyapp.com/recurring-series"),
      });
      expect(foreign.status).toBe(503);
      expect(
        (yield* readRecurringConfirmations({ db, userId: otherUserId, cursor: Option.none() }))
          .confirmations
      ).toEqual([]);
      const audits = yield* fromPromise(() =>
        db
          .prepare(
            "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE operation = 'recurring.listRecurringSeries'"
          )
          .first()
      );
      expect(audits?.count).toBe(0);
      yield* fromPromise(() =>
        db
          .prepare(
            "INSERT INTO consent_history(record_type,id, user_id, grant_record_id, session_id, occurred_at_ms) VALUES ('processing_withdrawal',?, ?, ?, ?, ?)"
          )
          .bind(
            "90000000-0000-4000-8000-000000000001",
            userId,
            userId,
            sessionId,
            DateTime.nowUnsafe().epochMilliseconds
          )
          .run()
      );
      const refused = yield* listRecurringSeries({
        db,
        subject: { id: sessionId, userId, digest },
        request: new Request("https://api.fidyapp.com/recurring-series"),
      });
      expect(refused.status).toBe(503);
      expect((yield* Effect.exit(evaluateRecurringSeries({ db, userId })))._tag).toBe("Failure");
      const unchanged = yield* fromPromise(() =>
        db
          .prepare(
            "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE operation = 'recurring.listRecurringSeries'"
          )
          .first()
      );
      expect(unchanged?.count).toBe(0);
    })
);

it.effect(
  "publishes a Free historical monthly pattern through the canonical owner query after durable evaluation",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      expect((yield* query(db)).evaluation.kind).toBe("not-evaluated");
      yield* capture(db, 1);
      yield* capture(db, 2);
      yield* capture(db, 3, { amount: "31500" });
      yield* evaluate(db);
      const page = yield* query(db);
      expect(page.evaluation.kind).toBe("current");
      expect(page.series).toHaveLength(1);
      const series = Option.getOrThrow(Option.fromUndefinedOr(page.series[0]));
      expect(series.announcement).toEqual({ kind: "eligible" });
      expect(
        yield* Schema.encodeEffect(Schema.toCodecJson(Money))(series.money).pipe(Effect.orDie)
      ).toEqual({
        amount: "31500",
        currency: "COP",
      });
    })
);

it.effect("paginates confirmed patterns without dropping rows or mixing completed revisions", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const seriesCount = 33;
    const prefix = 30_000_000;
    const statements = Array.from({ length: seriesCount }, (_, index) =>
      [1, 2, 3].map((month) =>
        captureStatement(db, month, {
          counterparty: `Merchant ${String(index).padStart(2, "0")}`,
          idPrefix: String(prefix + index),
        })
      )
    ).flat();
    yield* fromPromise(() => db.batch(statements));
    yield* evaluate(db, seriesCount + 3);
    const first = yield* query(db);
    expect(first.series).toHaveLength(32);
    expect(Option.isSome(first.cursor)).toBe(true);
    const second = yield* query(db, first.cursor);
    expect(second.series).toHaveLength(1);
    expect(Option.isNone(second.cursor)).toBe(true);
    expect(new Set([...first.series, ...second.series].map((series) => series.id)).size).toBe(
      seriesCount
    );
    yield* capture(db, 4, { counterparty: "Merchant 00", idPrefix: String(prefix) });
    yield* evaluate(db, seriesCount + 3);
    const stale = yield* listRecurringSeries({
      db,
      subject: { id: sessionId, userId, digest },
      request: new Request(
        `https://api.fidyapp.com/recurring-series?cursor=${encodeURIComponent(Option.getOrThrow(first.cursor))}`
      ),
    });
    expect(stale.status).toBe(400);
  })
);

it.effect(
  "refuses malformed retained output before accepting Audit or advancing PAT activity",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluate(db);
      yield* fromPromise(() =>
        db
          .prepare("UPDATE recurring_series SET series_json = '{}' WHERE user_id = ?")
          .bind(userId)
          .run()
      );
      const response = yield* listRecurringSeries({
        db,
        subject: { id: sessionId, userId, digest },
        request: new Request("https://api.fidyapp.com/recurring-series"),
      });
      expect(response.status).toBe(503);
      expect(
        (yield* fromPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE operation = 'recurring.listRecurringSeries'"
            )
            .first()
        ))?.count
      ).toBe(0);
    })
);

it.effect("requires current read scope at the native query's atomic authority check", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const current = DateTime.nowUnsafe().epochMilliseconds;
    const lifetime = 604_800_000;
    const patId = "80000000-0000-4000-8000-000000000001";
    yield* fromPromise(() =>
      db
        .prepare(
          `INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json, lifetime_days, created_at_ms, issued_at_ms, expires_at_ms, request_id) VALUES (?, ?, 'abcdefgh', ?, 'Test client', '["write"]', 7, ?, ?, ?, ?)`
        )
        .bind(patId, userId, digest, current, current, current + lifetime, patId)
        .run()
    );
    const refused = yield* listRecurringSeries({
      db,
      subject: { patId, userId, digest, requiredScope: Option.none() },
      request: new Request("https://api.fidyapp.com/recurring-series"),
    });
    expect(refused.status).toBe(503);
    expect(
      (yield* fromPromise(() =>
        db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
      ))?.last_used_at_ms
    ).toBeNull();
    expect(
      (yield* fromPromise(() =>
        db
          .prepare(
            "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE pat_id = ?"
          )
          .bind(patId)
          .first()
      ))?.count
    ).toBe(0);
    yield* fromPromise(() =>
      db.prepare(`UPDATE pats SET scopes_json = '["read"]' WHERE id = ?`).bind(patId).run()
    );
    const accepted = yield* listRecurringSeries({
      db,
      subject: { patId, userId, digest, requiredScope: Option.none() },
      request: new Request("https://api.fidyapp.com/recurring-series"),
    });
    expect(accepted.status).toBe(200);
    expect(
      (yield* fromPromise(() =>
        db.prepare("SELECT last_used_at_ms FROM pats WHERE id = ?").bind(patId).first()
      ))?.last_used_at_ms
    ).toBeGreaterThan(0);
  })
);

it.effect(
  "resumes a financial scan across owned fact pages after fresh coordinator construction",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      const unrelatedCount = 129;
      const prefix = 40_000_000;
      const base = DateTime.makeUnsafe("2026-01-15T12:00:00.000Z");
      yield* fromPromise(() =>
        db.batch(
          Array.from({ length: unrelatedCount }, (_, index) =>
            captureStatement(db, 1, {
              counterparty: "",
              idPrefix: String(prefix + index),
              createdAt: DateTime.formatIso(DateTime.add(base, { hours: index })),
            })
          )
        )
      );
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ userId: UserId }))
      )({ userId });
      const steps = 6;
      for (let step = 0; step < steps; step += 1) {
        expect(
          (yield* fromPromise(() => sendBackground({ db, coordinatorUser: userId, body }))).status
        ).toBe(200);
      }
      const page = yield* query(db);
      expect(page.evaluation.kind).toBe("current");
      expect(page.series).toHaveLength(1);
      expect((yield* confirmations(db)).confirmations).toHaveLength(1);
    })
);

it.effect(
  "re-evaluates reversible Reconciliation without counting duplicate retained outflows",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluate(db);
      const before = yield* confirmations(db);
      yield* capture(db, 2, { idPrefix: "21000000" });
      yield* evaluate(db);
      expect((yield* query(db)).series).toEqual([]);
      const firstId = "20000000-0000-4000-8000-000000000002";
      const duplicateId = "21000000-0000-4000-8000-000000000002";
      yield* fromPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO transaction_reconciliation_decisions (user_id, first_transaction_id, second_transaction_id, state, visible_transaction_id, decided_at) VALUES (?, ?, ?, 'linked', ?, ?)"
            )
            .bind(
              userId,
              firstId,
              duplicateId,
              duplicateId,
              DateTime.formatIso(DateTime.nowUnsafe())
            ),
          ...[firstId, duplicateId].map((id) =>
            db
              .prepare(
                "UPDATE transactions SET reconciliation_first_id=incoming.first_transaction_id,reconciliation_second_id=incoming.second_transaction_id FROM (SELECT column1 AS user_id,column2 AS transaction_id,column3 AS first_transaction_id,column4 AS second_transaction_id FROM (VALUES (?, ?, ?, ?))) incoming WHERE transactions.user_id=incoming.user_id AND transactions.id=incoming.transaction_id"
              )
              .bind(userId, id, firstId, duplicateId)
          ),
        ])
      );
      yield* evaluate(db);
      expect(yield* confirmations(db)).toEqual(before);
      expect((yield* query(db)).series).toHaveLength(1);
      yield* fromPromise(() =>
        db.batch([
          db
            .prepare(
              "UPDATE transactions SET reconciliation_row_ref=NULL,reconciliation_first_id=NULL,reconciliation_second_id=NULL WHERE reconciliation_first_id IS NOT NULL AND user_id = ?"
            )
            .bind(userId),
          db
            .prepare(
              "UPDATE transaction_reconciliation_decisions SET state = 'keep-separate', visible_transaction_id = NULL WHERE user_id = ?"
            )
            .bind(userId),
        ])
      );
      yield* evaluate(db);
      expect((yield* query(db)).series).toEqual([]);
      expect((yield* confirmations(db)).confirmations).toEqual([]);
    })
);

it.effect(
  "repairs a corrected reference amount without assigning a new pattern or confirmation",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      yield* capture(db, 1, { amount: "100" });
      yield* capture(db, 2, { amount: "105" });
      yield* capture(db, 3, { amount: "105" });
      yield* evaluate(db);
      const before = yield* confirmations(db);
      yield* fromPromise(() =>
        db
          .prepare("UPDATE transactions SET amount = '106' WHERE user_id = ? AND id = ?")
          .bind(userId, "20000000-0000-4000-8000-000000000001")
          .run()
      );
      yield* evaluate(db);
      expect(yield* confirmations(db)).toEqual(before);
      expect((yield* query(db)).series[0]?.id).toBe(before.confirmations[0]?.occurrence.seriesId);
    })
);

it.effect(
  "fails the private confirmation feed closed while supporting evidence awaits repair",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluate(db);
      expect((yield* confirmations(db)).confirmations).toHaveLength(1);
      yield* fromPromise(() =>
        db
          .prepare("UPDATE transactions SET direction = 'inflow' WHERE user_id = ? AND id = ?")
          .bind(userId, "20000000-0000-4000-8000-000000000002")
          .run()
      );
      expect((yield* Effect.exit(confirmations(db)))._tag).toBe("Failure");
      yield* evaluate(db);
      expect((yield* confirmations(db)).confirmations).toEqual([]);
    })
);

const coordinatedEvaluation = ({
  db,
  userId: subject,
  steps,
}: Readonly<{ db: D1Database; userId: UserId; steps: number }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Struct({ userId: UserId }))
    )({ userId: subject }).pipe(Effect.orDie);
    let result = new Response(null, { status: 503 });
    for (let step = 0; step < steps; step += 1) {
      result = yield* fromPromise(() => sendBackground({ db, coordinatorUser: subject, body }));
      if (result.status !== 200) break;
    }
    return result;
  });
const assertOtherUserEvaluates = (db: D1Database): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const month of [1, 2, 3]) {
      yield* capture(db, month, { userId: otherUserId, idPrefix: "59000000" });
    }
    expect((yield* coordinatedEvaluation({ db, userId: otherUserId, steps: 6 })).status).toBe(200);
    expect(
      (yield* readRecurringConfirmations({ db, userId: otherUserId, cursor: Option.none() }).pipe(
        Effect.orDie
      )).confirmations
    ).toHaveLength(1);
  });
const seedPatterns = (db: D1Database, count: number, offset = 0): Effect.Effect<void> =>
  Effect.gen(function* () {
    const prefix = 50_000_000;
    const statements = Array.from({ length: count }, (_, position) =>
      [1, 2, 3].map((month) =>
        captureStatement(db, month, {
          counterparty: `Limit merchant ${String(position + offset).padStart(3, "0")}`,
          idPrefix: String(prefix + position + offset),
          createdAt: DateTime.formatIso(
            DateTime.add(
              DateTime.makeUnsafe(`2026-${String(month).padStart(2, "0")}-15T12:00:00.000Z`),
              { hours: position + offset }
            )
          ),
        })
      )
    ).flat();
    yield* fromPromise(() => db.batch(statements));
  });

it.effect(
  "rejects a 513-fact group under the coordinator without partial publication or cross-User starvation",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluate(db);
      const before = yield* query(db);
      const confirmationBefore = yield* fromPromise(() =>
        db
          .prepare(
            "SELECT confirmation_json FROM recurring_series WHERE user_id = ? AND confirmation_id IS NOT NULL"
          )
          .bind(userId)
          .first()
      );
      const additional = 510;
      const prefix = 60_000_000;
      const base = DateTime.makeUnsafe("2026-01-15T12:00:00.000Z");
      yield* fromPromise(() =>
        db.batch(
          Array.from({ length: additional }, (_, index) =>
            captureStatement(db, 1, {
              idPrefix: String(prefix + index),
              createdAt: DateTime.formatIso(DateTime.add(base, { hours: index })),
            })
          )
        )
      );
      expect((yield* coordinatedEvaluation({ db, userId, steps: 8 })).status).toBe(503);
      const after = yield* query(db);
      expect(after.evaluation.kind).toBe("updating");
      expect(after.series).toEqual(before.series);
      expect(
        yield* fromPromise(() =>
          db
            .prepare(
              "SELECT confirmation_json FROM recurring_series WHERE user_id = ? AND confirmation_id IS NOT NULL"
            )
            .bind(userId)
            .first()
        )
      ).toEqual(confirmationBefore);
      yield* assertOtherUserEvaluates(db);
    })
);

it.effect("rejects 129 proposed series before publishing any current result", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const count = 129;
    yield* seedPatterns(db, count);
    expect((yield* coordinatedEvaluation({ db, userId, steps: count + 10 })).status).toBe(503);
    const after = yield* query(db);
    expect(after.evaluation.kind).toBe("updating");
    expect(after.series).toEqual([]);
    expect(
      (yield* fromPromise(() =>
        db
          .prepare("SELECT count(confirmation_id) AS count FROM recurring_series WHERE user_id = ?")
          .bind(userId)
          .first()
      ))?.count
    ).toBe(0);
    yield* assertOtherUserEvaluates(db);
  })
);

const seedRetainedPatternLimit = (db: D1Database): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* seedPatterns(db, 1);
    expect((yield* coordinatedEvaluation({ db, userId, steps: 6 })).status).toBe(200);
    const original = Option.getOrThrow(
      Option.fromNullOr(
        yield* fromPromise(() =>
          db
            .prepare("SELECT id FROM recurring_series WHERE user_id = ?")
            .bind(userId)
            .first<string>("id")
        )
      )
    );
    const count = 128;
    yield* seedPatterns(db, count - 1, 1);
    yield* fromPromise(() =>
      db.batch([
        db
          .prepare(`UPDATE recurring_series SET evidence_json = json_set(evidence_json,
        '$.evaluatedFactRevision', (SELECT fact_revision FROM dashboard_projection_state WHERE user_id = ?))
        WHERE user_id = ?`)
          .bind(userId, userId),
        db
          .prepare(`WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM copies WHERE n < ?)
        INSERT INTO recurring_series(user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,confirmed_at,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence)
        SELECT user_id, printf('51000000-0000-4000-8000-%012d',n), currency,
          printf('limit merchant %03d',n),
          json_set(series_json, '$.id', printf('51000000-0000-4000-8000-%012d',n),
            '$.counterparty', printf('Limit merchant %03d',n)),
          json_set(evidence_json, '$.supportingTransactionIds', json_array(
            printf('%08d-0000-4000-8000-000000000001',50000000+n),
            printf('%08d-0000-4000-8000-000000000002',50000000+n),
            printf('%08d-0000-4000-8000-000000000003',50000000+n)),
            '$.latestTransactionId', printf('%08d-0000-4000-8000-000000000003',50000000+n)),
          reference_json, valid, printf('52000000-0000-4000-8000-%012d',n), confirmed_at, confirmation_context_json,
          json_set(confirmation_json, '$.id', printf('52000000-0000-4000-8000-%012d',n),
            '$.seriesId', printf('51000000-0000-4000-8000-%012d',n)),digest_excluded,
          (SELECT max(confirmation_sequence) FROM recurring_series)+n
        FROM recurring_series CROSS JOIN copies WHERE user_id = ? AND id = ?`)
          .bind(count - 1, userId, original),
        db
          .prepare(`UPDATE recurring_evaluation_records SET revision =
        (SELECT fact_revision FROM dashboard_projection_state WHERE user_id = ?), evaluated_revision =
        (SELECT fact_revision FROM dashboard_projection_state WHERE user_id = ?) WHERE user_id = ?`)
          .bind(userId, userId, userId),
      ])
    );
  });

it.effect("publishes exactly 128 proposed series at the coordinator identity limit", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const count = 128;
    yield* seedPatterns(db, count);
    expect((yield* coordinatedEvaluation({ db, userId, steps: count + 10 })).status).toBe(200);
    expect((yield* query(db)).evaluation.kind).toBe("current");
    expect(
      yield* fromPromise(() =>
        db
          .prepare("SELECT count(*) AS count FROM recurring_series WHERE user_id = ?")
          .bind(userId)
          .first<number>("count")
      )
    ).toBe(count);
    expect(
      yield* fromPromise(() =>
        db
          .prepare("SELECT count(confirmation_id) AS count FROM recurring_series WHERE user_id = ?")
          .bind(userId)
          .first<number>("count")
      )
    ).toBe(count);
  })
);

it.effect(
  "guards the retained-plus-new identity union rather than only each individual series count",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const count = 128;
      yield* seedRetainedPatternLimit(db);
      const before = yield* query(db);
      expect(before.evaluation.kind).toBe("current");
      const confirmationsBefore = yield* confirmations(db);
      yield* fromPromise(() =>
        db.batch([
          db
            .prepare(
              "UPDATE transactions SET direction = 'inflow' WHERE user_id = ? AND id LIKE '50000000-%'"
            )
            .bind(userId),
          ...[1, 2, 3].map((month) =>
            captureStatement(db, month, {
              counterparty: "Replacement merchant",
              idPrefix: "58000000",
            })
          ),
        ])
      );
      expect((yield* coordinatedEvaluation({ db, userId, steps: count + 10 })).status).toBe(503);
      const after = yield* query(db);
      expect(after.evaluation.kind).toBe("updating");
      expect(after.series).toEqual(before.series);
      expect(
        (yield* fromPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM recurring_series WHERE user_id = ?")
            .bind(userId)
            .first()
        ))?.count
      ).toBe(count);
      expect(
        (yield* fromPromise(() =>
          db
            .prepare(
              "SELECT count(confirmation_id) AS count FROM recurring_series WHERE user_id = ?"
            )
            .bind(userId)
            .first()
        ))?.count
      ).toBe(count);
      expect(confirmationsBefore.confirmations).toHaveLength(32);
      yield* assertOtherUserEvaluates(db);
    })
);

it.effect(
  "binds complete confirmation traversal to one User and fact revision, retaining invalidation dispositions",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluate(db);
      const page = yield* readRecurringDigestSource({ db, userId, cursor: Option.none() }).pipe(
        Effect.orDie
      );
      expect(page.complete).toBe(true);
      expect(page.confirmations).toHaveLength(1);
      expect(
        Option.getOrThrow(Option.getOrThrow(Option.fromUndefinedOr(page.confirmations[0])).snapshot)
          .occurrence.counterparty
      ).toBe("Netflix");
      const foreign = yield* Effect.exit(
        prepareRecurringDigestSourceGuard({ db, userId: otherUserId, checkpoint: page.checkpoint })
      );
      expect(foreign._tag).toBe("Failure");
      yield* capture(db, 4);
      const guard = yield* prepareRecurringDigestSourceGuard({
        db,
        userId,
        checkpoint: page.checkpoint,
      }).pipe(Effect.orDie);
      const stale = yield* Effect.exit(fromPromise(() => db.batch([...guard])));
      expect(stale._tag).toBe("Failure");
      yield* evaluate(db);
      const refreshed = yield* readRecurringDigestSource({
        db,
        userId,
        cursor: Option.none(),
      }).pipe(Effect.orDie);
      expect(refreshed.checkpoint).not.toBe(page.checkpoint);
    })
);

it.effect("restores fair discovery after erasure removes the dispatch cursor", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const pending = Array.from({ length: 6 }, (_, index) =>
      UserId.make(`90000000-0000-4000-8000-${String(index).padStart(12, "0")}`)
    );
    yield* fromPromise(() =>
      db.batch(
        pending.flatMap((id) => [
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
            )
            .bind(id),
          db
            .prepare(
              "UPDATE dashboard_projection_state SET fact_revision=1,first_captured_at='2026-01-01T00:00:00Z',time_zone='America/Bogota' WHERE user_id=?"
            )
            .bind(id),
        ])
      )
    );
    yield* fromPromise(() =>
      db.batch([
        db.prepare("UPDATE recurring_dispatch SET last_user=? WHERE id=1").bind(userId),
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES ('cursor-erasure',?,0,'Erasing')"
          )
          .bind(userId),
        db
          .prepare("INSERT INTO erasure_permits VALUES ('cursor-erasure',?,'recurring_dispatch')")
          .bind(userId),
        db.prepare("INSERT INTO erasure_chunk VALUES ('cursor-erasure','1')"),
      ])
    );
    const cursor = projections.find((projection) => projection.id === "recurring_dispatch");
    expect(cursor).toBeDefined();
    if (cursor === undefined) return;
    yield* fromPromise(() =>
      db.batch(
        cursor
          .remove({ userId, reference: "cursor-erasure" })
          .map(({ sql, params }) => db.prepare(sql).bind(...params))
      )
    );
    expect(
      yield* fromPromise(() => db.prepare("SELECT last_user FROM recurring_dispatch").first())
    ).toBeNull();
    // Pending Users stay pending: rotation must work even if their execution is unavailable.
    expect(yield* discoverRecurringWork(db)).toEqual(pending.slice(0, 4));
    expect(yield* discoverRecurringWork(db)).toEqual([...pending.slice(4), ...pending.slice(0, 2)]);
    expect(
      yield* fromPromise(() =>
        db.prepare("SELECT last_user FROM recurring_dispatch WHERE id=1").first("last_user")
      )
    ).toBe(pending[1]);
  })
);

it.effect(
  "waits seven days after a completed evaluation despite changed Transactions and skips unchanged weeks",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const completed = DateTime.makeUnsafe("2026-07-01T12:00:00Z").epochMilliseconds;
      yield* TestClock.setTime(completed);
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluate(db);
      expect(yield* discoverRecurringWork(db)).toEqual([]);
      yield* TestClock.setTime(completed + 86400000);
      yield* capture(db, 4);
      expect(yield* discoverRecurringWork(db)).toEqual([]);
      yield* TestClock.setTime(completed + 604800000 - 1);
      expect(yield* discoverRecurringWork(db)).toEqual([]);
      // The hourly discovery may add at most an hour of scheduling delay to the weekly boundary.
      yield* TestClock.setTime(completed + 604800000 + 3600000 - 1);
      expect(yield* discoverRecurringWork(db)).toEqual([userId]);
      yield* evaluate(db);
      const nextCompleted = completed + 604800000 + 3600000 - 1;
      yield* TestClock.setTime(nextCompleted + 604800000);
      expect(yield* discoverRecurringWork(db)).toEqual([]);
      yield* capture(db, 5);
      yield* TestClock.setTime(nextCompleted + 604800000 + 3600000);
      expect(yield* discoverRecurringWork(db)).toEqual([userId]);
    })
);

it.effect("discovers new Users hourly while resuming interrupted evaluation on the next tick", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const start = DateTime.makeUnsafe("2026-07-01T12:00:00Z").epochMilliseconds;
    yield* TestClock.setTime(start);
    expect(yield* discoverRecurringWork(db)).toEqual([]);
    yield* capture(db, 1);
    yield* TestClock.setTime(start + 60000);
    const observed = observeRetentionCost(db);
    expect(yield* discoverRecurringWork(observed.database)).toEqual([]);
    expect(observed.cost().rowsRead).toBeLessThanOrEqual(3);
    const plans = yield* fromPromise(() => observed.plans());
    expect(plans.some((plan) => plan.includes("recurring_unfinished_users"))).toBe(true);
    expect(plans.some((plan) => plan.includes("dashboard_projection_state"))).toBe(false);
    yield* TestClock.setTime(start + 3600000);
    expect(yield* discoverRecurringWork(db)).toEqual([userId]);
    yield* evaluateRecurringSeries({ db, userId });
    yield* TestClock.setTime(start + 3660000);
    yield* advanceRecurringWork({ DB: db, USER_TRANSACTION_COORDINATOR: makeCoordinators(db) });
    expect(
      yield* fromPromise(() =>
        db
          .prepare(
            "SELECT phase FROM (SELECT rowid,user_id,revision,phase,cursor_at,cursor_id,group_key,evaluated_at,evaluated_revision,first_captured_at,time_zone FROM recurring_evaluation_records WHERE kind='progress') WHERE user_id=?"
          )
          .bind(userId)
          .first("phase")
      )
    ).toBe("detect");
  })
);
