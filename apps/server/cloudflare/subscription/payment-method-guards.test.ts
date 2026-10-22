import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const priceId = "22700000-0000-4000-8000-000000000001";
const identity = (kind: number, index: number): string =>
  `${kind}0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const baseline = Effect.fnUntraced(function* () {
  const db = yield* Effect.tryPromise(() => databases.acquire());
  yield* Effect.tryPromise(() => installTestSchema({ db }));
  return db;
});

type EnrollmentSeed = Readonly<{
  method: string;
  environment: string;
  digest: string;
  userIndex: number;
  historical: boolean;
  sourceMode: string;
}>;
const enrollmentSeed = (index: number, method: string): EnrollmentSeed => ({
  method,
  environment: "sandbox",
  digest: String(index).padStart(64, "0"),
  userIndex: index,
  historical: false,
  sourceMode: "create",
});
const enrollment = (
  db: D1Database,
  index: number,
  { method, environment, digest, userIndex, historical, sourceMode }: EnrollmentSeed
): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO payment_enrollments (id,subscription_id, price_id, billing_email, status,
    payment_source_mode, contracts_json, disclosure_json, prepared_at_ms, expires_at_ms,
    accepted_at_ms, payment_request_id, wompi_candidate_source_id, method, wompi_environment,
    authorization_digest) VALUES (?, (SELECT id FROM subscriptions WHERE user_id=?), ?, 'payer@example.test', 'creating', ?,
    '{"terms":"retained"}', '{"accepted":"retained"}', 100, 900100, 200, ?, ?, ?, ?, ?)`)
    .bind(
      identity(2, index),
      identity(1, userIndex),
      priceId,
      sourceMode,
      identity(5, index),
      index,
      method,
      historical ? null : environment,
      historical ? null : digest
    );
const source = (db: D1Database, index: number, method: string): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_source_id,billing_email,verified_at_ms,method,wompi_environment,archive_row_ref)
 SELECT incoming.id,e.subscription_id,incoming.enrollment_id,incoming.wompi_source_id,incoming.billing_email,incoming.created_at_ms,incoming.method,e.wompi_environment,'source:'||incoming.id FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms,column7 AS method FROM (VALUES (?, ?, ?, ?, 'payer@example.test', 300, ?))) incoming
 JOIN payment_enrollments e ON e.id=incoming.enrollment_id JOIN subscriptions sub ON sub.id=e.subscription_id AND sub.user_id=incoming.user_id`
    )
    .bind(identity(3, index), identity(1, index), identity(2, index), index, method);
const attempt = (
  db: D1Database,
  index: number,
  {
    sourceIndex,
    environment,
    userIndex,
  }: Readonly<{ sourceIndex: number; environment: string; userIndex: number }> = {
    sourceIndex: index,
    environment: "sandbox",
    userIndex: index,
  }
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO billing_attempts (id, subscription_id, enrollment_id, payment_request_id, payment_source_id, price_id, time_zone, wompi_environment, wompi_reference, created_at_ms) VALUES (?, (SELECT id FROM subscriptions WHERE user_id=?), ?, ?, ?, ?, 'America/Bogota', ?, ?, 400)`
    )
    .bind(
      identity(4, index),
      identity(1, userIndex),
      identity(2, index),
      identity(5, index),
      identity(3, sourceIndex),
      priceId,
      environment,
      `fidy-${identity(4, index)}`
    );
const available = (db: D1Database, index: number): D1PreparedStatement =>
  db
    .prepare("UPDATE payment_enrollments SET status = 'available' WHERE id = ?")
    .bind(identity(2, index));
const user = (db: D1Database, index: number): ReadonlyArray<D1PreparedStatement> => [
  db
    .prepare(
      "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
    )
    .bind(identity(1, index)),
  db
    .prepare("INSERT INTO subscriptions(id,user_id) VALUES(?,?)")
    .bind(identity(1, index), identity(1, index)),
];

const retainedState = Effect.fnUntraced(function* (db: D1Database) {
  const tables = yield* Effect.tryPromise(() =>
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
      )
      .all<{ name: string }>()
  );
  return yield* Effect.tryPromise(() =>
    db
      .batch(tables.results.map(({ name }) => db.prepare(`SELECT * FROM "${name}" ORDER BY 1`)))
      .then((rows) => rows.map((row) => row.results))
  );
});

const rejectsAtomically = Effect.fnUntraced(function* (
  db: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>,
  reason: string
) {
  const before = yield* retainedState(db);
  yield* Effect.tryPromise(() =>
    expect(
      db.batch([
        db.prepare(
          "INSERT INTO sql_assertions(scope,accepted) VALUES ('payment_commit',1) ON CONFLICT(scope) DO UPDATE SET accepted=1"
        ),
        ...statements,
      ])
    ).rejects.toThrow(reason)
  );
  expect(yield* retainedState(db)).toEqual(before);
});

