import { DateTime, Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  proactivityDatabase,
  proactivityTestBrowser,
  proactivityTestDatabases,
  proactivityTestPAT,
  proactivityTestUsers,
} from "../proactivity.test-fixture";
import { seedRefundCharge } from "../subscription/refund-charge.test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  installHistoricalErasureStorage,
  makeSchemaCutover,
  precedingSchema,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const tables = ["audit_entries"];
const { scratch, swap } = makeSchemaCutover(tables);
const recordId = (value: number): string =>
  `14760000-0000-4000-8000-${String(value).padStart(12, "0")}`;
afterAll(() => proactivityTestDatabases.dispose());
it.each(["valid", "empty", "count-mismatch", "interruption"])(
  "preserves all nine Audit variants and exact admission archives across conversion and rollback: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        yield* Effect.tryPromise(() => installHistoricalErasureStorage(db));
        const userId = proactivityTestUsers[0];
        const browser = yield* proactivityTestBrowser(db);
        const pat = yield* proactivityTestPAT(db);
        yield* seedRefundCharge(db);
        const now = DateTime.makeUnsafe("2026-10-05T23:00:00.007Z").epochMilliseconds;
        const archiveBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          id: recordId(7),
          accepted_at_ms: now,
        });
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO media_submissions(id,user_id,portfolio_id,bsuid,message_id,input_digest,accepted_at_ms,expires_at_ms,service_market,locale,time_zone) VALUES(?,?,'portfolio','CO.abcdef','audit-media','fixture-input',?,?,'CO','es-CO','America/Bogota')"
              )
              .bind(recordId(5), userId, now, now + 2592000000),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES(1501,'session_call',?,?,?,'transactions.listTransactions','success',?)"
              )
              .bind(recordId(1), userId, browser.id, now),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms) VALUES(1502,'credential_call',?,?,?,?,'tokens.listTokens','accepted',?)"
              )
              .bind(recordId(2), userId, browser.id, pat.patId, now),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms) VALUES(1503,'insight_call',?,?,?,'insights.listPendingInsights','accepted',?)"
              )
              .bind(recordId(3), userId, browser.id, now),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,id,user_id,operation,outcome,occurred_at_ms) VALUES(1504,'publication',?,?,'ingestion.submitForExtraction','success',?)"
              )
              .bind(recordId(4), userId, now),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,id,user_id,outcome,occurred_at_ms) VALUES(1505,'media_admission',?,?,'accepted',?)"
              )
              .bind(recordId(5), userId, now),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,attempt_id,transition,occurred_at_ms) VALUES(1506,'billing_transition','40000000-0000-4000-8000-000000000001','failed',?)"
              )
              .bind(now - 1),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,id,user_id,pat_id,operation,occurred_at_ms) VALUES(1507,'request_admission',?, ?,?,'transactions.listTransactions',?)"
              )
              .bind(recordId(7), userId, pat.patId, now),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,occurred_at_ms) VALUES(1508,'identity_read',?,?,?,?)"
              )
              .bind(recordId(8), userId, browser.id, now),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,id,user_id,session_id,operation,occurred_at_ms) VALUES(1509,'security_mutation',?,?,?,'recovery.rotateBackupRecoveryCode',?)"
              )
              .bind(recordId(9), userId, browser.id, now),
            db
              .prepare(
                "INSERT INTO audit_entries(sequence,record_type,attempt_id,transition,occurred_at_ms) VALUES(1510,'billing_transition','40000000-0000-4000-8000-000000000001','succeeded',?)"
              )
              .bind(now),
            db.prepare("UPDATE sqlite_sequence SET seq=9999 WHERE name='audit_entries'"),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('old','deleted',1,'Complete')"
            ),
            db
              .prepare(
                "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('old','canonical_request_acceptances','initial:before-clock',?)"
              )
              .bind(archiveBody),
          ])
        );
        if (historyCase === "empty") {
          yield* Effect.tryPromise(() =>
            db.batch([
              db
                .prepare("INSERT INTO audit_retention_permits(user_id,cutoff_ms) VALUES(?,?)")
                .bind(userId, now + 1),
              db.prepare("DELETE FROM audit_entries"),
              db.prepare("DELETE FROM audit_retention_permits"),
            ])
          );
        }
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./admission-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current, history });
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<string> =>
          documentedSqlBlock({ guide, marker: "audit-clock-" + part });
        const read = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT * FROM audit_entries ORDER BY sequence"),
            db.prepare("SELECT seq FROM sqlite_sequence WHERE name='audit_entries'"),
            db.prepare("SELECT * FROM erasure_archives ORDER BY row_ref"),
          ]);
        const expected = (yield* Effect.tryPromise(read)).map((row) => row.results);
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...block("rollback-guard").map((sql) => db.prepare(sql)),
            ...scratch(previous, tables).map((sql) => db.prepare(sql)),
            ...block("rollback-copy").map((sql) => db.prepare(sql)),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: tables,
              targetNames: tables,
            }),
          ])
        );
        const original = (yield* Effect.tryPromise(read)).map((row) => row.results);
        const conversion = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              db.prepare("PRAGMA defer_foreign_keys=ON"),
              ...block("guard").map((sql) =>
                db
                  .prepare(sql)
                  .bind(
                    (historyCase === "empty" ? 0 : 10) + (historyCase === "count-mismatch" ? 1 : 0)
                  )
              ),
              ...scratch(current, tables).map((sql) => db.prepare(sql)),
              ...block("copy").map((sql) => db.prepare(sql)),
              ...swap({
                db,
                source: previous,
                target: current,
                sourceNames: tables,
                targetNames: tables,
              }),
              ...(historyCase === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupted_audit_clock',0)")]
                : []),
            ])
          )
        );
        if (historyCase === "count-mismatch" || historyCase === "interruption") {
          expect(conversion._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(original);
          return;
        }
        expect(conversion._tag).toBe("Success");
        expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(expected);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);

        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...block("rollback-guard").map((sql) => db.prepare(sql)),
            ...scratch(previous, tables).map((sql) => db.prepare(sql)),
            ...block("rollback-copy").map((sql) => db.prepare(sql)),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: tables,
              targetNames: tables,
            }),
          ])
        );
        expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(original);
      })
    )
);
