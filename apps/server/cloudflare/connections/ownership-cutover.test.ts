import { Clock, Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { setup, users } from "../agent/hosted-turn.test-fixture";
import { UserId } from "../../src/core/identity/contract";
import {
  CutoverHistory,
  documentedSqlBlock,
  makeSchemaCutover,
  precedingSchema,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { makeConnectionsErasureStores } from "./runtime";

const sourceTables = ["connection_attempts", "connections", "connection_institution_gate"];
const targetTables = ["connection_attempts", "connections"];
const { scratch, swap } = makeSchemaCutover(sourceTables);
it.each([
  "valid",
  "owner-mismatch",
  "institution-mismatch",
  "enabled-history",
  "count",
  "interruption",
  "archive",
])(
  "preserves original Connection attempts, owners and prepared sessions through conversion and inverse: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./ownership-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current, history }).map((sql) =>
          historyCase === "owner-mismatch" || historyCase === "institution-mismatch"
            ? sql.replace(
                "FOREIGN KEY (user_id, connection_id, institution_id) REFERENCES connections(user_id, id, institution_id)",
                "FOREIGN KEY(connection_id) REFERENCES connections(id)"
              )
            : sql
        );
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker: "connection-owner-" + part }).map((sql) =>
            db.prepare(sql)
          );
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...block("rollback-guard"),
            ...scratch(previous, sourceTables).map((sql) => db.prepare(sql)),
            ...block("rollback-copy"),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: targetTables,
              targetNames: sourceTables,
            }),
            ...block("verify"),
            db
              .prepare(
                "INSERT INTO connections(rowid,id,user_id,institution_id,state,created_at_ms,updated_at_ms) VALUES(17,'original-connection',?,'bancolombia','Connecting',17,23),(83,'other-connection',?,'bancolombia','Ended',-993,29)"
              )
              .bind(...users),
            db
              .prepare(
                "INSERT INTO connection_attempts(rowid,id,user_id,connection_id,institution_id,public_reference,status,created_at_ms,expires_at_ms) VALUES(17,'pending-attempt',?,'original-connection',?,'public-pending','pending',17,600017),(83,'prepared-attempt',?,'other-connection','bancolombia','public-prepared','pending',-993,599007),(91,'invalidated-attempt',?,'original-connection','bancolombia','public-old','invalidated',-999,599001)"
              )
              .bind(
                historyCase === "owner-mismatch" ? users[1] : users[0],
                historyCase === "institution-mismatch" ? "removed-institution" : "bancolombia",
                users[1],
                users[0]
              ),
            db
              .prepare(
                "UPDATE connection_attempts SET status='consumed',consumed_at_ms=19,prepared_session_id=(SELECT id FROM web_sessions WHERE user_id=? LIMIT 1) WHERE id='prepared-attempt'"
              )
              .bind(users[1]),
          ])
        );
        if (historyCase === "enabled-history") {
          yield* Effect.tryPromise(() =>
            db.prepare("UPDATE connection_institution_gate SET enabled=1").run()
          );
        }
        const read = (table: string): Promise<D1Result> =>
          db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all();
        const original = yield* Effect.tryPromise(() => Promise.all(sourceTables.map(read)));
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              db.prepare("PRAGMA defer_foreign_keys=ON"),
              ...documentedSqlBlock({ guide, marker: "connection-owner-guard" }).map((sql) =>
                db.prepare(sql).bind(historyCase === "count" ? 3 : 2, 3)
              ),
              ...scratch(current, targetTables).map((sql) => db.prepare(sql)),
              ...block("copy"),
              ...swap({
                db,
                source: previous,
                target: current,
                sourceNames: sourceTables,
                targetNames: targetTables,
              }),
              ...(historyCase === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupt_connection',0)")]
                : []),
              ...block("verify"),
            ])
          )
        );
        if (historyCase !== "valid" && historyCase !== "archive") {
          expect(result._tag).toBe("Failure");
          const restored = yield* Effect.tryPromise(() => Promise.all(sourceTables.map(read)));
          expect(restored.map((result) => result.results)).toEqual(
            original.map((result) => result.results)
          );
          return;
        }
        expect(result._tag).toBe("Success");
        if (historyCase === "archive") {
          const clock = yield* Clock.currentTimeMillis;
          const decision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            dispositions: {
              projections: { action: "Retain", retention: { untilMs: clock + 86400000 } },
            },
          });
          yield* Effect.tryPromise(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES('connection-archive',?,?,'Archiving',?)"
                )
                .bind(users[1], clock, decision),
              db.prepare(
                "INSERT INTO erasure_steps(request_id,store_id,data_class) VALUES('connection-archive','connection_attempts','projections')"
              ),
            ])
          );
          const store = makeConnectionsErasureStores(db).find(
            (item) => item.id === "connection_attempts"
          );
          if (store === undefined) {
            return yield* Effect.die("Missing attempt erasure purpose");
          }
          expect(
            yield* store.archive({ userId: UserId.make(users[1]), reference: "connection-archive" })
          ).toBe(true);
          expect(
            yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT row_ref,json_extract(body,'$.user_id') AS user_id,json_extract(body,'$.institution_id') AS institution_id,json_extract(body,'$.prepared_at_ms') AS prepared_at_ms FROM erasure_archives WHERE request_id='connection-archive'"
                )
                .first()
            )
          ).toEqual({
            row_ref: "initial:83",
            user_id: users[1],
            institution_id: "bancolombia",
            prepared_at_ms: 19,
          });
          return;
        }
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...block("rollback-guard"),
            ...scratch(previous, sourceTables).map((sql) => db.prepare(sql)),
            ...block("rollback-copy"),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: targetTables,
              targetNames: sourceTables,
            }),
            ...block("verify"),
          ])
        );
        const restored = yield* Effect.tryPromise(() => Promise.all(sourceTables.map(read)));
        expect(restored.map((result) => result.results)).toEqual(
          original.map((result) => result.results)
        );
      })
    )
);