it("rejects invalid methods, unclaimed or mismatched sources and authorization replay without partial writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* baseline();
      yield* Effect.tryPromise(() =>
        db.batch([
          ...user(db, 1),
          enrollment(db, 1, enrollmentSeed(1, "card")),
          source(db, 1, "card"),
          available(db, 1),
          ...user(db, 2),
          enrollment(db, 2, enrollmentSeed(2, "nequi")),
          source(db, 2, "nequi"),
          available(db, 2),
          ...user(db, 3),
          enrollment(db, 3, enrollmentSeed(3, "daviplata")),
          ...user(db, 4),
        ])
      );
      for (const [method, environment] of [
        ["nequi", "sandbox"],
        ["card", "production"],
      ]) {
        yield* rejectsAtomically(
          db,
          [
            db
              .prepare(`INSERT INTO payment_enrollments(id,subscription_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,method,wompi_environment,payment_source_id)
        SELECT ?,subscription_id,price_id,billing_email,'prepared','reuse',contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,?,?,payment_source_id FROM payment_enrollments WHERE id=?`)
              .bind(identity(2, 99), method, environment, identity(2, 1)),
          ],
          "payment_enrollment_source_mismatch"
        );
      }
      yield* rejectsAtomically(
        db,
        [enrollment(db, 4, { ...enrollmentSeed(4, "daviplata"), userIndex: 9 })],
        "NOT NULL constraint failed"
      );
      yield* rejectsAtomically(
        db,
        [enrollment(db, 4, enrollmentSeed(4, "cash"))],
        "CHECK constraint failed"
      );
      yield* rejectsAtomically(db, [source(db, 3, "cash")], "payment_source_invalid_claim");
      yield* rejectsAtomically(db, [source(db, 3, "nequi")], "payment_source_invalid_claim");
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare("UPDATE payment_enrollments SET status = 'refused' WHERE id = ?")
            .bind(identity(2, 3)),
          source(db, 3, "daviplata"),
        ],
        "payment_source_invalid_claim"
      );
      yield* rejectsAtomically(
        db,
        [
          enrollment(db, 4, { ...enrollmentSeed(4, "daviplata"), historical: true }),
          source(db, 4, "daviplata"),
        ],
        "payment_source_invalid_claim"
      );
      yield* rejectsAtomically(
        db,
        [
          enrollment(db, 4, {
            ...enrollmentSeed(4, "daviplata"),
            digest: enrollmentSeed(2, "nequi").digest,
          }),
        ],
        "UNIQUE constraint failed"
      );
      yield* Effect.tryPromise(() => db.batch([source(db, 3, "daviplata"), available(db, 3)]));
      yield* rejectsAtomically(
        db,
        [
          enrollment(db, 4, { ...enrollmentSeed(4, "daviplata"), userIndex: 3 }),
          db
            .prepare(
              `INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_source_id,billing_email,verified_at_ms,method,wompi_environment,archive_row_ref)
 SELECT incoming.id,e.subscription_id,incoming.enrollment_id,incoming.wompi_source_id,incoming.billing_email,incoming.created_at_ms,incoming.method,e.wompi_environment,'source:'||incoming.id FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms,column7 AS method FROM (VALUES (?, ?, ?, 4, 'payer@example.test', 300, 'daviplata'))) incoming
 JOIN payment_enrollments e ON e.id=incoming.enrollment_id JOIN subscriptions sub ON sub.id=e.subscription_id AND sub.user_id=incoming.user_id`
            )
            .bind(identity(3, 4), identity(1, 3), identity(2, 4)),
        ],
        "UNIQUE constraint failed"
      );
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare("UPDATE payment_enrollments SET wompi_candidate_source_id = NULL WHERE id = ?")
            .bind(identity(2, 1)),
          enrollment(db, 4, enrollmentSeed(4, "daviplata")),
          db
            .prepare("UPDATE payment_enrollments SET wompi_candidate_source_id = 1 WHERE id = ?")
            .bind(identity(2, 4)),
          db
            .prepare(
              `INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_source_id,billing_email,verified_at_ms,method,wompi_environment,archive_row_ref)
 SELECT incoming.id,e.subscription_id,incoming.enrollment_id,incoming.wompi_source_id,incoming.billing_email,incoming.created_at_ms,incoming.method,e.wompi_environment,'source:'||incoming.id FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms,column7 AS method FROM (VALUES (?, ?, ?, 1, 'payer@example.test', 300, 'daviplata'))) incoming
 JOIN payment_enrollments e ON e.id=incoming.enrollment_id JOIN subscriptions sub ON sub.id=e.subscription_id AND sub.user_id=incoming.user_id`
            )
            .bind(identity(3, 4), identity(1, 4), identity(2, 4)),
        ],
        "UNIQUE constraint failed"
      );
      yield* rejectsAtomically(
        db,
        [
          enrollment(db, 4, enrollmentSeed(4, "daviplata")),
          db
            .prepare(
              `INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_source_id,billing_email,verified_at_ms,method,wompi_environment,archive_row_ref)
 SELECT incoming.id,e.subscription_id,incoming.enrollment_id,incoming.wompi_source_id,incoming.billing_email,incoming.created_at_ms,incoming.method,e.wompi_environment,'source:'||incoming.id FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms,column7 AS method FROM (VALUES (?, ?, ?, 4, 'payer@example.test', 300, 'daviplata'))) incoming
 JOIN payment_enrollments e ON e.id=incoming.enrollment_id JOIN subscriptions sub ON sub.id=e.subscription_id AND sub.user_id=incoming.user_id`
            )
            .bind(identity(3, 1), identity(1, 4), identity(2, 4)),
        ],
        "UNIQUE constraint failed"
      );
      for (const field of [
        "method = 'card'",
        "wompi_environment = 'production'",
        "authorization_digest = NULL",
      ]) {
        yield* rejectsAtomically(
          db,
          [db.prepare(`UPDATE payment_enrollments SET ${field} WHERE id = ?`).bind(identity(2, 3))],
          "payment_enrollment_method_immutable"
        );
      }
      for (const field of [
        "contracts_json = '{}'",
        "price_id = '22700000-0000-4000-8000-000000000002'",
        "payment_request_id = NULL",
      ]) {
        yield* rejectsAtomically(
          db,
          [db.prepare(`UPDATE payment_enrollments SET ${field} WHERE id = ?`).bind(identity(2, 3))],
          "card_enrollment_evidence_immutable"
        );
      }
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare("UPDATE payment_sources SET method = 'card' WHERE id = ?")
            .bind(identity(3, 3)),
        ],
        "payment_source_immutable"
      );
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
  ));

