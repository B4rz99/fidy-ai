import { Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { applyTestMigration, isolatedTestDatabases } from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const priceId = "22700000-0000-4000-8000-000000000001";
const identity = (kind: number, index: number): string =>
  `${kind}0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const migration = (db: D1Database): Promise<void> =>
  applyTestMigration({
    db,
    source: new URL("../migrations/0031_daviplata_enrollment.sql", import.meta.url),
  });

const baseline = Effect.fnUntraced(function* () {
  const db = yield* Effect.tryPromise(() => databases.acquire());
  const files = yield* Effect.try(() => [
    ...new Bun.Glob("*.sql").scanSync({
      cwd: new URL("../migrations/", import.meta.url).pathname,
    }),
  ]);
  for (const file of files.filter((name) => name.endsWith(".sql") && name < "0031").sort()) {
    yield* Effect.tryPromise(() =>
      applyTestMigration({ db, source: new URL(`../migrations/${file}`, import.meta.url) })
    );
  }
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
    .prepare(`INSERT INTO card_enrollments (id, user_id, price_id, billing_email, status,
    payment_source_mode, contracts_json, disclosure_json, prepared_at_ms, expires_at_ms,
    accepted_at_ms, payment_request_id, wompi_candidate_source_id, method, wompi_environment,
    authorization_digest) VALUES (?, ?, ?, 'payer@example.test', 'creating', ?,
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
    .prepare(`INSERT INTO card_payment_sources (id, user_id, enrollment_id, wompi_source_id,
    billing_email, created_at_ms, method) VALUES (?, ?, ?, ?, 'payer@example.test', 300, ?)`)
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
    .prepare(`INSERT INTO billing_attempts (id, user_id, enrollment_id, payment_request_id,
    payment_source_id, price_id, amount, currency, billing_period, service_market,
    tax_treatment, time_zone, wompi_environment, wompi_reference, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, '9900', 'COP', 'weekly', 'CO', 'not-taxable',
    'America/Bogota', ?, ?, 400)`)
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
    .prepare("UPDATE card_enrollments SET status = 'available' WHERE id = ?")
    .bind(identity(2, index));
const user = (db: D1Database, index: number): D1PreparedStatement =>
  db
    .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)")
    .bind(identity(1, index));

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

// Rebuilds must retain dependent SQL authority, not merely today's seeded rows.
const retainedSchema = Effect.fnUntraced(function* (db: D1Database) {
  const schema = yield* Effect.tryPromise(() =>
    db
      .prepare(`SELECT type, name, tbl_name,
    coalesce(sql, '') AS sql FROM sqlite_schema
    WHERE name NOT LIKE '_cf_%' AND NOT (type = 'table' AND name IN
      ('card_enrollments', 'card_payment_sources')) ORDER BY type, name`)
      .all<{ type: string; name: string; tbl_name: string; sql: string }>()
  );
  return schema.results.map((row) => ({ ...row, sql: row.sql.replace(/\s+/gu, " ").trim() }));
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
        db.prepare("INSERT INTO payment_commit_guards VALUES ('atomic-probe', 1)"),
        ...statements,
      ])
    ).rejects.toThrow(reason)
  );
  expect(yield* retainedState(db)).toEqual(before);
});

