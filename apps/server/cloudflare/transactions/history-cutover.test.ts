import { DateTime, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { UtcTimestamp } from "../../src/core/_shared/time";
import { Transaction } from "../../src/core/transactions/contract";
import { isolatedTestDatabases } from "../d1-test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  precedingSchema,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { findTransactionPresentation } from "./internal/transaction-history";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const wait = <A>(work: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(work).pipe(Effect.orDie);
const owner = "10000000-0000-4000-8000-000000000001";
const peer = "10000000-0000-4000-8000-000000000002";
const first = "20000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000002";
const third = "20000000-0000-4000-8000-000000000003";
const foreign = "20000000-0000-4000-8000-000000000004";
const category = "10000000-0000-4000-8000-000000000003";
const explicitCategory = "10000000-0000-4000-8000-000000000004";
const submission = "30000000-0000-4000-8000-000000000001";
const receipt = "30000000-0000-4000-8000-000000000002";
const review = "30000000-0000-4000-8000-000000000003";
const tables = [
  "transactions",
  "source_attestations",
  "transaction_corrections",
  "transaction_reconciliation_decisions",
] as const;
const timeFields = {
  transactions: ["occurred_at", "created_at"],
  source_attestations: ["created_at"],
  transaction_corrections: ["corrected_at"],
  transaction_reconciliation_decisions: ["decided_at"],
};
const SourceRow = Schema.Record(Schema.String, Schema.Unknown);
const exactInstant = (value: unknown): Option.Option<DateTime.Utc> =>
  typeof value === "string" && !/[1-9]/u.test((/\.(\d+)/u.exec(value)?.[1] ?? "").slice(3))
    ? Schema.decodeOption(UtcTimestamp)(value)
    : Option.none();

const checkedInstants = Effect.fn(function* ({
  db,
  guide,
}: Readonly<{ db: D1Database; guide: string }>) {
  const rowGuards: D1PreparedStatement[] = [];
  const copies: D1PreparedStatement[] = [];
  for (const table of tables) {
    const rows = yield* Schema.decodeEffect(Schema.Array(SourceRow))(
      (yield* wait(() => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all())).results
    );
    const guard =
      documentedSqlBlock({ guide, marker: "transaction-history-row-" + table })[0] ?? "";
    for (const row of rows) {
      const instants = timeFields[table].map((field) => exactInstant(row[field]));
      const rowid = yield* Schema.decodeUnknownEffect(Schema.Int)(row.rowid);
      const values = timeFields[table].flatMap((field, index) => {
        const decoded = instants[index];
        return [
          typeof row[field] === "string" ? row[field] : "",
          decoded !== undefined && Option.isSome(decoded)
            ? DateTime.toEpochMillis(decoded.value)
            : 0,
        ];
      });
      rowGuards.push(
        db.prepare(guard).bind(instants.every(Option.isSome) ? 1 : 0, rowid, ...values)
      );
      const copy = documentedSqlBlock({ guide, marker: "transaction-history-copy-" + table });
      const milliseconds = instants.map((instant) =>
        Option.isSome(instant) ? DateTime.toEpochMillis(instant.value) : 0
      );
      const original = timeFields[table].map((field) =>
        Schema.decodeUnknownSync(Schema.String)(row[field])
      );
      copies.push(
        db.prepare(copy[0] ?? "").bind(...milliseconds, rowid, ...original),
        db.prepare(copy[1] ?? "").bind(rowid, ...milliseconds)
      );
    }
  }
  return { guards: rowGuards, copies };
});
const financialIndex = (object: Readonly<{ type: string; tbl_name: string }>): boolean =>
  object.type === "index" && tables.some((table) => table === object.tbl_name);

it.each([
  "valid",
  "lossy-instant",
  "foreign-statement",
  "foreign-review",
  "interrupted-copy",
  "interrupted-swap",
] as const)(
  "preserves exact financial history and relationships or rolls back %s conversion",
  (history) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* wait(() => databases.acquire());
        const current = schemaStatements(
          yield* wait(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const manifest = yield* Schema.decodeEffect(CutoverHistory)(
          yield* wait(() =>
            Bun.file(new URL("./history-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const source = precedingSchema({ current, history: manifest });
        yield* wait(() =>
          db.batch(
            source.filter((sql) => !sql.startsWith("CREATE TRIGGER ")).map((sql) => db.prepare(sql))
          )
        );
        const sourceOwner = history === "foreign-statement" ? peer : owner;
        const reviewOwner = history === "foreign-review" ? peer : owner;
        yield* wait(() =>
          db.batch([
            ...[owner, peer].map((id) =>
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(id)
            ),
            ...[owner, peer].map((id) =>
              db
                .prepare(
                  "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant',?,?,'{}','disclosed','accepted',1,1)"
                )
                .bind(id, id)
            ),
            db
              .prepare(
                "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms) VALUES(?,?,'native/statement',1,?,'pending',1,2)"
              )
              .bind(submission, owner, "c".repeat(64)),
            db
              .prepare(
                "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,retention_expires_at_ms,source_format,parser_revision,service_market,locale,time_zone) VALUES(?,?,?,?,1,2,'csv','native-v1','CO','es-CO','America/Bogota')"
              )
              .bind(submission, owner, submission, submission),
            db
              .prepare(
                "INSERT INTO forwarded_email_receipts(id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms) VALUES(?,?,?,'native/email',1,'queued',1,2)"
              )
              .bind(receipt, reviewOwner, "a".repeat(64)),
            db
              .prepare(
                "INSERT INTO ingestion_review_items(id,user_id,source_kind,email_receipt_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone) VALUES(?,?,'email',?,'unknown-format',1,2,'CO','es-CO','America/Bogota')"
              )
              .bind(review, reviewOwner, receipt),
            ...[first, second, third, foreign].map((id, index) =>
              db
                .prepare(
                  "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at,created_at,user_decisions,deleted_at_ms) VALUES(?,?,'9007199254740993.15','COP','outflow',?,?,'2026-08-31T13:02:02.007-15:59',?,?)"
                )
                .bind(
                  id,
                  id === foreign ? peer : owner,
                  index === 1 ? explicitCategory : category,
                  history === "lossy-instant" && index === 0
                    ? "2026-09-01T00:01:02.0031-05:00"
                    : "2026-09-01T21:00:02.003+15:59",
                  index === 1 ? '{"categoryId":true}' : "{}",
                  id === foreign ? 1788238862010 : null
                )
            ),
            db
              .prepare(
                "INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at,statement_submission_id,statement_record_number,statement_content_hash,source_format) VALUES('40000000-0000-4000-8000-000000000001',?,?,'statement-line','CO','es-CO','America/Bogota','statement-v1','2026-09-01T21:00:02.009+15:59',?,1,?,'csv')"
              )
              .bind(
                sourceOwner,
                sourceOwner === owner ? first : foreign,
                submission,
                "b".repeat(64)
              ),
            db
              .prepare(
                "INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at,review_item_id,user_provided_fields) VALUES('40000000-0000-4000-8000-000000000002',?,?,'manual','CO','es-CO','America/Bogota','user-reviewed-v1','2026-08-31T13:02:02.011-15:59',?,'[\"money\",\"categoryId\"]')"
              )
              .bind(owner, second, review),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('old-erasure','deleted-owner',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('old-erasure','transactions','initial:19','{\"created_at\":\"2026-08-31T13:02:02.007-15:59\"}')"
            ),
          ])
        );
        const originalFacts = {
          id: first,
          money: { amount: "9007199254740993.15", currency: "COP" },
          direction: "outflow",
          categoryId: category,
          occurredAt: "2026-09-01T05:01:02.003Z",
          createdAt: "2026-09-01T05:01:02.007Z",
          revision: 0,
        };
        const snapshot = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          originalFacts
        );
        const correctedSnapshot = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          { ...originalFacts, notes: "Chosen note", revision: 1 }
        );
        yield* Schema.decodeUnknownEffect(Schema.toCodecJson(Transaction))(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(snapshot)
        );
        yield* wait(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO transaction_corrections(id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at) VALUES('50000000-0000-4000-8000-000000000001',?,?,0,'[\"notes\"]',?,?,'2026-09-01T21:00:02.013+15:59')"
              )
              .bind(owner, first, snapshot, correctedSnapshot),
            db
              .prepare(
                "UPDATE transactions SET notes='Chosen note',revision=1,user_decisions='{\"notes\":true}' WHERE id=?"
              )
              .bind(first),
            db
              .prepare(
                "INSERT INTO transaction_reconciliation_decisions(user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,decided_at) VALUES(?,?,?,'linked',?,'2026-08-31T13:02:02.017-15:59')"
              )
              .bind(owner, first, second, second),
            ...[first, second].map((id) =>
              db
                .prepare(
                  "UPDATE transactions SET reconciliation_row_ref=?,reconciliation_first_id=?,reconciliation_second_id=? WHERE id=?"
                )
                .bind("original:" + id, first, second, id)
            ),
          ])
        );
        // Restore historical facts without replaying capture/projection side effects, then enforce the checkpoint's guards.
        yield* wait(() =>
          db.batch(
            source.filter((sql) => sql.startsWith("CREATE TRIGGER ")).map((sql) => db.prepare(sql))
          )
        );
        const affected = [
          ...tables,
          "dashboard_projection_leaf",
          "dashboard_projection_state",
          "statement_submissions",
          "statement_staging_objects",
          "ingestion_review_items",
          "forwarded_email_receipts",
          "erasure_archives",
          "sqlite_sequence",
        ];
        const state = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            ...affected.map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
            db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name"),
          ]);
        const before = (yield* wait(state)).map((result) => result.results);
        const guide = yield* wait(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (marker: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker }).map((sql) => db.prepare(sql));
        const checked = yield* checkedInstants({ db, guide });
        const objects = (yield* wait(() =>
          db
            .prepare(
              "SELECT type,name,tbl_name FROM sqlite_schema WHERE sql IS NOT NULL AND type IN('trigger','view','index')"
            )
            .all<{ type: string; name: string; tbl_name: string }>()
        )).results;
        const plan = [
          ...block("transaction-history-preflight"),
          ...checked.guards,
          ...objects
            .filter((object) => object.type !== "index")
            .map((object) => db.prepare(`DROP ${object.type.toUpperCase()} "${object.name}"`)),
          ...tables.map((table) =>
            db.prepare(
              schemaDefinition({ source: current, target: table }).replace(
                new RegExp(`CREATE TABLE "?${table}"?`),
                `CREATE TABLE ${table}_1462`
              )
            )
          ),
          ...checked.copies,
          ...tables.flatMap((table) => block("transaction-history-copy-check-" + table)),
          ...(history === "interrupted-copy"
            ? [
                db.prepare(
                  "INSERT INTO sql_assertions(scope,accepted) VALUES('interrupted-copy',0)"
                ),
              ]
            : []),
          ...block("transaction-history-swap"),
          ...(history === "interrupted-swap"
            ? [
                db.prepare(
                  "INSERT INTO sql_assertions(scope,accepted) VALUES('interrupted-swap',0)"
                ),
              ]
            : []),
          ...current
            .filter(
              (sql) =>
                /^CREATE (?:TRIGGER|VIEW) /u.test(sql) ||
                objects.some(
                  (object) => financialIndex(object) && schemaObjectName(sql) === object.name
                )
            )
            .map((sql) => db.prepare(sql)),
          ...block("transaction-history-verify"),
        ];
        if (history !== "valid") {
          yield* wait(() => expect(db.batch(plan)).rejects.toThrow(/CHECK constraint failed/u));
          expect((yield* wait(state)).map((result) => result.results)).toEqual(before);
          return;
        }
        yield* wait(() => db.batch(plan));
        const after = (yield* wait(state)).map((result) => result.results);
        expect(after.slice(tables.length, -1)).toEqual(before.slice(tables.length, -1));
        expect(
          yield* wait(() =>
            db
              .prepare(
                "SELECT amount,occurred_at_ms,created_at_ms,deleted_at_ms FROM transactions WHERE id=?"
              )
              .bind(foreign)
              .first()
          )
        ).toEqual({
          amount: "9007199254740993.15",
          occurred_at_ms: 1788238862003,
          created_at_ms: 1788238862007,
          deleted_at_ms: 1788238862010,
        });
        expect(
          yield* wait(() =>
            db
              .prepare(
                "SELECT corrected_at_ms,before_facts,after_facts FROM transaction_corrections"
              )
              .first()
          )
        ).toEqual({
          corrected_at_ms: 1788238862013,
          before_facts: snapshot,
          after_facts: correctedSnapshot,
        });
        expect(
          yield* wait(() =>
            db
              .prepare("SELECT decided_at_ms FROM transaction_reconciliation_decisions")
              .first<number>("decided_at_ms")
          )
        ).toBe(1788238862017);
        expect(
          (yield* wait(() =>
            db.prepare("SELECT created_at_ms FROM source_attestations ORDER BY id").all()
          )).results
        ).toEqual([{ created_at_ms: 1788238862009 }, { created_at_ms: 1788238862011 }]);
        const presentation = yield* wait(() =>
          findTransactionPresentation({ db, userId: owner, id: first })
        );
        expect(Option.isSome(presentation)).toBe(true);
        expect(
          yield* Schema.encodeEffect(Schema.toCodecJson(Transaction))(
            Option.getOrThrow(presentation)
          )
        ).toMatchObject({
          id: second,
          money: { amount: "9007199254740993.15", currency: "COP" },
          categoryId: explicitCategory,
          notes: "Chosen note",
          occurredAt: "2026-09-01T05:01:02.003Z",
          createdAt: "2026-09-01T05:01:02.007Z",
        });
        expect((yield* wait(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
          []
        );
      })
    )
);
