import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { afterAll, expect } from "vitest";
import { CategoryId } from "../../src/core/categories/reference";
import {
  NotificationInterpretationEvidence,
  TransactionExtraction,
} from "../../src/core/transactions/contract";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { prepareNotificationEmailCapture, prepareStatementCapture } from "./operations";
import type { StatementCaptureInput } from "./contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = "10000000-0000-4000-8000-000000000101";
const userB = "10000000-0000-4000-8000-000000000102";
const transactionId = "10000000-0000-4000-8000-000000000601";
const attestationId = "10000000-0000-4000-8000-000000000602";
const submissionId = "10000000-0000-4000-8000-000000000603";
const run = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);

const setup = Effect.fn(function* () {
  const db = yield* run(() => databases.acquire());
  yield* run(() =>
    db.exec(`CREATE TABLE capture_sources (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount TEXT, currency TEXT, direction TEXT, counterparty TEXT, category_id TEXT, notes TEXT, occurred_at TEXT, created_at TEXT, UNIQUE (user_id, id));
      CREATE TABLE source_attestations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, transaction_id TEXT NOT NULL, kind TEXT, service_market TEXT, locale TEXT, time_zone TEXT, interpretation_revision TEXT, created_at TEXT, statement_submission_id TEXT, statement_record_number INTEGER, statement_content_hash TEXT, source_format TEXT, received_email_id TEXT, message_content_sha256 TEXT, message_evidence TEXT, deterministic_interpretation TEXT, extractor_revision TEXT, FOREIGN KEY (user_id, transaction_id) REFERENCES transactions(user_id, id));
      CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY);
      CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY);`)
  );
  yield* run(() =>
    db.prepare("INSERT INTO capture_sources VALUES (?, ?, 1)").bind(submissionId, userA).run()
  );
  yield* run(() =>
    db.prepare("INSERT INTO onboarding_consent_records VALUES (?)").bind(userA).run()
  );
  return db;
});

const captureInput = (db: D1Database, userId: string): StatementCaptureInput => ({
  db,
  userId,
  transactionId,
  extraction: Schema.decodeSync(TransactionExtraction)({
    money: { amount: "45000.25", currency: "COP" },
    direction: "outflow",
    occurredAt: "2026-08-01T05:00:00.000Z",
  }),
  categoryId: CategoryId.make("10000000-0000-4000-8000-000000000001"),
  attestation: {
    id: attestationId,
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    interpretationRevision: "statement-parser-v1",
    createdAt: "2026-08-02T10:00:00.000Z",
    statementSubmissionId: submissionId,
    statementRecordNumber: 1,
    statementContentHash: "a".repeat(64),
    sourceFormat: "csv",
  },
  sourceGuard: {
    sql: "SELECT user_id FROM capture_sources WHERE id = ? AND active = 1",
    params: [submissionId],
  },
});

it.effect(
  "binds captured facts and historical evidence to the explicit User in one caller batch",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      yield* run(() => db.batch([...prepareStatementCapture(captureInput(db, userA))]));
      const row = yield* run(() =>
        db
          .prepare(`SELECT t.user_id, t.amount, t.currency, t.direction, t.counterparty,
        t.category_id, t.notes, t.occurred_at, t.created_at, a.kind, a.service_market, a.locale,
        a.time_zone, a.interpretation_revision, a.statement_submission_id,
        a.statement_record_number, a.statement_content_hash, a.source_format
        FROM transactions t JOIN source_attestations a ON a.user_id = t.user_id AND a.transaction_id = t.id`)
          .first()
      );
      expect(row).toEqual({
        user_id: userA,
        amount: "45000.25",
        currency: "COP",
        direction: "outflow",
        counterparty: null,
        category_id: "10000000-0000-4000-8000-000000000001",
        notes: null,
        occurred_at: "2026-08-01T05:00:00.000Z",
        created_at: "2026-08-02T10:00:00.000Z",
        kind: "statement-line",
        service_market: "CO",
        locale: "es-CO",
        time_zone: "America/Bogota",
        interpretation_revision: "statement-parser-v1",
        statement_submission_id: submissionId,
        statement_record_number: 1,
        statement_content_hash: "a".repeat(64),
        source_format: "csv",
      });
    })
);

it.effect("rejects a foreign source projection and rechecks source eligibility at commit", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    yield* run(() => db.batch([...prepareStatementCapture(captureInput(db, userB))]));
    const prepared = prepareStatementCapture(captureInput(db, userA));
    yield* run(() => db.prepare("UPDATE capture_sources SET active = 0").run());
    yield* run(() => db.batch([...prepared]));
    const result = yield* run(() =>
      db
        .prepare(`SELECT (SELECT count(*) FROM transactions) AS transactions,
        (SELECT count(*) FROM source_attestations) AS attestations`)
        .first()
    );
    expect(result).toEqual({ transactions: 0, attestations: 0 });
  })
);

const prepareEmail = (
  db: D1Database
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, Schema.SchemaError> => {
  const statement = captureInput(db, userA);
  return prepareNotificationEmailCapture({
    ...statement,
    attestation: {
      id: attestationId,
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: "America/Lima",
      interpretationRevision: "notification-v1",
      createdAt: "2026-08-02T10:00:00.000Z",
      receivedEmailId: submissionId,
      messageContentSha256: "b".repeat(64),
      sourceFormat: "notification-email",
      messageEvidence: {
        channel: "email",
        provider: "cloudflare-email",
        providerMessageId: submissionId,
      },
      extractorRevision: "forwarded-email-deterministic-v1",
    },
    interpretation: Schema.decodeSync(NotificationInterpretationEvidence)({
      formatId: "test-email",
      currencyBasis: "explicit",
      accountHints: { cardLastFour: "0012", instrumentLabel: "Visa" },
    }),
  });
};

it.effect(
  "retains complete notification evidence with its captured context and interpretation revision",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      const statements = yield* prepareEmail(db);
      yield* run(() => db.batch([...statements]));
      const row = yield* run(() =>
        db
          .prepare(`SELECT user_id, kind, service_market, locale, time_zone, interpretation_revision,
        received_email_id, message_content_sha256, source_format, message_evidence,
        deterministic_interpretation, extractor_revision FROM source_attestations`)
          .first()
      );
      expect(row).toEqual({
        user_id: userA,
        kind: "notification-email",
        service_market: "CO",
        locale: "es-CO",
        time_zone: "America/Lima",
        interpretation_revision: "notification-v1",
        received_email_id: submissionId,
        message_content_sha256: "b".repeat(64),
        source_format: "notification-email",
        message_evidence:
          '{"channel":"email","provider":"cloudflare-email","providerMessageId":"10000000-0000-4000-8000-000000000603"}',
        deterministic_interpretation:
          '{"formatId":"test-email","currencyBasis":"explicit","accountHints":{"cardLastFour":"0012","instrumentLabel":"visa"},"revision":"notification-v1"}',
        extractor_revision: "forwarded-email-deterministic-v1",
      });
    })
);

it.effect("refuses both prepared email writes when Consent is withdrawn before commit", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    const statements = yield* prepareEmail(db);
    yield* run(() =>
      db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(userA).run()
    );
    yield* run(() => db.batch([...statements]));
    const result = yield* run(() =>
      db
        .prepare(`SELECT (SELECT count(*) FROM transactions) AS transactions,
        (SELECT count(*) FROM source_attestations) AS attestations`)
        .first()
    );
    expect(result).toEqual({ transactions: 0, attestations: 0 });
  })
);
