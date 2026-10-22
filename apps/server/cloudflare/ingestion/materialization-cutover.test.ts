import { Clock, Effect, Schema } from "effect";
import { Hex } from "effect/encoding";
import { afterAll, expect, it } from "vitest";
import { isolatedTestStorage } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { processStatementSubmission } from "./operations";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const io = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const id = (ordinal: number): string =>
  `14570000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const hash = (text: string): Effect.Effect<string> =>
  io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((value) => Hex.encode(new Uint8Array(value)))
  );
const body = JSON.stringify([
  {
    recordNumber: 1,
    fields: ["2026-08-01", "-45000", "COP", "Cafe"],
    evidence: {
      sourceFormat: "csv",
      recordNumber: 1,
      startLine: 2,
      endLine: 2,
      rawRecord: "2026-08-01,-45000,COP,Cafe\n",
      fields: ["2026-08-01", "-45000", "COP", "Cafe"],
    },
  },
]);
const headers = '["fecha","valor","moneda","contraparte"]';

it.each([
  "valid",
  "changed-source",
  "missing-part",
  "interrupted-copy",
  "interrupted-swap",
] as const)(
  "preserves parsed bytes and resumption or atomically rejects %s cache conversion",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, bucket } = yield* io(() => storage.acquire());
        const current = precedingSchema({
          current: precedingSchema({
            current: schemaStatements(
              yield* io(() =>
                Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
              )
            ),
            history: yield* Schema.decodeEffect(CutoverHistory)(
              yield* io(() =>
                Bun.file(
                  new URL("./email-media-review-cutover.test-fixture.json", import.meta.url)
                ).text()
              )
            ),
          }),
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* io(() =>
              Bun.file(
                new URL("./statement-review-cutover.test-fixture.json", import.meta.url)
              ).text()
            )
          ),
        });
        const previous = precedingSchema({
          current,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* io(() =>
              Bun.file(
                new URL("./materialization-cutover.test-fixture.json", import.meta.url)
              ).text()
            )
          ),
        });
        yield* io(() => db.batch(previous.map((sql) => db.prepare(sql))));
        const at = yield* Clock.currentTimeMillis;
        const expires = at + 86400000;
        const partHash = yield* hash(body);
        const partsHash = yield* hash(
          yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Array(
                Schema.Struct({ chunk: Schema.Int, part: Schema.Int, hash: Schema.String })
              )
            )
          )([{ chunk: 0, part: 0, hash: partHash }])
        );
        const sourceHash = "a".repeat(64);
        yield* io(() =>
          db.batch([
            ...[id(1), id(2)].map((user) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',123)"
                )
                .bind(user)
            ),
            ...[3, 4, 5].flatMap((ordinal) => [
              db
                .prepare(
                  "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,source_format,status,created_at_ms,expires_at_ms,published_submission_id) VALUES(?,?,?,100,?,'csv','published',?,?,?)"
                )
                .bind(
                  id(ordinal + 10),
                  ordinal === 5 ? id(2) : id(1),
                  `private-${ordinal}`,
                  sourceHash,
                  at,
                  expires,
                  id(ordinal)
                ),
              db
                .prepare(
                  "INSERT INTO statement_submissions(rowid,id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms) VALUES(?,?,?,?,?,?,'csv','statement-parser-v1','CO','es-CO','America/Bogota','queued',?)"
                )
                .bind(
                  17 + ordinal,
                  id(ordinal),
                  ordinal === 5 ? id(2) : id(1),
                  id(ordinal + 20),
                  id(ordinal + 10),
                  at,
                  expires
                ),
            ]),
            ...[3, 4].map((ordinal) =>
              db
                .prepare(
                  "UPDATE statement_submissions SET material_source_sha256=?,material_parts_sha256=?,material_representation_revision='statement-material-v2',material_expires_at_ms=?,material_headers_json=?,material_row_count=1,material_part_count=1,material_byte_length=?,material_state='building' WHERE id=?"
                )
                .bind(
                  sourceHash,
                  partsHash,
                  expires,
                  headers,
                  new TextEncoder().encode(body).byteLength,
                  id(ordinal)
                )
            ),
            db
              .prepare(
                "INSERT INTO statement_materialization_parts(rowid,submission_id,chunk_index,part_index,body,sha256) VALUES(51,?,0,0,?,?)"
              )
              .bind(id(3), body, partHash),
            db
              .prepare("UPDATE statement_submissions SET material_state='ready' WHERE id=?")
              .bind(id(3)),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','statement_submissions','initial:20','{\"originalCache\":true}',1)"
            ),
          ])
        );
        if (history === "changed-source") {
          yield* io(() =>
            db.batch([
              db.prepare("DROP TRIGGER statement_materialization_identity"),
              db
                .prepare("UPDATE statement_submissions SET material_source_sha256=? WHERE id=?")
                .bind("b".repeat(64), id(3)),
            ])
          );
        }
        if (history === "missing-part") {
          yield* io(() =>
            db
              .prepare("DELETE FROM statement_materialization_parts WHERE submission_id=?")
              .bind(id(3))
              .run()
          );
        }
        const retained = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
            ...[
              "users",
              "statement_submissions",
              "statement_staging_objects",
              "statement_materialization_parts",
              "statement_record_outcomes",
              "transactions",
              "erasure_archives",
            ].map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
          ]);
        const before = (yield* io(retained)).map((result) => result.results);
        const objects = yield* io(() =>
          db
            .prepare(
              "SELECT type,name FROM sqlite_schema WHERE type IN('view','trigger','index') AND sql IS NOT NULL"
            )
            .all<{ type: string; name: string }>()
        );
        const guide = yield* io(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const apply = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch(
            [
              ...documentedSqlBlock({ guide, marker: "statement-materialization-preflight" }),
              schemaDefinition({ source: current, target: "statement_materializations" }),
              schemaDefinition({
                source: current,
                target: "statement_materialization_parts",
              }).replace(
                'CREATE TABLE "statement_materialization_parts"',
                "CREATE TABLE statement_materialization_parts_1457"
              ),
              ...documentedSqlBlock({ guide, marker: "statement-materialization-copy" }),
              ...documentedSqlBlock({ guide, marker: "statement-materialization-copy-check" }),
              ...(history === "interrupted-copy"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...objects.results.map(
                (object) => `DROP ${object.type.toUpperCase()} "${object.name}"`
              ),
              ...documentedSqlBlock({ guide, marker: "statement-materialization-swap" }),
              ...(history === "interrupted-swap"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...current.filter((sql) => /^CREATE (?:UNIQUE )?(?:VIEW|TRIGGER|INDEX) /u.test(sql)),
              ...documentedSqlBlock({ guide, marker: "statement-materialization-verify" }),
            ].map((sql) => db.prepare(sql))
          );
        if (history !== "valid") {
          yield* io(() => expect(apply()).rejects.toThrow("CHECK constraint failed: accepted = 1"));
          expect((yield* io(retained)).map((result) => result.results)).toEqual(before);
          return;
        }
        yield* io(apply);
        const after = (yield* io(retained)).map((result) => result.results);
        for (const index of [1, 3, 4, 5, 6, 7]) expect(after[index]).toEqual(before[index]);
        expect(
          (yield* io(() =>
            db
              .prepare(
                "SELECT rowid,submission_id,source_sha256,parts_sha256,headers_json,state,expires_at_ms FROM statement_materializations ORDER BY rowid"
              )
              .all()
          )).results
        ).toEqual(
          [3, 4].map((ordinal) => ({
            rowid: 17 + ordinal,
            submission_id: id(ordinal),
            source_sha256: sourceHash,
            parts_sha256: partsHash,
            headers_json: headers,
            state: ordinal === 3 ? "ready" : "building",
            expires_at_ms: expires,
          }))
        );
        expect((yield* io(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
        expect(
          yield* processStatementSubmission({
            DB: db,
            STATEMENT_STAGING_BUCKET: bucket,
            userId: id(2),
            submissionId: id(3),
          })
        ).toBe("completed");
        expect(
          yield* io(() => db.prepare("SELECT COUNT(*) AS total FROM transactions").first())
        ).toEqual({ total: 0 });
        expect(
          yield* processStatementSubmission({
            DB: db,
            STATEMENT_STAGING_BUCKET: bucket,
            userId: id(1),
            submissionId: id(3),
          })
        ).toBe("completed");
        expect(
          yield* processStatementSubmission({
            DB: db,
            STATEMENT_STAGING_BUCKET: bucket,
            userId: id(1),
            submissionId: id(3),
          })
        ).toBe("completed");
        expect(
          yield* io(() =>
            db
              .prepare(
                "SELECT status,source_parse_attempts,processed_rows FROM statement_submissions WHERE id=?"
              )
              .bind(id(3))
              .first()
          )
        ).toEqual({ status: "completed", source_parse_attempts: 0, processed_rows: 1 });
        expect(
          (yield* io(() =>
            db.prepare("SELECT amount,currency,counterparty,user_id FROM transactions").all()
          )).results
        ).toEqual([{ amount: "45000", currency: "COP", counterparty: "Cafe", user_id: id(1) }]);
        expect(
          (yield* io(() =>
            db.prepare("SELECT submission_id,state FROM statement_materializations").all()
          )).results
        ).toEqual([{ submission_id: id(4), state: "building" }]);
        yield* io(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO statement_materializations(submission_id,source_sha256,parts_sha256,representation_revision,expires_at_ms,headers_json,row_count,part_count,byte_length,state) SELECT ?,source_sha256,parts_sha256,representation_revision,expires_at_ms,headers_json,row_count,part_count,byte_length,state FROM statement_materializations WHERE submission_id=?"
              )
              .bind(id(5), id(4)),
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('own',?,1,'Erasing')"
              )
              .bind(id(1)),
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('foreign',?,1,'Erasing')"
              )
              .bind(id(2)),
            db
              .prepare(
                "INSERT INTO erasure_permits(request_id,user_id,store_id) VALUES('foreign',?,'statement_materializations')"
              )
              .bind(id(2)),
          ])
        );
        yield* io(() =>
          expect(
            db
              .prepare("DELETE FROM statement_materializations WHERE submission_id=?")
              .bind(id(4))
              .run()
          ).rejects.toThrow("erasure_fenced")
        );
        yield* io(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO erasure_permits(request_id,user_id,store_id) VALUES('own',?,'statement_materializations')"
              )
              .bind(id(1)),
            db.prepare("DELETE FROM statement_materializations WHERE submission_id=?").bind(id(4)),
          ])
        );
        expect(
          (yield* io(() =>
            db.prepare("SELECT submission_id FROM statement_materializations").all()
          )).results
        ).toEqual([{ submission_id: id(5) }]);
      })
    )
);
