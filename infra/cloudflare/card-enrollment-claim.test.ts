// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { BillingEmail, CardEnrollmentId, PaymentRequestId } from "@fidy/server/client";
import { UserId } from "@fidy/server/identity-runtime";
import { claimPreparedCardEnrollment } from "./card-enrollment-claim";

const userA = UserId.make("10000000-0000-4000-8000-000000000001");
const userB = UserId.make("10000000-0000-4000-8000-000000000002");
const enrollmentId = CardEnrollmentId.make("20000000-0000-4000-8000-000000000001");
const paymentRequestId = PaymentRequestId.make("30000000-0000-4000-8000-000000000001");
const billingEmail = BillingEmail.make("a@example.test");
const priceId = "40000000-0000-4000-8000-000000000001";
const nowMs = 1_000_000;
let nextDatabase = 0;
const instances: Array<Miniflare> = [];

// @effect-diagnostics-next-line asyncFunction:off
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

// @effect-diagnostics-next-line asyncFunction:off
const setup = async (): Promise<D1Database> => {
  const name = `card-enrollment-${++nextDatabase}`;
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
  instances.push(mf);
  await mf.ready;
  const db = await mf.getD1Database("DB");
  await db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL) STRICT;");
  const migration = await readFile(
    new URL("./migrations/0009_card_enrollment.sql", import.meta.url),
    "utf8"
  );
  await migration
    .replace(/^--.*$/gmu, "")
    .trim()
    .split(/;\s*\n(?=CREATE |$)/u)
    .reduce<Promise<void>>(
      (previous, statement) =>
        previous.then(() => db.prepare(statement).run()).then(() => undefined),
      Promise.resolve()
    );
  await db.prepare("INSERT INTO users (id) VALUES (?), (?)").bind(userA, userB).run();
  await db
    .prepare(`INSERT INTO subscription_prices
    (id, amount, currency, billing_period, service_market, tax_treatment, terms_json)
    VALUES (?, '9900', 'COP', 'weekly', 'CO', 'not-taxable', '{}')`)
    .bind(priceId)
    .run();
  await db
    .prepare(`INSERT INTO card_enrollments
    (id, user_id, price_id, billing_email, status, payment_source_mode,
     contracts_json, disclosure_json, prepared_at_ms, expires_at_ms)
    VALUES (?, ?, ?, 'a@example.test', 'prepared', 'create', '{}', '{}', ?, ?)`)
    .bind(enrollmentId, userA, priceId, nowMs, nowMs + 900_000)
    .run();
  return db;
};

// @effect-diagnostics-next-line asyncFunction:off
it("only the owning User can claim a prepared CardEnrollment, once", async () => {
  const db = await setup();
  const request = { enrollmentId, paymentRequestId, billingEmail };
  expect(await claimPreparedCardEnrollment(db, { ...request, userId: userB }, nowMs)).toBe(false);
  const unclaimed = await db
    .prepare("SELECT status, payment_request_id FROM card_enrollments WHERE id = ?")
    .bind(enrollmentId)
    .first();
  expect(unclaimed).toEqual({ status: "prepared", payment_request_id: null });
  const outcomes = await Promise.all([
    claimPreparedCardEnrollment(db, { ...request, userId: userA }, nowMs),
    claimPreparedCardEnrollment(db, { ...request, userId: userA }, nowMs),
  ]);
  expect(outcomes.sort()).toEqual([false, true]);
  expect(await claimPreparedCardEnrollment(db, { ...request, userId: userA }, nowMs)).toBe(false);
  expect(
    await db
      .prepare("SELECT status, payment_request_id FROM card_enrollments WHERE id = ?")
      .bind(enrollmentId)
      .first()
  ).toEqual({ status: "creating", payment_request_id: paymentRequestId });
});

// @effect-diagnostics-next-line asyncFunction:off
it("an expired preparation cannot authorize a provider source", async () => {
  const db = await setup();
  expect(
    await claimPreparedCardEnrollment(
      db,
      {
        userId: userA,
        enrollmentId,
        paymentRequestId,
        billingEmail,
      },
      nowMs + 900_000
    )
  ).toBe(false);
  await expect(
    db
      .prepare(`INSERT INTO card_payment_sources
    (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms)
    VALUES (?, ?, ?, 42, 'a@example.test', ?)`)
      .bind("50000000-0000-4000-8000-000000000001", userA, enrollmentId, nowMs)
      .run()
  ).rejects.toThrow();
  expect((await db.prepare("SELECT id FROM card_payment_sources").all()).results).toEqual([]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects a pending BillingAttempt whose snapshot differs from the selected Price", async () => {
  const db = await setup();
  expect(
    await claimPreparedCardEnrollment(
      db,
      {
        userId: userA,
        enrollmentId,
        paymentRequestId,
        billingEmail,
      },
      nowMs
    )
  ).toBe(true);
  const sourceId = "50000000-0000-4000-8000-000000000001";
  await db
    .prepare(`INSERT INTO card_payment_sources
    (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms)
    VALUES (?, ?, ?, 42, ?, ?)`)
    .bind(sourceId, userA, enrollmentId, billingEmail, nowMs)
    .run();
  await db
    .prepare("UPDATE card_enrollments SET status = 'available' WHERE id = ?")
    .bind(enrollmentId)
    .run();
  const insert = db.prepare(`INSERT INTO billing_attempts
    (id, user_id, enrollment_id, payment_request_id, payment_source_id, price_id,
     amount, currency, billing_period, service_market, tax_treatment, time_zone,
     wompi_environment, wompi_reference, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'COP', 'weekly', 'CO', 'not-taxable',
      'America/Bogota', 'sandbox', ?, ?)`);
  await expect(
    insert
      .bind(
        "60000000-0000-4000-8000-000000000001",
        userA,
        enrollmentId,
        paymentRequestId,
        sourceId,
        priceId,
        "1",
        "fidy-60000000-0000-4000-8000-000000000001",
        nowMs
      )
      .run()
  ).rejects.toThrow();
  expect((await db.prepare("SELECT id FROM billing_attempts").all()).results).toEqual([]);
});
