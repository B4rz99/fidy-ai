import { afterAll, expect, it } from "vitest";
import { Data, Effect, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import {
  documentedSqlBlock,
  installHistoricalErasureChunk,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { makeOauthAgentsErasureStores } from "./runtime";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new FixtureFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const owner = "14460000-0000-4000-8000-000000000001";
const foreign = "14460000-0000-4000-8000-000000000002";
const request = "14460000-0000-4000-8000-000000000003";
const onReplacedTable = (sql: string): boolean =>
  /^CREATE (?:UNIQUE )?(?:TRIGGER|INDEX) .*?\bON "?(?:audit_entries|oauth_credentials)\b/su.test(
    sql
  );
const snapshot = (db: D1Database): Promise<ReadonlyArray<unknown>> =>
  db
    .batch([
      db.prepare("SELECT rowid,* FROM oauth_credentials ORDER BY rowid"),
      db.prepare("SELECT * FROM audit_entries ORDER BY sequence"),
      db.prepare("SELECT * FROM erasure_archives"),
      db.prepare("SELECT * FROM sqlite_schema ORDER BY name"),
      db.prepare("SELECT * FROM sqlite_sequence ORDER BY name"),
    ])
    .then((rows) => rows.map((row) => row.results));
const failures = [
  { name: "complete", sql: "", fails: false },
  {
    name: "empty activity history",
    sql: "DELETE FROM audit_entries WHERE record_type='credential_call'",
    fails: false,
  },
  {
    name: "different consumption time",
    sql: "UPDATE oauth_credentials SET consumed_at_ms=201 WHERE id='old'",
    fails: true,
  },
  {
    name: "different successor issue time",
    sql: "UPDATE oauth_credentials SET issued_at_ms=201 WHERE id='next'",
    fails: true,
  },
  {
    name: "different User",
    sql: `UPDATE oauth_credentials SET user_id='${foreign}' WHERE id='next'`,
    fails: true,
  },
  {
    name: "different connection",
    sql: "UPDATE oauth_credentials SET connection_id='foreign' WHERE id='next'",
    fails: true,
  },
  {
    name: "wider successor scopes",
    sql: `UPDATE oauth_credentials SET scopes_json='["read","write"]' WHERE id='next'`,
    fails: true,
  },
  {
    name: "missing rotation evidence",
    sql: "DELETE FROM audit_entries WHERE record_type='oauth_refresh' AND sequence=22",
    fails: true,
  },
  {
    name: "unexpected incoming dependency",
    sql: "CREATE TABLE sqlitex_lineage_dependency(id TEXT REFERENCES oauth_credentials(refresh_id))",
    fails: true,
  },
  { name: "interrupted replacement", sql: "", fails: true },
];

it.each(failures)("preserves populated OAuth lineage and rolls back $name", (fixture) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() => installHistoricalErasureChunk(db));
      const baseline = schemaStatements(
        yield* native(() =>
          Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
        )
      );
      const source = schemaStatements(
        yield* native(() =>
          Bun.file(new URL("./lineage-before-1446.fixture.sql", import.meta.url)).text()
        )
      ).map((sql) => sql.replaceAll("FROM billing_attempts", "FROM billing_attempt_context"));
      yield* native(() =>
        db.batch(
          [
            "PRAGMA defer_foreign_keys=ON",
            "DROP TABLE audit_entries",
            "DROP TABLE oauth_credentials",
            ...source,
          ].map((sql) => db.prepare(sql))
        )
      );
      yield* native(() =>
        db.batch([
          ...[owner, foreign].map((id) =>
            db
              .prepare(
                "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
              )
              .bind(id)
          ),
          ...["grant", "foreign"].map((id, index) =>
            db
              .prepare(
                "INSERT INTO oauth_connections(id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms,refresh_allowed) VALUES(?,?,?,'client','Unverified','https://example.com/callback','https://api.fidyapp.com/mcp','[\"read\",\"write\"]',1,10000,1)"
              )
              .bind(id, id, index === 0 ? owner : foreign)
          ),
          db
            .prepare(
              "INSERT INTO oauth_credentials(rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,scopes_json) VALUES(10,'refresh','old','grant',?,randomblob(32),100,9000,200,'[\"read\"]')"
            )
            .bind(owner),
          db
            .prepare(
              "INSERT INTO oauth_credentials(rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,scopes_json) VALUES(11,'refresh','next','grant',?,randomblob(32),200,9000,300,'[\"read\"]')"
            )
            .bind(owner),
          db
            .prepare(
              "INSERT INTO oauth_credentials(rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES(12,'refresh','last','grant',?,randomblob(32),300,9000,'[\"read\"]')"
            )
            .bind(owner),
          db
            .prepare(
              "INSERT INTO oauth_credentials(rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES(13,'access','access','grant',?,randomblob(32),300,9000,'[\"read\"]')"
            )
            .bind(owner),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,refresh_connection_id,consumed_refresh_id,issued_refresh_id,occurred_at_ms) VALUES(21,'oauth_refresh','rotation-one',?,'grant','old','next',200)"
            )
            .bind(owner),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,refresh_connection_id,consumed_refresh_id,issued_refresh_id,occurred_at_ms) VALUES(22,'oauth_refresh','rotation-two',?,'grant','next','last',300)"
            )
            .bind(owner),
          db
            .prepare(
              "INSERT INTO audit_entries(sequence,record_type,id,user_id,operation,outcome,oauth_connection_id,oauth_credential_id,occurred_at_ms) VALUES(23,'credential_call','activity',?,'categories.listCategories','accepted','grant','access',301)"
            )
            .bind(owner),
          db
            .prepare(
              'INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,1,\'AwaitingReview\',\'{"dispositions":{"credentials":{"action":"Retain","retention":{"untilMs":4102444800000}}}}\')'
            )
            .bind(request, owner),
          db
            .prepare(
              "INSERT INTO erasure_steps(request_id,store_id,data_class) VALUES(?,'oauth_refresh_events','credentials')"
            )
            .bind(request),
          db
            .prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES(?,'oauth_refresh_events','initial:21','{}')"
            )
            .bind(request),
          db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='audit_entries'"),
        ])
      );
      if (fixture.sql.length > 0) {
        yield* native(() =>
          db.batch(
            [
              "DROP TRIGGER audit_entries_no_update",
              "DROP TRIGGER oauth_refresh_events_no_delete",
              ...(fixture.name === "empty activity history"
                ? ["DROP TRIGGER audit_entries_no_delete"]
                : []),
              fixture.sql,
            ].map((sql) => db.prepare(sql))
          )
        );
      }
      const before = yield* native(() => snapshot(db));
      const tables = yield* native(() =>
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name<>'_cf_METADATA'"
          )
          .all<{ name: string }>()
      );
      const names = yield* Schema.decodeEffect(
        Schema.Array(
          Schema.Struct({
            name: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
          })
        )
      )(tables.results);
      const guide = yield* native(() =>
        Bun.file(
          new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
        ).text()
      );
      const block = (marker: string): ReadonlyArray<string> =>
        documentedSqlBlock({ guide, marker: `oauth-lineage-${marker}` });
      const plan = [
        "PRAGMA defer_foreign_keys=ON",
        ...block("preflight"),
        ...names.flatMap((row) =>
          block("references").map((sql) => sql.replaceAll("__TABLE_NAME__", row.name))
        ),
        schemaDefinition({ source: baseline, target: "oauth_credentials" }).replaceAll(
          "oauth_credentials",
          "oauth_credentials_1446"
        ),
        schemaDefinition({ source: baseline, target: "audit_entries" })
          .replace('"audit_entries"', '"audit_entries_1446"')
          .replace("REFERENCES oauth_credentials(", "REFERENCES oauth_credentials_1446("),
        ...block("copy"),
        ...source
          .filter(
            (sql) =>
              sql.startsWith("CREATE TRIGGER") &&
              !(
                fixture.sql.length > 0 &&
                [
                  "audit_entries_no_update",
                  "oauth_refresh_events_no_delete",
                  ...(fixture.name === "empty activity history" ? ["audit_entries_no_delete"] : []),
                ].includes(schemaObjectName(sql))
              )
          )
          .map((sql) => `DROP TRIGGER ${schemaObjectName(sql)}`),
        ...block("replace"),
        ...baseline.filter(onReplacedTable),
        ...(fixture.name === "interrupted replacement"
          ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('interrupted',0)"]
          : []),
        ...block("verify"),
      ];
      const commit = (): Promise<ReadonlyArray<D1Result>> =>
        db.batch(plan.map((sql) => db.prepare(sql)));
      if (fixture.fails) {
        yield* native(() => expect(commit()).rejects.toThrow());
        expect(yield* native(() => snapshot(db))).toEqual(before);
        return;
      }
      yield* native(commit);
      expect(
        (yield* native(() =>
          db
            .prepare(
              "SELECT id,replacement_refresh_id,consumed_at_ms,refresh_event_id,refresh_event_row_ref FROM oauth_credentials WHERE kind='refresh' ORDER BY rowid"
            )
            .all()
        )).results
      ).toEqual([
        {
          id: "old",
          replacement_refresh_id: "next",
          consumed_at_ms: 200,
          refresh_event_id: "rotation-one",
          refresh_event_row_ref: "21",
        },
        {
          id: "next",
          replacement_refresh_id: "last",
          consumed_at_ms: 300,
          refresh_event_id: "rotation-two",
          refresh_event_row_ref: "22",
        },
        {
          id: "last",
          replacement_refresh_id: null,
          consumed_at_ms: null,
          refresh_event_id: null,
          refresh_event_row_ref: null,
        },
      ]);
      expect(
        (yield* native(() =>
          db.prepare("SELECT sequence,id,oauth_credential_id FROM audit_entries").all()
        )).results
      ).toEqual(
        fixture.name === "empty activity history"
          ? []
          : [{ sequence: 23, id: "activity", oauth_credential_id: "access" }]
      );
      expect(
        yield* native(() =>
          db.prepare("SELECT seq FROM sqlite_sequence WHERE name='audit_entries'").first("seq")
        )
      ).toBe(999);
      for (const sql of [
        "UPDATE oauth_credentials SET replacement_refresh_id='last' WHERE id='old'",
        "UPDATE oauth_credentials SET consumed_at_ms=NULL WHERE id='old'",
        "UPDATE oauth_credentials SET user_id='foreign' WHERE id='old'",
        "DELETE FROM oauth_credentials WHERE id='old'",
      ]) {
        yield* native(() => expect(db.prepare(sql).run()).rejects.toThrow());
      }
      yield* native(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO oauth_credentials(kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES('refresh','future','grant',?,randomblob(32),400,9000,'[\"read\"]')"
            )
            .bind(owner),
          db.prepare(
            "UPDATE oauth_credentials SET consumed_at_ms=400,replacement_refresh_id='future' WHERE id='last'"
          ),
        ])
      );
      yield* native(() =>
        db.prepare("UPDATE erasure_requests SET state='Archiving' WHERE id=?").bind(request).run()
      );
      const store = makeOauthAgentsErasureStores(db).find(
        (entry) => entry.id === "oauth_refresh_events"
      );
      if (store === undefined) throw Error("Missing lineage erasure projection");
      const scope = { userId: owner, reference: request };
      expect(yield* store.archive(scope)).toBe(true);
      expect(
        (yield* native(() =>
          db
            .prepare(
              "SELECT row_ref,body FROM erasure_archives WHERE request_id=? ORDER BY row_ref"
            )
            .bind(request)
            .all()
        )).results
      ).toEqual([
        { row_ref: "initial:21", body: "{}" },
        { row_ref: "initial:22", body: "{}" },
        { row_ref: "initial:credential:last", body: "{}" },
      ]);
      yield* native(() =>
        db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(request).run()
      );
      expect(
        (yield* Effect.result(store.remove({ userId: foreign, reference: request })))._tag
      ).toBe("Failure");
      expect(yield* store.remove(scope)).toBe(true);
      expect(yield* store.remove(scope)).toBe(true);
      expect(
        (yield* native(() =>
          db
            .prepare(
              "SELECT id,consumed_at_ms,replacement_refresh_id FROM oauth_credentials WHERE id IN('old','next') ORDER BY rowid"
            )
            .all()
        )).results
      ).toEqual([
        { id: "old", consumed_at_ms: 200, replacement_refresh_id: null },
        { id: "next", consumed_at_ms: 300, replacement_refresh_id: null },
      ]);
      expect((yield* native(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
        []
      );
    })
  )
);
