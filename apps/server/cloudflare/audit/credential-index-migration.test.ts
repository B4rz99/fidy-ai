import { afterAll, expect, it } from "vitest";
import { Data, Effect } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const user = "10000000-0000-4000-8000-000000000001";
const session = "20000000-0000-4000-8000-000000000001";
const migration = (
  await Bun.file(new URL("../migrations/0011_audit_credential_indexes.sql", import.meta.url)).text()
)
  .split("--> statement-breakpoint")
  .map((sql) => sql.trim());

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ readonly cause: unknown }> {}
const attempt = <A>(work: () => Promise<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({ try: work, catch: (cause) => new FixtureFailure({ cause }) });

const fixture = (): Effect.Effect<D1Database, FixtureFailure> =>
  Effect.gen(function* () {
    const db = yield* attempt(() => databases.acquire());
    yield* attempt(() => installTestSchema({ db }));
    yield* attempt(() =>
      db.batch([
        db.prepare("DROP INDEX audit_entries_oauth_activity"),
        db.prepare("DROP INDEX audit_entries_pat_activity"),
        db.prepare(
          "CREATE INDEX audit_entries_oauth_activity ON audit_entries(user_id,oauth_connection_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call'"
        ),
        db.prepare(
          "CREATE INDEX audit_entries_pat_activity ON audit_entries(user_id,pat_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call'"
        ),
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
          )
          .bind(user),
        db
          .prepare(
            "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,'ABC-DEF12',zeroblob(32),?,'consumed',1,600001)"
          )
          .bind(session, user),
        db
          .prepare(
            "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES(?,?,?,zeroblob(32),1,600001,86400001,7776000001)"
          )
          .bind(session, session, user),
        db
          .prepare(
            "INSERT INTO pats(id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) VALUES('pat-proof',?,'proof001',zeroblob(32),'Synthetic','[\"read\"]',7,1,1,1000,'pat-request')"
          )
          .bind(user),
        db
          .prepare(
            "INSERT INTO oauth_connections(id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms) VALUES('connection-proof','connection-request',?,'client-proof','Synthetic','https://fixture.invalid/callback','https://api.fidyapp.com/mcp','[\"read\"]',1,1000)"
          )
          .bind(user),
        db
          .prepare(
            "INSERT INTO oauth_credentials(kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms) VALUES('access','access-proof','connection-proof',?,zeroblob(32),1,1000)"
          )
          .bind(user),
      ])
    );
    return db;
  });

const seed = (
  db: D1Database,
  counts: Readonly<{ total: number; pats: number; oauth: number }>
): Effect.Effect<D1Result, FixtureFailure> =>
  attempt(() =>
    db
      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1)
    INSERT INTO audit_entries(record_type,id,user_id,session_id,pat_id,oauth_connection_id,oauth_credential_id,operation,outcome,occurred_at_ms)
    SELECT 'credential_call',printf('30000000-0000-4000-8000-%012d',i),?2,
      CASE WHEN i>?3+?4 THEN ?5 END,CASE WHEN i<=?3 THEN 'pat-proof' END,
      CASE WHEN i>?3 AND i<=?3+?4 THEN 'connection-proof' END,
      CASE WHEN i>?3 AND i<=?3+?4 THEN 'access-proof' END,
      'recurringPlans.listRecurringPlans','accepted',i FROM n`)
      .bind(counts.total, user, counts.pats, counts.oauth, session)
      .run()
  );

const snapshot = (db: D1Database): Effect.Effect<string, FixtureFailure> =>
  attempt(() => db.prepare("SELECT * FROM audit_entries ORDER BY sequence").all()).pipe(
    Effect.map((rows) =>
      new Bun.CryptoHasher("sha256").update(JSON.stringify(rows.results)).digest("hex")
    )
  );
const indexDefinitions = (
  db: D1Database
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, FixtureFailure> =>
  attempt(() =>
    db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE name IN ('audit_entries_oauth_activity','audit_entries_pat_activity') ORDER BY name"
      )
      .all()
  ).pipe(Effect.map((rows) => rows.results));
const apply = (db: D1Database): Effect.Effect<ReadonlyArray<D1Result>, FixtureFailure> =>
  attempt(() => db.batch(migration.map((sql) => db.prepare(sql))));

const fillSchema = (db: D1Database, maximum: number): Effect.Effect<void, FixtureFailure> =>
  Effect.gen(function* () {
    const count = yield* attempt(() =>
      db.prepare("SELECT count(*) AS n FROM sqlite_schema").first<{ n: number }>()
    );
    if (count === null || count.n > maximum) {
      return yield* new FixtureFailure({ cause: "Invalid schema fixture size" });
    }
    yield* attempt(() =>
      db.batch(
        Array.from({ length: maximum - count.n }, (_, index) =>
          db.prepare(`CREATE TABLE credential_index_bound_${index}(value INTEGER) STRICT`)
        )
      )
    );
  });

it("replaces only activity indexes within the admitted native D1 budget and preserves complete Audit history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      yield* seed(db, { total: 25000, pats: 2000, oauth: 2000 });
      yield* fillSchema(db, 2048);
      const before = yield* snapshot(db);
      const result = yield* apply(db);
      expect(yield* snapshot(db)).toBe(before);
      expect(result.reduce((sum, row) => sum + row.meta.rows_read, 0)).toBeLessThanOrEqual(100000);
      expect(result.reduce((sum, row) => sum + row.meta.rows_written, 0)).toBeLessThanOrEqual(5000);
      for (const [column, index, value] of [
        ["pat_id", "audit_entries_pat_activity", "pat-proof"],
        ["oauth_connection_id", "audit_entries_oauth_activity", "connection-proof"],
      ] as const) {
        const query = `SELECT id FROM audit_entries INDEXED BY ${index} WHERE record_type='credential_call' AND user_id=? AND ${column}=? ORDER BY occurred_at_ms DESC,id DESC LIMIT 3`;
        const selected = yield* attempt(() => db.prepare(query).bind(user, value).all());
        expect(selected.results).toHaveLength(3);
        expect(selected.meta.rows_read).toBeLessThanOrEqual(6);
        const plan = yield* attempt(() =>
          db.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(user, value).all<{ detail: string }>()
        );
        expect(plan.results.map((row) => row.detail).join("\n")).not.toContain("TEMP B-TREE");
      }
    })
  ));

it.each([
  { total: 25001, pats: 0, oauth: 0 },
  { total: 2001, pats: 2001, oauth: 0 },
  { total: 2001, pats: 0, oauth: 2001 },
])("refuses an oversized history or destination before changing indexes: %j", (counts) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      yield* seed(db, counts);
      const before = yield* snapshot(db),
        indexes = yield* indexDefinitions(db);
      expect((yield* Effect.exit(apply(db)))._tag).toBe("Failure");
      expect(yield* snapshot(db)).toBe(before);
      expect(yield* indexDefinitions(db)).toEqual(indexes);
    })
  )
);

it("refuses an oversized schema before replacing either activity index", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fixture();
      yield* fillSchema(db, 2049);
      const before = yield* indexDefinitions(db);
      expect((yield* Effect.exit(apply(db)))._tag).toBe("Failure");
      expect(yield* indexDefinitions(db)).toEqual(before);
    })
  ));
