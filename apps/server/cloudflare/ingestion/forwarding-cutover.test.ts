import { Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const owner = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const unissued = "10000000-0000-4000-8000-000000000003";
const address = "20000000-0000-4000-8000-000000000001";
const local = "a".repeat(48);

it.each(["valid", "partial-address", "interrupted-copy", "interrupted-swap"] as const)(
  "preserves issued addresses, erasure references and User children or rolls back %s cutover",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* wait(() => databases.acquire());
        const current = schemaStatements(
          yield* wait(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({
          current,
          history: yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                originalDefinitions: Schema.Array(Schema.String),
                introducedNames: Schema.Array(Schema.String),
              })
            )
          )(
            yield* wait(() =>
              Bun.file(new URL("./forwarding-cutover.test-fixture.json", import.meta.url)).text()
            )
          ),
        });
        yield* wait(() => db.batch(previous.map((sql) => db.prepare(sql))));
        yield* wait(() =>
          db.batch([
            ...[owner, other, unissued].map((userId, index) =>
              db
                .prepare(
                  "INSERT INTO users(rowid,id,service_market,locale,time_zone,created_at_ms) VALUES(?,?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(17 + index, userId)
            ),
            db
              .prepare(
                "UPDATE users SET forwarding_address_id=?,forwarding_local_part=?,forwarding_issued_at_ms=1234567890123 WHERE id=?"
              )
              .bind(address, local, owner),
            db
              .prepare(
                "UPDATE users SET forwarding_address_id='20000000-0000-4000-8000-000000000002',forwarding_local_part=?,forwarding_issued_at_ms=1234567890124 WHERE id=?"
              )
              .bind("b".repeat(48), other),
            db
              .prepare(
                "INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES(?,'dashboard','{\"retained\":true}',2)"
              )
              .bind(owner),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','email_forwarding_addresses','initial:17','{\"original\":true}',1)"
            ),
          ])
        );
        if (history === "partial-address") {
          yield* wait(() =>
            db.batch([
              db.prepare("PRAGMA ignore_check_constraints=ON"),
              db.prepare("UPDATE users SET forwarding_local_part=NULL WHERE id=?").bind(owner),
              db.prepare("PRAGMA ignore_check_constraints=OFF"),
            ])
          );
        }
        const retained = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
            ...["users", "user_documents", "erasure_archives"].map((table) =>
              db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)
            ),
          ]);
        const before = (yield* wait(retained)).map((result) => result.results);
        const objects = yield* wait(() =>
          db
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE type IN('view','trigger','index') AND sql IS NOT NULL"
            )
            .all<{ type: string; name: string }>()
        );
        const guide = yield* wait(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const apply = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(
            [
              ...documentedSqlBlock({ guide, marker: "forwarding-address-preflight" }),
              schemaDefinition({ source: current, target: "forwarding_addresses" }),
              ...documentedSqlBlock({ guide, marker: "forwarding-address-copy" }),
              ...documentedSqlBlock({ guide, marker: "forwarding-address-copy-check" }),
              ...(history === "interrupted-copy"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...objects.results.map(
                (object) => `DROP ${object.type.toUpperCase()} "${object.name}"`
              ),
              ...documentedSqlBlock({ guide, marker: "forwarding-address-swap" }),
              ...(history === "interrupted-swap"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...current.filter((sql) => /^CREATE (?:UNIQUE )?(?:VIEW|TRIGGER|INDEX) /u.test(sql)),
              ...documentedSqlBlock({ guide, marker: "forwarding-address-verify" }),
            ].map((sql) => db.prepare(sql))
          );
        if (history !== "valid") {
          yield* wait(() =>
            expect(apply()).rejects.toThrow("CHECK constraint failed: accepted = 1")
          );
          expect((yield* wait(retained)).map((result) => result.results)).toEqual(before);
          return;
        }
        yield* wait(apply);
        expect(
          (yield* wait(() =>
            db.prepare("SELECT rowid,* FROM forwarding_addresses ORDER BY rowid").all()
          )).results
        ).toEqual([
          {
            rowid: 17,
            id: address,
            user_id: owner,
            local_part: local,
            issued_at_ms: 1234567890123,
          },
          {
            rowid: 18,
            id: "20000000-0000-4000-8000-000000000002",
            user_id: other,
            local_part: "b".repeat(48),
            issued_at_ms: 1234567890124,
          },
        ]);
        const grant = (id: string, userId: string, at: number): D1PreparedStatement =>
          db
            .prepare(
              "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant',?,?,'{}','disclosed','accepted',?,?)"
            )
            .bind(id, userId, at, at);
        yield* wait(() =>
          expect(
            db.batch([
              grant("90000000-0000-4000-8000-000000000001", unissued, 100),
              db.prepare("INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"),
            ])
          ).rejects.toThrow("CHECK constraint failed: accepted = 1")
        );
        expect(
          (yield* wait(() =>
            db.prepare("SELECT id FROM forwarding_addresses WHERE user_id=?").bind(unissued).all()
          )).results
        ).toEqual([]);
        expect(
          (yield* wait(() =>
            db.prepare("SELECT id FROM consent_history WHERE user_id=?").bind(unissued).all()
          )).results
        ).toEqual([]);
        yield* wait(() =>
          db.batch([
            grant("90000000-0000-4000-8000-000000000001", unissued, 100),
            grant("90000000-0000-4000-8000-000000000002", owner, 200),
          ])
        );
        const issued = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            id: Schema.String,
            local_part: Schema.String,
            issued_at_ms: Schema.Int,
          })
        )(
          yield* wait(() =>
            db
              .prepare(
                "SELECT id,local_part,issued_at_ms FROM forwarding_addresses WHERE user_id=?"
              )
              .bind(unissued)
              .first()
          )
        );
        expect(issued.id).toMatch(/^[a-f0-9-]{36}$/u);
        expect(issued.local_part).toMatch(/^[a-f0-9]{48}$/u);
        expect(issued.issued_at_ms).toBe(100);
        expect(
          yield* wait(() =>
            db
              .prepare(
                "SELECT id,local_part,issued_at_ms FROM forwarding_addresses WHERE user_id=?"
              )
              .bind(owner)
              .first()
          )
        ).toEqual({ id: address, local_part: local, issued_at_ms: 1234567890123 });
        const after = (yield* wait(retained)).map((result) => result.results);
        expect(after[2]).toEqual(before[2]);
        expect(after[3]).toEqual(before[3]);
        expect((yield* wait(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
        yield* wait(() =>
          expect(
            db
              .prepare("UPDATE forwarding_addresses SET local_part=? WHERE user_id=?")
              .bind(local, other)
              .run()
          ).rejects.toThrow("UNIQUE constraint failed")
        );
        yield* wait(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('own',?,1,'Erasing')"
              )
              .bind(owner),
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('foreign',?,1,'Erasing')"
              )
              .bind(other),
            db
              .prepare(
                "INSERT INTO erasure_permits(request_id,user_id,store_id) VALUES('foreign',?,'email_forwarding_addresses')"
              )
              .bind(other),
          ])
        );
        yield* wait(() =>
          expect(
            db.prepare("DELETE FROM forwarding_addresses WHERE user_id=?").bind(owner).run()
          ).rejects.toThrow("erasure_fenced")
        );
        yield* wait(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO erasure_permits(request_id,user_id,store_id) VALUES('own',?,'email_forwarding_addresses')"
              )
              .bind(owner),
            db.prepare("DELETE FROM forwarding_addresses WHERE user_id=? AND rowid=17").bind(owner),
          ])
        );
        expect(
          (yield* wait(() =>
            db.prepare("SELECT id FROM forwarding_addresses WHERE user_id=?").bind(owner).all()
          )).results
        ).toEqual([]);
        expect(
          (yield* wait(() =>
            db.prepare("SELECT id FROM forwarding_addresses WHERE user_id=?").bind(other).all()
          )).results
        ).toEqual([{ id: "20000000-0000-4000-8000-000000000002" }]);
      })
    )
);
