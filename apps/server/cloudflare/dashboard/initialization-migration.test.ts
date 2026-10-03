import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, expect } from "vitest";
import { applyTestMigration, isolatedTestDatabases } from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const current = Date.UTC(2026, 8, 30);
const migrationName = "0030_dashboard_initialization.sql";
const wait = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);
const migrate = (db: D1Database, name: string): Effect.Effect<void> =>
  wait(() => applyTestMigration({ db, source: new URL(`../migrations/${name}`, import.meta.url) }));

const setup = (): Effect.Effect<D1Database> =>
  Effect.gen(function* () {
    const db = yield* wait(() => databases.acquire());
    const names = Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
    )
      .filter((name) => name < migrationName)
      .sort();
    for (const name of names) yield* migrate(db, name);
    yield* wait(() =>
      db.batch(
        [userId, otherUserId].map((id) =>
          db
            .prepare(
              "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
            )
            .bind(id, current)
        )
      )
    );
    return db;
  });

type AuditFixture = Readonly<{
  id: string;
  user: string;
  operation: string;
  outcome: string;
  occurredAt: number;
}>;

const insertAudit = (
  db: D1Database,
  {
    id,
    user = userId,
    operation = "dashboard.initializeDashboard",
    outcome = "accepted",
    occurredAt = current,
  }: Pick<AuditFixture, "id"> & Partial<Omit<AuditFixture, "id">>
): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO dashboard_audit (id, user_id, session_id, operation, outcome, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(id, user, `session-${user}`, operation, outcome, occurredAt);

it.live("preserves Dashboard history and documents while admitting initialization evidence", () =>
  Effect.gen(function* () {
    const db = yield* setup();
    yield* wait(() =>
      db.batch([
        insertAudit(db, { id: "read", operation: "dashboard.getDashboard" }),
        insertAudit(db, { id: "view", operation: "dashboard.getDashboardView" }),
        insertAudit(db, {
          id: "catalog",
          user: otherUserId,
          operation: "dashboard.listDashboardCatalog",
        }),
        insertAudit(db, {
          id: "edit",
          operation: "dashboard.applyDashboardEdit",
          outcome: "rejected",
        }),
        db
          .prepare("INSERT INTO dashboard_documents VALUES (?, ?, 7)")
          .bind(userId, '{"retained":"exact document bytes"}'),
      ])
    );
    const before = yield* wait(() => db.prepare("SELECT * FROM dashboard_audit ORDER BY id").all());
    yield* wait(() =>
      expect(insertAudit(db, { id: "initialization" }).run()).rejects.toThrow("CHECK constraint")
    );

    yield* migrate(db, migrationName);

    expect(
      (yield* wait(() => db.prepare("SELECT * FROM dashboard_audit ORDER BY id").all())).results
    ).toEqual(before.results);
    expect(yield* wait(() => db.prepare("SELECT * FROM dashboard_documents").first())).toEqual({
      user_id: userId,
      document_json: '{"retained":"exact document bytes"}',
      revision: 7,
    });
    yield* wait(() => insertAudit(db, { id: "initialization" }).run());
    expect(
      yield* wait(() =>
        db
          .prepare("SELECT operation, outcome FROM dashboard_audit WHERE id = 'initialization'")
          .first()
      )
    ).toEqual({ operation: "dashboard.initializeDashboard", outcome: "accepted" });
    expect(
      (yield* wait(() =>
        db
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'dashboard_audit' AND sql IS NOT NULL ORDER BY name"
          )
          .all()
      )).results
    ).toEqual([
      {
        sql: "CREATE INDEX dashboard_audit_by_user_day ON dashboard_audit(user_id, occurred_at_ms)",
      },
      {
        sql: "CREATE INDEX dashboard_audit_retention ON dashboard_audit(occurred_at_ms, id, user_id)",
      },
    ]);
    for (const invalid of [
      { id: "unknown-operation", operation: "dashboard.unknown" },
      { id: "unknown-outcome", outcome: "unknown" },
      { id: "unknown-user", user: "unknown" },
      { id: "initialization" },
    ]) {
      yield* wait(() => expect(insertAudit(db, invalid).run()).rejects.toThrow());
    }
    expect(
      yield* wait(() => db.prepare("SELECT COUNT(*) AS count FROM dashboard_audit").first())
    ).toEqual({ count: 5 });
    expect((yield* wait(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
  })
);

it.live(
  "keeps Dashboard evidence immutable and retention scoped to one User before the cutoff",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      yield* wait(() =>
        db.batch([
          insertAudit(db, {
            id: "expired",
            operation: "dashboard.getDashboard",
            occurredAt: current - 1,
          }),
          insertAudit(db, { id: "boundary", operation: "dashboard.getDashboard" }),
          insertAudit(db, {
            id: "other-expired",
            user: otherUserId,
            operation: "dashboard.getDashboard",
            occurredAt: current - 1,
          }),
        ])
      );
      yield* migrate(db, migrationName);
      yield* wait(() => insertAudit(db, { id: "initialized" }).run());
      const before = yield* wait(() =>
        db.prepare("SELECT * FROM dashboard_audit ORDER BY id").all()
      );
      for (const sql of [
        "UPDATE dashboard_audit SET outcome = 'rejected' WHERE id = 'expired'",
        "UPDATE dashboard_audit SET outcome = 'rejected' WHERE id = 'initialized'",
        "DELETE FROM dashboard_audit WHERE id = 'expired'",
        "DELETE FROM dashboard_audit WHERE id = 'initialized'",
      ]) {
        yield* wait(() => expect(db.prepare(sql).run()).rejects.toThrow("audit_append_only"));
      }
      for (const sql of [
        "DELETE FROM dashboard_audit WHERE user_id = ?",
        "DELETE FROM dashboard_audit WHERE user_id != ?",
        "UPDATE dashboard_audit SET outcome = 'rejected' WHERE user_id = ?",
      ]) {
        yield* wait(() =>
          expect(
            db.batch([
              db.prepare("INSERT INTO audit_retention_permits VALUES (?, ?)").bind(userId, current),
              db.prepare(sql).bind(userId),
              db.prepare("DELETE FROM audit_retention_permits WHERE user_id = ?").bind(userId),
            ])
          ).rejects.toThrow("audit_append_only")
        );
        expect(
          (yield* wait(() => db.prepare("SELECT * FROM dashboard_audit ORDER BY id").all())).results
        ).toEqual(before.results);
        expect(
          (yield* wait(() => db.prepare("SELECT * FROM audit_retention_permits").all())).results
        ).toEqual([]);
      }
      yield* wait(() =>
        db.batch([
          db.prepare("INSERT INTO audit_retention_permits VALUES (?, ?)").bind(userId, current),
          db
            .prepare("DELETE FROM dashboard_audit WHERE user_id = ? AND occurred_at_ms < ?")
            .bind(userId, current),
          db.prepare("DELETE FROM audit_retention_permits WHERE user_id = ?").bind(userId),
        ])
      );
      expect(
        (yield* wait(() => db.prepare("SELECT id FROM dashboard_audit ORDER BY id").all())).results
      ).toEqual([{ id: "boundary" }, { id: "initialized" }, { id: "other-expired" }]);
      expect(
        (yield* wait(() => db.prepare("SELECT * FROM audit_retention_permits").all())).results
      ).toEqual([]);
      yield* wait(() =>
        expect(
          db.prepare("DELETE FROM dashboard_audit WHERE id = 'other-expired'").run()
        ).rejects.toThrow("audit_append_only")
      );
    })
);

it.live(
  "preserves a full Dashboard daily budget without charging another User or the next day",
  () =>
    Effect.gen(function* () {
      const db = yield* setup();
      yield* wait(() =>
        db.batch(
          Array.from({ length: 256 }, (_, index) =>
            insertAudit(db, { id: `retained-${index}`, operation: "dashboard.getDashboard" })
          )
        )
      );
      yield* migrate(db, migrationName);
      for (const occurredAt of [current, current + 86_400_000 - 1]) {
        yield* wait(() =>
          expect(
            insertAudit(db, { id: `over-budget-${occurredAt}`, occurredAt }).run()
          ).rejects.toThrow("transaction_audit_limit")
        );
      }
      expect(
        yield* wait(() => db.prepare("SELECT COUNT(*) AS count FROM dashboard_audit").first())
      ).toEqual({ count: 256 });
      yield* wait(() =>
        db.batch([
          insertAudit(db, { id: "next-day", occurredAt: current + 86_400_000 }),
          insertAudit(db, { id: "other-user", user: otherUserId }),
        ])
      );
      expect(
        (yield* wait(() =>
          db
            .prepare(
              "SELECT user_id, occurred_at_ms, COUNT(*) AS count FROM dashboard_audit GROUP BY user_id, occurred_at_ms ORDER BY user_id, occurred_at_ms"
            )
            .all()
        )).results
      ).toEqual([
        { user_id: userId, occurred_at_ms: current, count: 256 },
        { user_id: userId, occurred_at_ms: current + 86_400_000, count: 1 },
        { user_id: otherUserId, occurred_at_ms: current, count: 1 },
      ]);
    })
);
