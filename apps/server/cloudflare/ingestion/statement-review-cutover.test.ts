import { Clock, Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestStorage } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const io = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const id = (ordinal: number): string =>
  `14580000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;

it.each(["valid", "changed-deadline", "interrupted-copy", "interrupted-swap"] as const)(
  "preserves independently retained review evidence and workspace or rolls back %s conversion",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* io(() => storage.acquire());
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
                  new URL("./backfill-progress-cutover.test-fixture.json", import.meta.url)
                ).text()
              )
            ),
          }),
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* io(() =>
              Bun.file(
                new URL("./email-media-review-cutover.test-fixture.json", import.meta.url)
              ).text()
            )
          ),
        });
        const previous = precedingSchema({
          current,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* io(() =>
              Bun.file(
                new URL("./statement-review-cutover.test-fixture.json", import.meta.url)
              ).text()
            )
          ),
        });
        yield* io(() => db.batch(previous.map((sql) => db.prepare(sql))));
        const at = yield* Clock.currentTimeMillis;
        const expires = at + 86400000;
        yield* io(() =>
          db.batch([
            ...[1, 2].map((ordinal) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',123)"
                )
                .bind(id(ordinal))
            ),
            ...[3, 4].flatMap((ordinal) => [
              db
                .prepare(
                  "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,source_format,status,created_at_ms,expires_at_ms,published_submission_id) VALUES(?,?,?,100,?,'csv','published',?,?,?)"
                )
                .bind(
                  id(ordinal + 10),
                  id(ordinal - 2),
                  `private-${ordinal}`,
                  "a".repeat(64),
                  at,
                  expires,
                  id(ordinal)
                ),
              db
                .prepare(
                  "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms) VALUES(?,?,?,?,?,'csv','statement-parser-v1','CO','es-CO','America/Bogota','queued',?)"
                )
                .bind(
                  id(ordinal),
                  id(ordinal - 2),
                  id(ordinal + 20),
                  id(ordinal + 10),
                  at,
                  expires
                ),
            ]),
            ...[5, 6, 7].map((ordinal) =>
              db
                .prepare(
                  "INSERT INTO statement_needs_review(rowid,id,user_id,submission_id,record_number,reason,original_evidence,known_money,issues,status,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,review_suggestions_json) VALUES(?,?,?,?,?,'mapping-unavailable','{\"sourceFormat\":\"csv\"}','{\"amount\":\"123.45\",\"currency\":\"COP\"}','[]','pending',?,?,'CO','es-CO','America/Bogota','csv','statement-parser-v1','statement-mechanical-v1','[]')"
                )
                .bind(
                  ordinal + 20,
                  id(ordinal),
                  id(ordinal === 7 ? 2 : 1),
                  id(ordinal === 7 ? 4 : 3),
                  ordinal,
                  expires,
                  at
                )
            ),
            db
              .prepare(
                "INSERT INTO ingestion_review_state(rowid,id,user_id,status,revision,draft_json,expires_at_ms,updated_at_ms,created_at_ms) VALUES(91,?,?,'skipped',3,'{\"notes\":\"original\"}',?,?,?)"
              )
              .bind(
                id(5),
                id(1),
                history === "changed-deadline" ? expires + 1 : expires,
                at + 1,
                at
              ),
            db
              .prepare(
                "INSERT INTO ingestion_review_state(rowid,id,user_id,status,revision,expires_at_ms,updated_at_ms,created_at_ms) VALUES(92,?,?,'pending',2,?,?,?)"
              )
              .bind(id(6), id(1), expires, at + 2, at),
            db
              .prepare(
                "UPDATE statement_needs_review SET status='expired',original_evidence=NULL,known_money=NULL,review_suggestions_json=NULL WHERE id=?"
              )
              .bind(id(6)),
            db
              .prepare(
                "INSERT INTO ingestion_review_state(rowid,id,user_id,status,revision,expires_at_ms,updated_at_ms,created_at_ms) VALUES(93,?,?,'pending',1,?,?,?)"
              )
              .bind(id(99), id(2), expires, at, at),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','ingestion_review_state','initial:91','{\"retained\":true}',1)"
            ),
          ])
        );
        const retained = (): Promise<ReadonlyArray<D1Result<Record<string, unknown>>>> =>
          db.batch<Record<string, unknown>>([
            db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
            ...[
              "users",
              "statement_submissions",
              "statement_needs_review",
              "ingestion_review_state",
              "statement_review_capacity",
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
              ...documentedSqlBlock({ guide, marker: "statement-review-preflight" }),
              ...objects.results.map(
                (object) => `DROP ${object.type.toUpperCase()} "${object.name}"`
              ),
              schemaDefinition({ source: current, target: "ingestion_review_items" }),
              ...current.filter((sql) => /^CREATE (?:UNIQUE )?INDEX /u.test(sql)),
              ...documentedSqlBlock({ guide, marker: "statement-review-copy" }),
              ...documentedSqlBlock({ guide, marker: "statement-review-copy-check" }),
              ...(history === "interrupted-copy"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...documentedSqlBlock({ guide, marker: "statement-review-swap" }),
              ...(history === "interrupted-swap"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...current.filter((sql) => /^CREATE (?:VIEW|TRIGGER) /u.test(sql)),
              ...documentedSqlBlock({ guide, marker: "statement-review-verify" }),
            ].map((sql) => db.prepare(sql))
          );
        if (history !== "valid") {
          yield* io(() => expect(apply()).rejects.toThrow("CHECK constraint failed: accepted = 1"));
          expect((yield* io(retained)).map((result) => result.results)).toEqual(before);
          return;
        }
        yield* io(apply);
        for (const [table, index] of [
          ["users", 1],
          ["statement_submissions", 2],
          ["statement_review_context", 3],
          ["ingestion_review_workspace_state", 4],
          ["statement_review_capacity", 5],
          ["erasure_archives", 6],
        ] as const) {
          const rows = (yield* io(() =>
            db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()
          )).results;
          // The workspace projection exposes the preserved textual archive reference.
          expect(rows).toEqual(
            table === "ingestion_review_workspace_state"
              ? before[index]?.map((row) => ({ ...row, rowid: String(row.rowid) }))
              : before[index]
          );
        }
        expect(
          (yield* io(() => db.prepare("SELECT id FROM ingestion_review_state ORDER BY id").all()))
            .results
        ).toEqual([{ id: id(99) }]);
        expect(
          yield* io(() =>
            db.prepare("SELECT pending_count FROM statement_review_capacity WHERE id=1").first()
          )
        ).toEqual({ pending_count: 2 });
        yield* io(() =>
          expect(
            db
              .prepare(
                "UPDATE ingestion_review_items SET evidence_state='resolved',original_evidence=NULL,known_money_json=NULL,suggestions_json=NULL WHERE id=?"
              )
              .bind(id(7))
              .run()
          ).rejects.toThrow("review_immutable")
        );
        yield* io(() =>
          db
            .prepare(
              "UPDATE ingestion_review_items SET workspace_state='pending',workspace_revision=4,workspace_updated_at_ms=? WHERE id=?"
            )
            .bind(at + 3, id(5))
            .run()
        );
        expect(
          yield* io(() =>
            db
              .prepare(
                "SELECT evidence_state,original_evidence,evidence_expires_at_ms FROM ingestion_review_items WHERE id=?"
              )
              .bind(id(6))
              .first()
          )
        ).toEqual({
          evidence_state: "expired",
          original_evidence: null,
          evidence_expires_at_ms: expires,
        });
        yield* io(() =>
          expect(
            db
              .prepare(
                "UPDATE ingestion_review_items SET evidence_state='retained',original_evidence='{}' WHERE id=?"
              )
              .bind(id(6))
              .run()
          ).rejects.toThrow("review_immutable")
        );
        yield* io(() =>
          expect(
            db
              .prepare(
                "INSERT INTO ingestion_review_state(id,user_id,status,revision,expires_at_ms,updated_at_ms,created_at_ms) VALUES(?,?,'pending',1,?,?,?)"
              )
              .bind(id(5), id(1), expires, at, at)
              .run()
          ).rejects.toThrow("review_owner")
        );
        yield* io(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('own',?,1,'Erasing'),('foreign',?,1,'Erasing')"
              )
              .bind(id(1), id(2)),
            db
              .prepare(
                "INSERT INTO erasure_permits(request_id,user_id,store_id) VALUES('foreign',?,'ingestion_review_state')"
              )
              .bind(id(2)),
          ])
        );
        const clear = db
          .prepare(
            "UPDATE ingestion_review_items SET workspace_state=NULL,workspace_revision=NULL,draft_json=NULL,transaction_id=NULL,workspace_updated_at_ms=NULL,workspace_archive_row_ref=NULL WHERE user_id=? AND workspace_archive_row_ref='91'"
          )
          .bind(id(1));
        yield* io(() => expect(clear.run()).rejects.toThrow("erasure_fenced"));
        yield* io(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO erasure_permits(request_id,user_id,store_id) VALUES('own',?,'ingestion_review_state')"
              )
              .bind(id(1)),
            clear,
          ])
        );
        expect(
          yield* io(() =>
            db.prepare("SELECT pending_count FROM statement_review_capacity WHERE id=1").first()
          )
        ).toEqual({ pending_count: 2 });
        expect((yield* io(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
      })
    )
);