it("keeps attempt method, environment, ownership, price and replay guards atomic with collection work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* baseline();
      yield* Effect.tryPromise(() =>
        db.batch([
          ...user(db, 1),
          enrollment(db, 1, enrollmentSeed(1, "card")),
          source(db, 1, "card"),
          available(db, 1),
          ...user(db, 3),
          enrollment(db, 3, enrollmentSeed(3, "daviplata")),
          source(db, 3, "daviplata"),
          available(db, 3),
        ])
      );
      yield* rejectsAtomically(
        db,
        [attempt(db, 3, { userIndex: 3, sourceIndex: 1, environment: "sandbox" })],
        "payment_attempt_method_mismatch"
      );
      yield* rejectsAtomically(
        db,
        [attempt(db, 3, { userIndex: 3, sourceIndex: 3, environment: "production" })],
        "payment_attempt_method_mismatch"
      );
      yield* rejectsAtomically(
        db,
        [
          enrollment(db, 4, { ...enrollmentSeed(4, "daviplata"), userIndex: 1 }),
          available(db, 4),
          attempt(db, 4, { userIndex: 1, sourceIndex: 1, environment: "sandbox" }),
        ],
        "payment_attempt_method_mismatch"
      );
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare("UPDATE payment_enrollments SET status = 'verifying' WHERE id = ?")
            .bind(identity(2, 3)),
          attempt(db, 3),
        ],
        "billing_attempt_invalid_claim"
      );
      yield* Effect.tryPromise(() => db.batch([attempt(db, 1), attempt(db, 3)]));
      yield* rejectsAtomically(db, [attempt(db, 3)], "billing_user_collection_unresolved");
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare(
              "UPDATE billing_attempts SET price_id = '22700000-0000-4000-8000-000000000002' WHERE id = ?"
            )
            .bind(identity(4, 3)),
        ],
        "billing_attempt_snapshot_immutable"
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE billing_attempts SET status = 'succeeded', finalized_at_ms = 500 WHERE id = ?"
          )
          .bind(identity(4, 3))
          .run()
      );
      yield* rejectsAtomically(db, [attempt(db, 3)], "UNIQUE constraint failed");
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare("UPDATE billing_attempts SET status = 'failed' WHERE id = ?")
            .bind(identity(4, 3)),
        ],
        "billing_attempt_terminal_immutable"
      );
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
  ));
