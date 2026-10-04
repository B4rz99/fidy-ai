import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { UserId } from "../../src/core/identity/contract";
import { Money } from "../../src/core/_shared/money";
import { RecurringSeriesPage } from "../../src/core/recurring/contract";
import { applyTestMigration, isolatedTestDatabases } from "../d1-test-fixture";
import {
  evaluateRecurringSeries,
  listRecurringSeries,
  readRecurringConfirmations,
} from "./operations";
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
    const folder = new URL("../migrations/", import.meta.url);
    const names = [...new Bun.Glob("*.sql").scanSync({ cwd: folder.pathname })].sort();
    for (const name of names) {
      yield* fromPromise(() =>
        applyTestMigration({ db, source: new URL(name, folder) }).catch((cause: unknown) => {
          throw new Error(`Migration ${name} failed`, { cause });
        })
      );
    }
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
              "INSERT INTO onboarding_consent_records (id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, accepted_at_ms) VALUES (?, ?, '{}', 'disclosure', 'decision', 0, 0)"
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
          headers: { origin: "https://app.fidyapp.com", cookie: `__Host-fidy_session=${bearer}` },
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
            "SELECT count(*) AS count FROM pat_audit WHERE operation = 'recurring.listRecurringSeries'"
          )
          .first()
      );
      expect(audits?.count).toBe(0);
      yield* fromPromise(() =>
        db
          .prepare(
            "INSERT INTO consent_user_revocations (id, user_id, grant_record_id, session_id, occurred_at_ms) VALUES (?, ?, ?, ?, ?)"
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
            "SELECT count(*) AS count FROM pat_audit WHERE operation = 'recurring.listRecurringSeries'"
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
    for (let index = 0; index < seriesCount; index += 1) {
      for (const month of [1, 2, 3]) {
        yield* capture(db, month, {
          counterparty: `Merchant ${String(index).padStart(2, "0")}`,
          idPrefix: String(prefix + index),
        });
      }
    }
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
              "SELECT count(*) AS count FROM pat_audit WHERE operation = 'recurring.listRecurringSeries'"
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
        db.prepare("SELECT count(*) AS count FROM pat_audit WHERE pat_id = ?").bind(patId).first()
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
      for (let index = 0; index < unrelatedCount; index += 1) {
        yield* capture(db, 1, {
          counterparty: "",
          idPrefix: String(prefix + index),
          createdAt: DateTime.formatIso(DateTime.add(base, { hours: index })),
        });
      }
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
                "INSERT INTO transaction_reconciliation_members (user_id, transaction_id, first_transaction_id, second_transaction_id) VALUES (?, ?, ?, ?)"
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
            .prepare("DELETE FROM transaction_reconciliation_members WHERE user_id = ?")
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

it.effect(
  "shares the User budget across browser recurring, other owners and multiple PATs, including the final concurrent slot",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      for (const month of [1, 2, 3]) yield* capture(db, month);
      yield* evaluate(db);
      const financialBefore = yield* confirmations(db);
      const current = DateTime.nowUnsafe().epochMilliseconds;
      const browserBearer = "3".repeat(43);
      const browserDigest = new Uint8Array(
        yield* fromPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(browserBearer))
        )
      );
      yield* fromPromise(() =>
        db
          .prepare("UPDATE web_sessions SET token_digest = ? WHERE id = ?")
          .bind(browserDigest, sessionId)
          .run()
      );
      const patIds = [
        "81000000-0000-4000-8000-000000000001",
        "81000000-0000-4000-8000-000000000002",
      ];
      const tokens = ["fin_abcdefgh_" + "4".repeat(43), "fin_ijklmnop_" + "5".repeat(43)];
      const shortIds = ["abcdefgh", "ijklmnop"];
      const lifetime = 604_800_000;
      for (const [index, patId] of patIds.entries()) {
        const token = Option.getOrThrow(Option.fromUndefinedOr(tokens[index]));
        const patDigest = new Uint8Array(
          yield* fromPromise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))
        );
        yield* fromPromise(() =>
          db
            .prepare(
              `INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json, lifetime_days, created_at_ms, issued_at_ms, expires_at_ms, request_id) VALUES (?, ?, ?, ?, 'Budget test', '["read"]', 7, ?, ?, ?, ?)`
            )
            .bind(
              patId,
              userId,
              shortIds[index],
              patDigest,
              current,
              current,
              current + lifetime,
              patId
            )
            .run()
        );
      }
      const browser = (path: string): Promise<Response> =>
        sendPublic({
          db,
          request: new Request(`https://api.fidyapp.com${path}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${browserBearer}`,
            },
          }),
        });
      const pat = (token: string, path: string): Promise<Response> =>
        sendPublic({
          db,
          request: new Request(`https://api.fidyapp.com${path}`, {
            headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "192.0.2.35" },
          }),
        });
      expect(
        (yield* fromPromise(() =>
          pat(Option.getOrThrow(Option.fromUndefinedOr(tokens[0])), "/recurring-series")
        )).status
      ).toBe(200);
      const seededCalls = 252;
      yield* fromPromise(() =>
        db.batch(
          Array.from({ length: seededCalls }, (_, index) =>
            db
              .prepare(
                "INSERT INTO category_audit (id, user_id, session_id, operation, occurred_at_ms) VALUES (?, ?, ?, 'categories.listCategories', ?)"
              )
              .bind(
                `82000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                userId,
                sessionId,
                current
              )
          )
        )
      );
      expect((yield* fromPromise(() => browser("/recurring-series"))).status).toBe(200);
      expect((yield* fromPromise(() => browser("/categories"))).status).toBe(200);
      const contenders = yield* fromPromise(() =>
        Promise.all([browser("/recurring-series"), browser("/recurring-series")])
      );
      expect(contenders.filter((response) => response.status === 200)).toHaveLength(1);
      expect(contenders.filter((response) => response.status >= 400)).toHaveLength(1);
      const auditBefore = yield* fromPromise(() =>
        db
          .prepare("SELECT count(*) AS count FROM canonical_audit_usage WHERE user_id = ?")
          .bind(userId)
          .first()
      );
      expect(auditBefore?.count).toBe(256);
      const useBefore = yield* fromPromise(() =>
        db
          .prepare("SELECT id, last_used_at_ms FROM pats WHERE user_id = ? ORDER BY id")
          .bind(userId)
          .all()
      );
      for (const path of ["/recurring-series", "/categories", "/transactions"]) {
        const denied = [
          yield* fromPromise(() => browser(path)),
          ...(yield* fromPromise(() => Promise.all(tokens.map((token) => pat(token, path))))),
        ];
        for (const response of denied) {
          expect(response.status).toBeGreaterThanOrEqual(400);
          const body: unknown = yield* fromPromise(() => response.json());
          expect(body).not.toHaveProperty("data");
        }
      }
      expect(
        yield* fromPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM canonical_audit_usage WHERE user_id = ?")
            .bind(userId)
            .first()
        )
      ).toEqual(auditBefore);
      const useAfter = yield* fromPromise(() =>
        db
          .prepare("SELECT id, last_used_at_ms FROM pats WHERE user_id = ? ORDER BY id")
          .bind(userId)
          .all()
      );
      expect(useAfter.results).toEqual(useBefore.results);
      expect(yield* confirmations(db)).toEqual(financialBefore);
      const otherSession = "10000000-0000-4000-8000-000000000062";
      const otherBearer = "6".repeat(43);
      const otherDigest = new Uint8Array(
        yield* fromPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(otherBearer))
        )
      );
      const freshFor = 600_000;
      const idleFor = 3_600_000;
      const hardFor = 7_776_000_000;
      yield* fromPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, 'EFGH-5678', ?, ?, 'consumed', ?, ?)"
            )
            .bind(otherSession, otherDigest, otherUserId, current, current + freshFor),
          db
            .prepare(
              "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
              otherSession,
              otherSession,
              otherUserId,
              otherDigest,
              current,
              current + freshFor,
              current + idleFor,
              current + hardFor
            ),
        ])
      );
      const independent = yield* fromPromise(() =>
        sendPublic({
          db,
          request: new Request("https://api.fidyapp.com/recurring-series", {
            headers: {
              origin: "https://app.fidyapp.com",
              cookie: `__Host-fidy_session=${otherBearer}`,
            },
          }),
        })
      );
      expect(independent.status).toBe(200);
      const independentBody: unknown = yield* fromPromise(() => independent.json());
      expect(
        (yield* Schema.decodeUnknownEffect(
          Schema.toCodecJson(Schema.Struct({ data: RecurringSeriesPage }))
        )(independentBody)).data.series
      ).toEqual([]);
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
const seedPatterns = (db: D1Database, count: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const prefix = 50_000_000;
    const statements = Array.from({ length: count }, (_, index) =>
      [1, 2, 3].map((month) =>
        captureStatement(db, month, {
          counterparty: `Limit merchant ${String(index).padStart(3, "0")}`,
          idPrefix: String(prefix + index),
          createdAt: DateTime.formatIso(
            DateTime.add(
              DateTime.makeUnsafe(`2026-${String(month).padStart(2, "0")}-15T12:00:00.000Z`),
              { hours: index }
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
          .prepare("SELECT confirmation_json FROM recurring_confirmations WHERE user_id = ?")
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
            .prepare("SELECT confirmation_json FROM recurring_confirmations WHERE user_id = ?")
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
          .prepare("SELECT count(*) AS count FROM recurring_confirmations WHERE user_id = ?")
          .bind(userId)
          .first()
      ))?.count
    ).toBe(0);
    yield* assertOtherUserEvaluates(db);
  })
);

it.effect(
  "guards the retained-plus-new identity union rather than only each individual series count",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const count = 128;
      yield* seedPatterns(db, count);
      expect((yield* coordinatedEvaluation({ db, userId, steps: count + 10 })).status).toBe(200);
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
            .prepare("SELECT count(*) AS count FROM recurring_confirmations WHERE user_id = ?")
            .bind(userId)
            .first()
        ))?.count
      ).toBe(count);
      expect(confirmationsBefore.confirmations).toHaveLength(32);
      yield* assertOtherUserEvaluates(db);
    })
);