it("preserves retained card and Nequi history while allowing a DaviPlata source and pending collection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* baseline();
      for (const [index, method] of [
        [1, "card"],
        [2, "nequi"],
      ] as const) {
        yield* Effect.tryPromise(() =>
          db.batch([
            user(db, index),
            db
              .prepare("INSERT INTO trial_periods VALUES (?, 0, 604800000)")
              .bind(identity(1, index)),
            db
              .prepare(`INSERT INTO onboarding_consent_records VALUES (?, ?,
              '{"disclosure":"retained"}', 'disclosure-message', 'decision-message', 0, 0)`)
              .bind(identity(6, index), identity(1, index)),
            db
              .prepare(`INSERT INTO pat_audit VALUES (?, ?, NULL, NULL,
              'subscription.standing', 'accepted', 400)`)
              .bind(identity(7, index), identity(1, index)),
            enrollment(db, index, {
              ...enrollmentSeed(index, method),
              environment: "production",
              digest: "a".repeat(64),
              historical: index === 1,
            }),
            source(db, index, method),
            available(db, index),
            attempt(db, index, {
              sourceIndex: index,
              userIndex: index,
              environment: index === 1 ? "sandbox" : "production",
            }),
            db
              .prepare(
                "UPDATE billing_collection_arms SET state = 'sent', sent_at_ms = 450 WHERE attempt_id = ?"
              )
              .bind(identity(4, index)),
            db
              .prepare(
                "UPDATE billing_collection_outbox SET last_attempt_at_ms = 460, published_at_ms = 470 WHERE attempt_id = ?"
              )
              .bind(identity(4, index)),
            db
              .prepare(
                "INSERT INTO billing_transaction_evidence VALUES (?, ?, 'APPROVED', 500, NULL, 500)"
              )
              .bind(`transaction-${index}`, identity(4, index)),
            db
              .prepare(
                "UPDATE billing_attempts SET status = 'succeeded', finalized_at_ms = 500 WHERE id = ?"
              )
              .bind(identity(4, index)),
            db
              .prepare("INSERT INTO billing_paid_periods VALUES (?, 500, 604800500, 500)")
              .bind(identity(4, index)),
            db
              .prepare("INSERT INTO subscriptions VALUES (?, ?, ?, 604800500, 500)")
              .bind(identity(1, index), identity(4, index), priceId),
            db
              .prepare("INSERT INTO billing_audit VALUES (?, 'succeeded', 500)")
              .bind(identity(4, index)),
            db
              .prepare("INSERT INTO billing_followup_outbox VALUES (?, 'renewal_due', 604800500)")
              .bind(identity(4, index)),
          ])
        );
      }
      const before = yield* retainedState(db);
      const schemaBefore = yield* retainedSchema(db);
      yield* Effect.tryPromise(() => migration(db));
      expect(yield* retainedState(db)).toEqual(before);
      expect(yield* retainedSchema(db)).toEqual(schemaBefore);
      expect(yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_keys").first())).toEqual({
        foreign_keys: 1,
      });
      expect(
        yield* Effect.tryPromise(() => db.prepare("PRAGMA defer_foreign_keys").first())
      ).toEqual({ defer_foreign_keys: 0 });
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
      yield* Effect.tryPromise(() =>
        db.batch([
          user(db, 3),
          enrollment(db, 3, enrollmentSeed(3, "daviplata")),
          source(db, 3, "daviplata"),
          available(db, 3),
          attempt(db, 3),
          enrollment(db, 4, { ...enrollmentSeed(4, "card"), userIndex: 1, sourceMode: "reuse" }),
          available(db, 4),
          attempt(db, 4, { userIndex: 1, sourceIndex: 1, environment: "sandbox" }),
          enrollment(db, 5, {
            ...enrollmentSeed(5, "nequi"),
            userIndex: 2,
            environment: "production",
            sourceMode: "reuse",
          }),
          available(db, 5),
          attempt(db, 5, { userIndex: 2, sourceIndex: 2, environment: "production" }),
        ])
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT status FROM billing_attempts WHERE id = ?")
            .bind(identity(4, 3))
            .first()
        )
      ).toEqual({ status: "pending" });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state FROM billing_collection_arms WHERE attempt_id = ?")
            .bind(identity(4, 3))
            .first()
        )
      ).toEqual({ state: "armed" });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT version, published_at_ms FROM billing_collection_outbox WHERE attempt_id = ?"
            )
            .bind(identity(4, 3))
            .first()
        )
      ).toEqual({ version: 1, published_at_ms: null });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM billing_paid_periods").first()
        )
      ).toEqual({ count: 2 });
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare("UPDATE billing_paid_periods SET ends_at_ms = 999999999 WHERE attempt_id = ?")
            .bind(identity(4, 1)),
        ],
        "billing_paid_period_immutable"
      );
      yield* rejectsAtomically(
        db,
        [db.prepare("DELETE FROM billing_paid_periods WHERE attempt_id = ?").bind(identity(4, 2))],
        "billing_paid_period_immutable"
      );
      yield* rejectsAtomically(
        db,
        [
          db.prepare(
            "UPDATE billing_transaction_evidence SET status = 'DECLINED' WHERE transaction_id = 'transaction-1'"
          ),
        ],
        "billing_evidence_approval_immutable"
      );
      yield* rejectsAtomically(
        db,
        [db.prepare("UPDATE pat_audit SET outcome = 'rejected'")],
        "audit_append_only"
      );
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
  ));

it("rolls back guard removal and retained authority when the forward migration cannot complete", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* baseline();
      yield* Effect.tryPromise(() =>
        db.batch([
          user(db, 1),
          enrollment(db, 1, enrollmentSeed(1, "nequi")),
          source(db, 1, "nequi"),
          available(db, 1),
          attempt(db, 1),
          db.prepare("CREATE TABLE card_payment_sources_daviplata (id TEXT PRIMARY KEY) STRICT"),
        ])
      );
      const before = yield* retainedState(db);
      const schemaBefore = yield* retainedSchema(db);
      yield* Effect.tryPromise(() => expect(migration(db)).rejects.toThrow("already exists"));
      expect(yield* retainedState(db)).toEqual(before);
      expect(yield* retainedSchema(db)).toEqual(schemaBefore);
      yield* rejectsAtomically(
        db,
        [db.prepare("UPDATE card_payment_sources SET method = 'card'")],
        "card_source_immutable"
      );
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
    })
  ));

