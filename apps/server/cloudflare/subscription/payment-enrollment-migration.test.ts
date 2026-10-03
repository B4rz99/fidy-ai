import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { applyTestMigration, isolatedTestDatabases } from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const enrollmentId = "20000000-0000-4000-8000-000000000001";
const sourceId = "30000000-0000-4000-8000-000000000001";
const attemptId = "40000000-0000-4000-8000-000000000001";
const requestId = "50000000-0000-4000-8000-000000000001";
const priceId = "22700000-0000-4000-8000-000000000001";

it("migrates retained card authority without changing BillingAttempt, outbox or charge-arm evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        db.prepare("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL) STRICT").run()
      );
      for (const file of ["0009_card_enrollment", "0012_billing_collection"]) {
        yield* Effect.tryPromise(() =>
          applyTestMigration({ db, source: new URL(`../migrations/${file}.sql`, import.meta.url) })
        );
      }
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare("INSERT INTO users VALUES (?)").bind(userId),
          db
            .prepare(`INSERT INTO card_enrollments (id, user_id, price_id, billing_email, status,
        payment_source_mode, contracts_json, disclosure_json, prepared_at_ms, expires_at_ms,
        payment_request_id, wompi_candidate_source_id)
        VALUES (?, ?, ?, 'payer@example.test', 'creating', 'create', '{}', '{}', 0, 900000, ?, 42)`)
            .bind(enrollmentId, userId, priceId, requestId),
          db
            .prepare(`INSERT INTO card_payment_sources (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms)
        VALUES (?, ?, ?, 42, 'payer@example.test', 0)`)
            .bind(sourceId, userId, enrollmentId),
          db
            .prepare("UPDATE card_enrollments SET status = 'available' WHERE id = ?")
            .bind(enrollmentId),
          db
            .prepare(`INSERT INTO billing_attempts (id, user_id, enrollment_id, payment_request_id, payment_source_id,
        price_id, amount, currency, billing_period, service_market, tax_treatment, time_zone,
        wompi_environment, wompi_reference, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, '9900', 'COP', 'weekly', 'CO', 'not-taxable', 'America/Bogota', 'sandbox', ?, 0)`)
            .bind(
              attemptId,
              userId,
              enrollmentId,
              requestId,
              sourceId,
              priceId,
              `fidy-${attemptId}`
            ),
        ])
      );
      const before = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM billing_attempts").first()
      );
      const outbox = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM billing_collection_outbox").first()
      );
      const arm = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM billing_collection_arms").first()
      );
      yield* Effect.tryPromise(() =>
        applyTestMigration({
          db,
          source: new URL("../migrations/0030_payment_enrollment.sql", import.meta.url),
        })
      );
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT * FROM billing_attempts").first())
      ).toEqual(before);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM billing_collection_outbox").first()
        )
      ).toEqual(outbox);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT * FROM billing_collection_arms").first())
      ).toEqual(arm);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT s.method, a.wompi_environment FROM card_payment_sources AS s JOIN billing_attempts AS a ON a.payment_source_id = s.id"
            )
            .first()
        )
      ).toEqual({ method: "card", wompi_environment: "sandbox" });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT method, wompi_environment FROM card_enrollments").first()
        )
      ).toEqual({ method: "card", wompi_environment: null });
      yield* Effect.tryPromise(() =>
        expect(
          db.prepare("UPDATE card_payment_sources SET method = 'nequi'").run()
        ).rejects.toThrow()
      );
    })
  ));
