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
  `14600000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const bytes = new TextEncoder().encode(
  "fecha,valor,moneda,contraparte\n2026-08-01,-45000,COP,Cafe\n"
);

it.each([
  "valid",
  "foreign-reservation",
  "absent-partial-totals",
  "different-final-totals",
  "interrupted-copy",
  "interrupted-swap",
] as const)(
  "preserves optional entitlement, final-total absence and captured history or rolls back %s cutover",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, bucket } = yield* io(() => storage.acquire());
        const current = schemaStatements(
          yield* io(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({
          current,
          history: yield* Schema.decodeEffect(CutoverHistory)(
            yield* io(() =>
              Bun.file(
                new URL("./backfill-progress-cutover.test-fixture.json", import.meta.url)
              ).text()
            )
          ),
        });
        yield* io(() => db.batch(previous.map((sql) => db.prepare(sql))));
        const at = yield* Clock.currentTimeMillis;
        const expires = at + 86400000;
        const digest = Hex.encode(
          new Uint8Array(yield* io(() => crypto.subtle.digest("SHA-256", bytes)))
        );
        yield* io(() => bucket.put("statement/13", bytes, { sha256: digest }));
        yield* io(() =>
          db.batch([
            ...[1, 2, 3, 4, 5].map((ordinal) =>
              db
                .prepare(
                  "INSERT INTO users(rowid,id,service_market,locale,time_zone,created_at_ms) VALUES(?,?,'CO','es-CO','America/Bogota',123)"
                )
                .bind(17 + ordinal, id(ordinal))
            ),
            ...[11, 13, 14].flatMap((ordinal) => [
              db
                .prepare(
                  "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,source_format,status,created_at_ms,expires_at_ms,published_submission_id) VALUES(?,?,?,?,?,'csv','published',?,?,?)"
                )
                .bind(
                  id(ordinal + 20),
                  id(ordinal - 10),
                  `statement/${ordinal}`,
                  bytes.byteLength,
                  digest,
                  at,
                  expires,
                  id(ordinal)
                ),
              db
                .prepare(
                  "INSERT INTO statement_submissions(rowid,id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms) VALUES(?,?,?,?,?,?,'csv','statement-parser-v1','CO','es-CO','America/Bogota','queued',?)"
                )
                .bind(
                  ordinal + 20,
                  id(ordinal),
                  id(ordinal - 10),
                  id(ordinal + 30),
                  id(ordinal + 20),
                  at,
                  expires
                ),
            ]),
            db.prepare("UPDATE users SET backfill_present=1 WHERE id=?").bind(id(2)),
            db
              .prepare("UPDATE users SET backfill_present=1,backfill_submission_id=? WHERE id=?")
              .bind(id(13), id(3)),
            db
              .prepare(
                "UPDATE users SET backfill_present=1,backfill_submission_id=?,backfill_consumed_at_ms=? WHERE id=?"
              )
              .bind(id(14), at - 5, id(4)),
            db
              .prepare("UPDATE users SET backfill_present=1,backfill_consumed_at_ms=? WHERE id=?")
              .bind(at - 7, id(5)),
            db
              .prepare(
                "UPDATE statement_submissions SET status='processing',started_at_ms=? WHERE id=?"
              )
              .bind(at, id(14)),
            db
              .prepare(
                "INSERT INTO ingestion_review_items(id,user_id,source_kind,statement_submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,original_evidence,issues_json,evidence_state) VALUES(?,?,'statement',?,1,'mapping-unavailable',?,?,'CO','es-CO','America/Bogota','csv','statement-parser-v1','statement-mechanical-v1','{\"sourceFormat\":\"csv\"}','[]','retained')"
              )
              .bind(id(60), id(4), id(14), at, expires),
            db
              .prepare(
                "INSERT INTO statement_record_outcomes(user_id,submission_id,record_number,outcome) VALUES(?,?,1,'needs-review')"
              )
              .bind(id(4), id(14)),
            db
              .prepare(
                "UPDATE statement_submissions SET status='failed',completed_at_ms=?,failure_reason='resource-limit',input_rows=1,accepted_rows=0,needs_review_rows=1 WHERE id=?"
              )
              .bind(at + 1, id(14)),
            db
              .prepare("UPDATE statement_submissions SET work_published_at_ms=? WHERE id=?")
              .bind(at, id(13)),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('past','removed',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body,recovery_written) VALUES('past','statement_backfill_entitlements','initial:21','{\"user_id\":\"historical\",\"consumed_at_ms\":1234567890123}',1)"
            ),
          ])
        );
        if (history === "foreign-reservation") {
          yield* io(() =>
            db
              .prepare("UPDATE users SET backfill_submission_id=? WHERE id=?")
              .bind(id(14), id(3))
              .run()
          );
        }
        if (history === "absent-partial-totals" || history === "different-final-totals") {
          yield* io(() =>
            db.batch([
              db.prepare("DROP TRIGGER statement_progress_terminal"),
              db
                .prepare(
                  history === "absent-partial-totals"
                    ? "UPDATE statement_submissions SET input_rows=NULL,accepted_rows=NULL,needs_review_rows=NULL WHERE id=?"
                    : "UPDATE statement_submissions SET input_rows=2,accepted_rows=1,needs_review_rows=1 WHERE id=?"
                )
                .bind(id(14)),
            ])
          );
        }
        const retained = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name"),
            ...[
              "users",
              "statement_submissions",
              "statement_staging_objects",
              "statement_record_outcomes",
              "ingestion_review_items",
              "erasure_archives",
            ].map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
          ]);
        const before = (yield* io(retained)).map(({ results }) => results);
        const stable = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare(
              "SELECT rowid,id,service_market,locale,time_zone,created_at_ms FROM users ORDER BY rowid"
            ),
            ...[
              "statement_staging_objects",
              "statement_record_outcomes",
              "ingestion_review_items",
              "erasure_archives",
            ].map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
          ]);
        const exact = (yield* io(stable)).map(({ results }) => results);
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
              "PRAGMA defer_foreign_keys=ON",
              ...documentedSqlBlock({ guide, marker: "backfill-progress-preflight" }),
              schemaDefinition({ source: current, target: "statement_backfill_entitlements" }),
              ...documentedSqlBlock({ guide, marker: "backfill-progress-copy" }),
              ...documentedSqlBlock({ guide, marker: "backfill-progress-copy-check" }),
              ...(history === "interrupted-copy"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...objects.results.map(
                (object) => `DROP ${object.type.toUpperCase()} "${object.name}"`
              ),
              ...documentedSqlBlock({ guide, marker: "backfill-progress-swap" }),
              ...(history === "interrupted-swap"
                ? ["INSERT INTO sql_assertions(scope,accepted) VALUES('fault',0)"]
                : []),
              ...current.filter((sql) => /^CREATE (?:UNIQUE )?(?:INDEX|VIEW|TRIGGER) /u.test(sql)),
              ...documentedSqlBlock({ guide, marker: "backfill-progress-verify" }),
            ].map((sql) => db.prepare(sql))
          );
        if (history !== "valid") {
          yield* io(() => expect(apply()).rejects.toThrow("CHECK constraint failed: accepted = 1"));
          expect((yield* io(retained)).map(({ results }) => results)).toEqual(before);
          return;
        }
        yield* io(apply);
        expect((yield* io(stable)).map(({ results }) => results)).toEqual(exact);
        expect(
          (yield* io(() =>
            db.prepare("SELECT rowid,* FROM statement_backfill_entitlements ORDER BY rowid").all()
          )).results
        ).toEqual([
          { rowid: 19, user_id: id(2), submission_id: null, consumed_at_ms: null },
          { rowid: 20, user_id: id(3), submission_id: id(13), consumed_at_ms: null },
          { rowid: 21, user_id: id(4), submission_id: id(14), consumed_at_ms: at - 5 },
          { rowid: 22, user_id: id(5), submission_id: null, consumed_at_ms: at - 7 },
        ]);
        expect(
          (yield* io(() =>
            db.prepare("SELECT rowid,* FROM statement_submission_context ORDER BY rowid").all()
          )).results
        ).toEqual(before[2]);
        yield* io(() =>
          expect(
            db
              .prepare("UPDATE statement_backfill_entitlements SET submission_id=? WHERE user_id=?")
              .bind(id(14), id(3))
              .run()
          ).rejects.toThrow("FOREIGN KEY constraint failed")
        );
        const input = {
          DB: db,
          STATEMENT_STAGING_BUCKET: bucket,
          userId: id(3),
          submissionId: id(13),
        };
        yield* processStatementSubmission({ ...input, userId: id(4) });
        expect(
          yield* io(() => db.prepare("SELECT count(*) AS total FROM transactions").first())
        ).toEqual({ total: 0 });
        yield* processStatementSubmission(input);
        yield* processStatementSubmission(input);
        expect(
          (yield* io(() =>
            db.prepare("SELECT amount,currency FROM transactions WHERE user_id=?").bind(id(3)).all()
          )).results
        ).toEqual([{ amount: "45000", currency: "COP" }]);
        expect(
          yield* io(() =>
            db
              .prepare(
                "SELECT submission_id,consumed_at_ms IS NOT NULL AS consumed FROM statement_backfill_entitlements WHERE user_id=?"
              )
              .bind(id(3))
              .first()
          )
        ).toEqual({ submission_id: id(13), consumed: 1 });
        yield* io(() =>
          expect(
            db
              .prepare(
                "INSERT INTO statement_record_outcomes(user_id,submission_id,record_number,outcome) VALUES(?,?,2,'needs-review')"
              )
              .bind(id(3), id(13))
              .run()
          ).rejects.toThrow("statement_progress_terminal")
        );
        expect(
          yield* io(() =>
            db
              .prepare(
                "SELECT count(*) AS total FROM statement_record_outcomes WHERE submission_id=?"
              )
              .bind(id(13))
              .first()
          )
        ).toEqual({ total: 1 });
        expect((yield* io(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
      })
    )
);