it("rejects invalid methods, unclaimed or mismatched sources and authorization replay without partial writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* baseline();
      yield* Effect.tryPromise(() => migration(db));
      yield* Effect.tryPromise(() =>
        db.batch([
          user(db, 1),
          enrollment(db, 1, enrollmentSeed(1, "card")),
          source(db, 1, "card"),
          available(db, 1),
          user(db, 2),
          enrollment(db, 2, enrollmentSeed(2, "nequi")),
          source(db, 2, "nequi"),
          available(db, 2),
          user(db, 3),
          enrollment(db, 3, enrollmentSeed(3, "daviplata")),
          user(db, 4),
        ])
      );
      yield* rejectsAtomically(
        db,
        [enrollment(db, 4, { ...enrollmentSeed(4, "daviplata"), userIndex: 9 })],
        "FOREIGN KEY constraint failed"
      );
      yield* rejectsAtomically(
        db,
        [enrollment(db, 4, enrollmentSeed(4, "cash"))],
        "CHECK constraint failed"
      );
      yield* rejectsAtomically(db, [source(db, 3, "cash")], "payment_source_method_mismatch");
      yield* rejectsAtomically(db, [source(db, 3, "nequi")], "payment_source_method_mismatch");
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare("UPDATE card_enrollments SET status = 'refused' WHERE id = ?")
            .bind(identity(2, 3)),
          source(db, 3, "daviplata"),
        ],
        "card_source_invalid_claim"
      );
      yield* rejectsAtomically(
        db,
        [
          enrollment(db, 4, { ...enrollmentSeed(4, "daviplata"), historical: true }),
          source(db, 4, "daviplata"),
        ],
        "payment_source_method_mismatch"
      );
      yield* rejectsAtomically(
        db,
        [
          enrollment(db, 4, {
            ...enrollmentSeed(4, "daviplata"),
            digest: enrollmentSeed(2, "nequi").digest,
          }),
        ],
        "UNIQUE constraint failed: card_enrollments.authorization_digest"
      );
      yield* Effect.tryPromise(() => db.batch([source(db, 3, "daviplata"), available(db, 3)]));
      yield* rejectsAtomically(
        db,
        [
          enrollment(db, 4, { ...enrollmentSeed(4, "daviplata"), userIndex: 3 }),
          db
            .prepare(
              `INSERT INTO card_payment_sources VALUES (?, ?, ?, 4, 'payer@example.test', 300, 'daviplata')`
            )
            .bind(identity(3, 4), identity(1, 3), identity(2, 4)),
        ],
        "UNIQUE constraint failed: card_payment_sources.user_id"
      );
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare("UPDATE card_enrollments SET wompi_candidate_source_id = NULL WHERE id = ?")
            .bind(identity(2, 1)),
          enrollment(db, 4, enrollmentSeed(4, "daviplata")),
          db
            .prepare("UPDATE card_enrollments SET wompi_candidate_source_id = 1 WHERE id = ?")
            .bind(identity(2, 4)),
          db
            .prepare(
              `INSERT INTO card_payment_sources VALUES (?, ?, ?, 1, 'payer@example.test', 300, 'daviplata')`
            )
            .bind(identity(3, 4), identity(1, 4), identity(2, 4)),
        ],
        "UNIQUE constraint failed: card_payment_sources.wompi_source_id"
      );
      yield* rejectsAtomically(
        db,
        [
          enrollment(db, 4, enrollmentSeed(4, "daviplata")),
          db
            .prepare(
              `INSERT INTO card_payment_sources VALUES (?, ?, ?, 4, 'payer@example.test', 300, 'daviplata')`
            )
            .bind(identity(3, 1), identity(1, 4), identity(2, 4)),
        ],
        "UNIQUE constraint failed: card_payment_sources.id"
      );
      for (const field of [
        "method = 'card'",
        "wompi_environment = 'production'",
        "authorization_digest = NULL",
      ]) {
        yield* rejectsAtomically(
          db,
          [db.prepare(`UPDATE card_enrollments SET ${field} WHERE id = ?`).bind(identity(2, 3))],
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
          [db.prepare(`UPDATE card_enrollments SET ${field} WHERE id = ?`).bind(identity(2, 3))],
          "card_enrollment_evidence_immutable"
        );
      }
      yield* rejectsAtomically(
        db,
        [
          db
            .prepare("UPDATE card_payment_sources SET method = 'card' WHERE id = ?")
            .bind(identity(3, 3)),
        ],
        "card_source_immutable"
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
      yield* Effect.tryPromise(() => migration(db));
      yield* Effect.tryPromise(() =>
        db.batch([
          user(db, 1),
          enrollment(db, 1, enrollmentSeed(1, "card")),
          source(db, 1, "card"),
          available(db, 1),
          user(db, 3),
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
            .prepare("UPDATE card_enrollments SET status = 'verifying' WHERE id = ?")
            .bind(identity(2, 3)),
          attempt(db, 3),
        ],
        "billing_attempt_invalid_claim"
      );
      yield* Effect.tryPromise(() => db.batch([attempt(db, 1), attempt(db, 3)]));
      yield* rejectsAtomically(db, [attempt(db, 3)], "billing_user_collection_unresolved");
      yield* rejectsAtomically(
        db,
        [db.prepare("UPDATE billing_attempts SET amount = '1' WHERE id = ?").bind(identity(4, 3))],
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
