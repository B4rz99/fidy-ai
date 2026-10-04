import { TranscriptText } from "../../src/core/agent/contract";
import { Data, DateTime, Effect, Option } from "effect";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import {
  WhatsAppBusinessPhoneNumberId,
  type WhatsAppInboundEvent,
  WhatsAppMediaId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { applyTestMigration, isolatedTestDatabases } from "../d1-test-fixture";
import { acceptWhatsAppMedia, listNeedsReviewItems } from "./operations";
import { sweepMediaSubmissions } from "./runtime";

const pool = isolatedTestDatabases();
afterAll(() => pool.dispose());
const userId = UserId.make("10000000-0000-4000-8000-000000000001");
const otherUser = UserId.make("10000000-0000-4000-8000-000000000002");
const current = DateTime.makeUnsafe("2026-07-15T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());
class TestFailure extends Data.TaggedError("TestFailure")<{ cause: unknown }> {}
const io = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TestFailure({ cause }) }).pipe(Effect.orDie);
const setup = Effect.gen(function* () {
  const db = yield* io(() => pool.acquire());
  yield* io(() =>
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,service_market TEXT DEFAULT 'CO',locale TEXT DEFAULT 'es-CO',time_zone TEXT DEFAULT 'America/Bogota');
 CREATE TABLE trial_periods(user_id TEXT,started_at_ms INTEGER,ends_at_ms INTEGER);
 CREATE TABLE subscriptions(user_id TEXT,attempt_id TEXT,paid_period_ends_at_ms INTEGER);
 CREATE TABLE billing_paid_periods(attempt_id TEXT,starts_at_ms INTEGER);
 CREATE TABLE billing_access_adjustments(attempt_id TEXT,ends_at_ms INTEGER);
 CREATE TABLE whatsapp_identities(user_id TEXT,portfolio_id TEXT,bsuid TEXT);
 CREATE TABLE onboarding_consent_records(user_id TEXT PRIMARY KEY,accepted_at_ms INTEGER);
 CREATE TABLE consent_user_revocations(user_id TEXT PRIMARY KEY);`)
  );
  yield* io(() =>
    db.batch([
      db.prepare("INSERT INTO users(id) VALUES (?),(?)").bind(userId, otherUser),
      db
        .prepare(
          "INSERT INTO whatsapp_identities VALUES (?,'portfolio','CO.actor'),(?,'portfolio','CO.other')"
        )
        .bind(userId, otherUser),
      db
        .prepare("INSERT INTO onboarding_consent_records VALUES (?,1),(?,1)")
        .bind(userId, otherUser),
    ])
  );
  for (const name of ["0032_commercial_allowances", "0035_media_submissions"]) {
    yield* io(() =>
      applyTestMigration({ db, source: new URL(`../migrations/${name}.sql`, import.meta.url) })
    );
  }
  vi.setSystemTime(DateTime.toEpochMillis(current));
  return db;
});
const event = (id: string): WhatsAppInboundEvent => ({
  caller: {
    businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio"),
    businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.actor"),
    parentBusinessScopedUserId: Option.none(),
    username: Option.none(),
    phoneNumber: Option.none(),
  },
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123"),
  messageEvidence: {
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: WhatsAppProviderMessageId.make(id),
  },
  occurredAt: current,
  receivedAt: current,
  replyToMessageId: Option.none(),
  content: { _tag: "Image", mediaId: WhatsAppMediaId.make(`media-${id}`), caption: Option.none() },
});
it("atomically publishes only two unique Free images with visible review and uncharged delivery replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const first = yield* acceptWhatsAppMedia({ db, userId, event: event("first") });
      expect(first.status).toBe(202);
      expect((yield* acceptWhatsAppMedia({ db, userId, event: event("first") })).status).toBe(202);
      const results = yield* Effect.all(
        [
          acceptWhatsAppMedia({ db, userId, event: event("second") }),
          acceptWhatsAppMedia({ db, userId, event: event("third") }),
        ],
        { concurrency: "unbounded" }
      );
      expect(
        results.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([202, 429]);
      const refusal = results.find((response) => response.status === 429);
      expect(yield* io(() => refusal?.json() ?? Promise.resolve(undefined))).toMatchObject({
        error: {
          code: "quota_exhausted",
          allowance: "media_submission",
          resetsAt: "2026-08-01T05:00:00.000Z",
        },
      });
      for (const table of [
        "media_submissions",
        "media_submission_audit",
        "media_submission_outbox",
        "media_needs_review",
      ]) {
        expect(
          yield* io(() => db.prepare(`SELECT count(*) AS total FROM ${table}`).first())
        ).toEqual({ total: 2 });
      }
      expect(
        yield* io(() =>
          db.prepare("SELECT sum(units) AS total FROM commercial_allowance_consumptions").first()
        )
      ).toEqual({ total: 2 });
    })
  ));

it("publishes accepted unextractable images through the canonical visible-review read without locators or captions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const digest = new Uint8Array(32).fill(7);
      const sessionId = "10000000-0000-4000-8000-000000000099";
      const now = DateTime.toEpochMillis(current);
      yield* io(() =>
        db.exec(`CREATE TABLE web_sessions(id TEXT PRIMARY KEY,user_id TEXT,token_digest BLOB,revoked_at_ms INTEGER,idle_expires_at_ms INTEGER,hard_expires_at_ms INTEGER);
 CREATE TABLE statement_submission_audit(id TEXT PRIMARY KEY,user_id TEXT,operation TEXT,outcome TEXT,occurred_at_ms INTEGER);
 CREATE TABLE statement_review_audit(id TEXT PRIMARY KEY,user_id TEXT,operation TEXT,outcome TEXT,occurred_at_ms INTEGER);
 CREATE TABLE statement_submissions(id TEXT,user_id TEXT);
 CREATE TABLE statement_clarifications(submission_id TEXT,user_id TEXT,state TEXT,expires_at_ms INTEGER);
 CREATE TABLE statement_review_decisions(review_id TEXT,user_id TEXT,decision TEXT,transaction_id TEXT,decided_at_ms INTEGER);
 CREATE TABLE statement_needs_review(id TEXT,submission_id TEXT,record_number INTEGER,reason TEXT,original_evidence TEXT,issues TEXT,status TEXT,created_at_ms INTEGER,service_market TEXT,locale TEXT,time_zone TEXT,source_format TEXT,parser_revision TEXT,extractor_revision TEXT,evidence_expires_at_ms INTEGER,user_id TEXT);
 CREATE TABLE forwarded_email_needs_review(id TEXT,receipt_id TEXT,reason TEXT,created_at_ms INTEGER,evidence_expires_at_ms INTEGER,user_id TEXT);
 CREATE TABLE forwarded_email_receipts(id TEXT,time_zone TEXT,user_id TEXT);`)
      );
      yield* io(() =>
        db
          .prepare("INSERT INTO web_sessions VALUES (?,?,?,NULL,?,?)")
          .bind(sessionId, userId, digest, now + 60000, now + 60000)
          .run()
      );
      expect((yield* acceptWhatsAppMedia({ db, userId, event: event("unparseable") })).status).toBe(
        202
      );
      const response = yield* listNeedsReviewItems({
        database: db,
        environment: { DB: db },
        subject: { id: sessionId, userId, digest },
        url: new URL("https://api.test/ingestion/needs-review"),
      });
      expect(response.status).toBe(200);
      const serialized = yield* io(() => response.clone().text());
      const body = yield* io(() => response.json());
      expect(body).toMatchObject({
        data: [
          {
            sourceChannel: "whatsapp",
            sourceFormat: "image",
            status: "pending",
            reason: "extraction-unavailable",
          },
        ],
      });
      expect(serialized).not.toContain("media-unparseable");
      expect(serialized).not.toContain("portfolio");
      expect(
        yield* io(() =>
          db.prepare("SELECT sum(units) AS total FROM commercial_allowance_consumptions").first()
        )
      ).toEqual({ total: 1 });
    })
  ));

it("rechecks current association and Consent before publication and exact replay disclosure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      expect(
        (yield* acceptWhatsAppMedia({ db, userId: otherUser, event: event("foreign") })).status
      ).toBe(403);
      expect((yield* acceptWhatsAppMedia({ db, userId, event: event("first") })).status).toBe(202);
      yield* io(() =>
        db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(userId).run()
      );
      expect((yield* acceptWhatsAppMedia({ db, userId, event: event("first") })).status).toBe(403);
      expect((yield* acceptWhatsAppMedia({ db, userId, event: event("second") })).status).toBe(403);
      expect(
        yield* io(() => db.prepare("SELECT count(*) AS total FROM media_submissions").first())
      ).toEqual({ total: 1 });
    })
  ));

it("rolls submission, consumption, accountability and review back when outbox publication fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      yield* io(() =>
        db.exec(
          "CREATE TRIGGER failed_outbox BEFORE INSERT ON media_submission_outbox BEGIN SELECT RAISE(ABORT,'private failed publication'); END"
        )
      );
      expect((yield* acceptWhatsAppMedia({ db, userId, event: event("first") })).status).toBe(503);
      for (const table of [
        "media_submissions",
        "media_submission_audit",
        "media_needs_review",
        "commercial_allowance_consumptions",
      ]) {
        expect(
          yield* io(() => db.prepare(`SELECT count(*) AS total FROM ${table}`).first())
        ).toEqual({ total: 0 });
      }
    })
  ));

it("refuses changed material under an accepted delivery identity and never treats pasted text as media", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const first = event("first");
      expect((yield* acceptWhatsAppMedia({ db, userId, event: first })).status).toBe(202);
      expect(
        (yield* acceptWhatsAppMedia({
          db,
          userId,
          event: {
            ...first,
            content: {
              _tag: "Image",
              mediaId: WhatsAppMediaId.make("different"),
              caption: Option.none(),
            },
          },
        })).status
      ).toBe(409);
      expect(
        (yield* acceptWhatsAppMedia({
          db,
          userId,
          event: {
            ...first,
            content: { _tag: "Text", text: TranscriptText.make("pasted receipt") },
          },
        })).status
      ).toBe(400);
      expect(
        yield* io(() =>
          db.prepare("SELECT sum(units) AS total FROM commercial_allowance_consumptions").first()
        )
      ).toEqual({ total: 1 });
    })
  ));

it("keeps Trial media commercially uncapped and derives standing again after Trial expiry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      const now = DateTime.toEpochMillis(current);
      yield* io(() =>
        db
          .prepare("INSERT INTO trial_periods VALUES (?,?,?)")
          .bind(userId, now - 1000, now + 1)
          .run()
      );
      for (const id of ["one", "two", "three"]) {
        expect((yield* acceptWhatsAppMedia({ db, userId, event: event(id) })).status).toBe(202);
      }
      expect(
        yield* io(() =>
          db.prepare("SELECT sum(units) AS total FROM commercial_allowance_consumptions").first()
        )
      ).toEqual({ total: 0 });
      const afterTrial = (id: string): WhatsAppInboundEvent => ({
        ...event(id),
        receivedAt: DateTime.makeUnsafe(now + 1),
      });
      for (const id of ["four", "five"]) {
        expect((yield* acceptWhatsAppMedia({ db, userId, event: afterTrial(id) })).status).toBe(
          202
        );
      }
      expect((yield* acceptWhatsAppMedia({ db, userId, event: afterTrial("six") })).status).toBe(
        429
      );
      expect(
        yield* io(() =>
          db.prepare("SELECT sum(units) AS total FROM commercial_allowance_consumptions").first()
        )
      ).toEqual({ total: 2 });
    })
  ));

it("expires personal media locators without recharge on exact replay and eventually removes inactive-User metadata", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup;
      expect((yield* acceptWhatsAppMedia({ db, userId, event: event("first") })).status).toBe(202);
      const expired = DateTime.toEpochMillis(current) + 2592000000;
      yield* sweepMediaSubmissions({ db, now: expired });
      expect(
        yield* io(() => db.prepare("SELECT media_id,caption FROM media_submissions").first())
      ).toEqual({ media_id: null, caption: null });
      expect(
        yield* io(() => db.prepare("SELECT count(*) AS total FROM media_submission_outbox").first())
      ).toEqual({ total: 0 });
      expect(
        (yield* acceptWhatsAppMedia({
          db,
          userId,
          event: { ...event("first"), receivedAt: DateTime.makeUnsafe(expired) },
        })).status
      ).toBe(202);
      expect(
        yield* io(() =>
          db.prepare("SELECT sum(units) AS total FROM commercial_allowance_consumptions").first()
        )
      ).toEqual({ total: 1 });
      yield* sweepMediaSubmissions({ db, now: DateTime.toEpochMillis(current) + 31536000000 });
      for (const table of ["media_submissions", "media_submission_audit", "media_needs_review"]) {
        expect(
          yield* io(() => db.prepare(`SELECT count(*) AS total FROM ${table}`).first())
        ).toEqual({ total: 0 });
      }
    })
  ));
