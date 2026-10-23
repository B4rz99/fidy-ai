import { Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  proactivityDatabase,
  proactivityTestDatabases,
  proactivityTestUsers,
} from "../proactivity.test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  makeSchemaCutover,
  precedingSchema,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const originalName = "hosted_whatsapp_windows";
const targetName = "whatsapp_service_windows";
const { scratch, swap } = makeSchemaCutover([originalName, targetName]);
afterAll(() => proactivityTestDatabases.dispose());
it.each(["valid", "deadline", "count", "interruption"])(
  "preserves original recipient activity and deadline through service-window conversion and rollback: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./service-window-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current, history }).map((sql) =>
          historyCase === "deadline"
            ? sql.replace("closes_at_ms = last_verified_inbound_at_ms + 86400000", "1=1")
            : sql
        );
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker: "whatsapp-window-" + part }).map((sql) =>
            db.prepare(sql)
          );
        yield* Effect.tryPromise(() =>
          db.batch([
            db
              .prepare(
                "INSERT INTO whatsapp_service_windows(rowid,user_id,portfolio_id,bsuid,last_verified_inbound_at_ms) VALUES(17,?,'portfolio','CO.recipient',1791241200007),(83,?,'other','CO.other',-993),(91,'historical-absent-owner','previous','CO.older',0)"
              )
              .bind(...proactivityTestUsers),
            ...scratch(previous, [originalName]).map((sql) => db.prepare(sql)),
            ...block("rollback-copy"),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: [targetName],
              targetNames: [originalName],
            }),
          ])
        );
        if (historyCase === "deadline") {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "UPDATE hosted_whatsapp_windows SET closes_at_ms=closes_at_ms+1 WHERE rowid=17"
              )
              .run()
          );
        }
        const read = (table: string): Promise<D1Result> =>
          db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all();
        const original = (yield* Effect.tryPromise(() => read(originalName))).results;
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              ...documentedSqlBlock({ guide, marker: "whatsapp-window-guard" }).map((sql) =>
                db.prepare(sql).bind(historyCase === "count" ? 4 : 3)
              ),
              ...scratch(current, [targetName]).map((sql) => db.prepare(sql)),
              ...block("copy"),
              ...swap({
                db,
                source: previous,
                target: current,
                sourceNames: [originalName],
                targetNames: [targetName],
              }),
              ...(historyCase === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupt_window',0)")]
                : []),
            ])
          )
        );
        if (historyCase !== "valid") {
          expect(result._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(() => read(originalName))).results).toEqual(original);
          return;
        }
        expect(result._tag).toBe("Success");
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);

        yield* Effect.tryPromise(() =>
          db.batch([
            ...block("rollback-guard"),
            ...scratch(previous, [originalName]).map((sql) => db.prepare(sql)),
            ...block("rollback-copy"),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: [targetName],
              targetNames: [originalName],
            }),
          ])
        );
        expect((yield* Effect.tryPromise(() => read(originalName))).results).toEqual(original);
      })
    )
);
