import { afterAll, expect, it } from "vitest";
import { Data, Effect } from "effect";
import { isolatedTestDatabases } from "../../d1-test-fixture";

class MigrationTestFailure extends Data.TaggedError("MigrationTestFailure") {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: () => new MigrationTestFailure() }).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const migrationName = "0011_transaction_group_audit.sql";
const directory = new URL("../../migrations/", import.meta.url);
const statements = (source: string): ReadonlyArray<string> =>
  source
    .split("--> statement-breakpoint")
    .map((sql) => sql.trim())
    .filter((sql) => sql.length > 0 && !sql.startsWith("PRAGMA "));
const migration = native(() => Bun.file(new URL(migrationName, directory)).text()).pipe(
  Effect.map(statements)
);
const user = "10000000-0000-4000-8000-000000000501";
const session = "10000000-0000-4000-8000-000000000502";
const originalId = "10000000-0000-4000-8000-000000000503";
const groupId = "10000000-0000-4000-8000-000000000504";
const auditInsert =
  "INSERT INTO audit_entries(record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES('session_call',?,?,?,?,'success',1)";
const previousDatabase = Effect.gen(function* () {
  const db = yield* native(() => databases.acquire());
  const names = Array.from(new Bun.Glob("*.sql").scanSync({ cwd: directory.pathname }))
    .sort()
    .filter((name) => name < migrationName);
  const sources = yield* native(() =>
    Promise.all(names.map((name) => Bun.file(new URL(name, directory)).text()))
  );
  yield* native(() => db.batch(sources.flatMap(statements).map((sql) => db.prepare(sql))));
  yield* native(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
        )
        .bind(user),
      db
        .prepare(
          "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,'ABCD-1234',zeroblob(32),?,'consumed',1,600001)"
        )
        .bind(session, user),
      db
        .prepare(
          "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,zeroblob(32),1,600001,3600001,7776000001)"
        )
        .bind(session, session, user),
      db.prepare(auditInsert).bind(originalId, user, session, "transactions.updateTransaction"),
      db
        .prepare(
          "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,occurred_at_ms) VALUES(400,'identity_read','expired-read',?,?,1)"
        )
        .bind(user, session),
      db.prepare("DELETE FROM audit_entries WHERE record_type='identity_read'"),
    ])
  );
  return db;
});
it("upgrades populated Audit history without losing records, sequence, indexes or append-only guards", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* previousDatabase;
      const before = yield* native(() => db.prepare("SELECT * FROM audit_entries").all());
      const objects = yield* native(() =>
        db
          .prepare(
            "SELECT type,name FROM sqlite_schema WHERE tbl_name='audit_entries' ORDER BY type,name"
          )
          .all()
      );
      expect(
        (yield* Effect.exit(
          native(() =>
            db
              .prepare(auditInsert)
              .bind(groupId, user, session, "transactions.updateTransactions")
              .run()
          )
        ))._tag
      ).toBe("Failure");
      const sql = yield* migration;
      yield* native(() => db.batch(sql.map((statement) => db.prepare(statement))));
      expect(
        (yield* native(() => db.prepare("SELECT * FROM audit_entries").all())).results
      ).toEqual(before.results);
      expect(
        (yield* native(() =>
          db
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE tbl_name='audit_entries' ORDER BY type,name"
            )
            .all()
        )).results
      ).toEqual(objects.results);
      yield* native(() =>
        db
          .prepare(auditInsert)
          .bind(groupId, user, session, "transactions.updateTransactions")
          .run()
      );
      expect(
        yield* native(() =>
          db
            .prepare("SELECT sequence FROM audit_entries WHERE id=?")
            .bind(groupId)
            .first("sequence")
        )
      ).toBe(401);
      for (const mutation of [
        "UPDATE audit_entries SET outcome='validation_failed' WHERE id=?",
        "DELETE FROM audit_entries WHERE id=?",
      ]) {
        expect(
          (yield* Effect.exit(native(() => db.prepare(mutation).bind(originalId).run())))._tag
        ).toBe("Failure");
      }
      expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
        []
      );
    })
  ));
it("refuses an oversized Audit rebuild before changing schema or retained history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* previousDatabase;
      yield* native(() =>
        db
          .prepare(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO audit_entries(record_type,id,user_id,session_id,occurred_at_ms) SELECT 'identity_read',printf('read-%d',i),?,?,1 FROM n"
          )
          .bind(user, session)
          .run()
      );
      const sql = yield* migration;
      expect(
        (yield* Effect.exit(native(() => db.batch(sql.map((statement) => db.prepare(statement))))))
          ._tag
      ).toBe("Failure");
      expect(
        yield* native(() => db.prepare("SELECT count(*) FROM audit_entries").first("count(*)"))
      ).toBe(10001);
      expect(
        yield* native(() =>
          db
            .prepare(
              "SELECT count(*) FROM sqlite_schema WHERE name='audit_entries_before_group_corrections'"
            )
            .first("count(*)")
        )
      ).toBe(0);
    })
  ));
