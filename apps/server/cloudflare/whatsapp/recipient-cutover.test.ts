import { Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import {
  weeklySummaryTestCaller,
  weeklySummaryTestDatabase,
  weeklySummaryTestDatabases,
  weeklySummaryTestUser,
} from "../weekly-summary.test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  installHistoricalErasureStorage,
  schemaDefinition,
  schemaObjectName,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { InsightRecipient } from "./contract";
import { findInsightRecipient, prepareInsightRecipient } from "./operations";
import { sweepExpiredWhatsAppWindows } from "./runtime";

afterAll(() => weeklySummaryTestDatabases.dispose());

it.each(["valid", "absent", "association", "count", "interruption"])(
  "preserves recipient ownership, original archive references and unrelated User data through cutover and inverse: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* weeklySummaryTestDatabase;
        yield* Effect.tryPromise(() => installHistoricalErasureStorage(db));
        const userId = weeklySummaryTestUser;
        const recipient = yield* Schema.decodeEffect(InsightRecipient)({
          portfolioId: weeklySummaryTestCaller.businessPortfolioId,
          bsuid: weeklySummaryTestCaller.businessScopedUserId,
          businessPhoneNumberId: "123456789",
        });
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("UPDATE users SET rowid=17 WHERE id=?").bind(userId),
            db
              .prepare(
                "INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES(?,'dashboard','{}',1)"
              )
              .bind(userId),
            prepareInsightRecipient({ db, userId, recipient, receivedAtMs: 17 }),
            db.prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES('historical-route','already-deleted',1,'Complete')"
            ),
            db.prepare(
              "INSERT INTO erasure_archives(request_id,store_id,row_ref,body) VALUES('historical-route','insight_whatsapp_routes','initial:17','{\"user_id\":\"historical\",\"verified_at_ms\":17}')"
            ),
          ])
        );
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./recipient-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker: "whatsapp-recipient-" + part }).map((sql) =>
            db.prepare(sql)
          );
        const triggers = current.filter((sql) =>
          schemaObjectName(sql).startsWith("whatsapp_recipients_")
        );
        const oldTriggers = history.originalDefinitions.filter((sql) =>
          schemaObjectName(sql).startsWith("insight_whatsapp_routes_field_")
        );
        const guard = (part: string, count: number): ReadonlyArray<D1PreparedStatement> =>
          block(part).map((statement, index) => (index === 0 ? statement.bind(count) : statement));
        const inverse = (count: number): ReadonlyArray<D1PreparedStatement> => [
          ...guard("rollback-guard", count),
          ...triggers.map((sql) => db.prepare("DROP TRIGGER " + schemaObjectName(sql))),
          ...block("rollback-columns"),
          ...block("rollback-copy"),
          db.prepare("DROP TABLE whatsapp_recipients"),
          ...oldTriggers.map((sql) => db.prepare(sql)),
        ];
        yield* Effect.tryPromise(() => db.batch(inverse(1).slice()));
        if (["absent", "association"].includes(historyCase)) {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                historyCase === "absent"
                  ? "UPDATE users SET route_portfolio_id=NULL,route_bsuid=NULL,route_phone_number_id=NULL,route_verified_at_ms=NULL WHERE id=?"
                  : "UPDATE users SET route_bsuid='different-recipient' WHERE id=?"
              )
              .bind(userId)
              .run()
          );
        }
        const read = (): Promise<ReadonlyArray<D1Result>> =>
          db.batch([
            db.prepare("SELECT rowid,* FROM users ORDER BY id"),
            db.prepare("SELECT * FROM user_documents ORDER BY user_id,kind"),
            db.prepare("SELECT * FROM erasure_archives ORDER BY request_id,store_id,row_ref"),
          ]);
        const original = (yield* Effect.tryPromise(read)).map((row) => row.results);
        const expectedCount = historyCase === "absent" ? 0 : 1;
        const observedCount = expectedCount + (historyCase === "count" ? 1 : 0);
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              ...guard("guard", observedCount),
              db.prepare(schemaDefinition({ source: current, target: "whatsapp_recipients" })),
              ...block("copy"),
              ...oldTriggers.map((sql) => db.prepare("DROP TRIGGER " + schemaObjectName(sql))),
              ...block("drop"),
              ...triggers.map((sql) => db.prepare(sql)),
              ...(historyCase === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('recipient_interruption',0)")]
                : []),
            ])
          )
        );
        if (["association", "count", "interruption"].includes(historyCase)) {
          expect(result._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(original);
          return;
        }
        expect(result._tag).toBe("Success");
        expect(yield* findInsightRecipient({ db, userId })).toEqual(
          historyCase === "absent" ? Option.none() : Option.some(recipient)
        );
        expect(
          (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
        ).toEqual([]);
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO whatsapp_service_windows(user_id,portfolio_id,bsuid,last_verified_inbound_at_ms) VALUES(?,?,?,17)"
            )
            .bind(userId, recipient.portfolioId, recipient.bsuid)
            .run()
        );
        yield* sweepExpiredWhatsAppWindows({ db, now: 86400018 });
        expect(yield* findInsightRecipient({ db, userId })).toEqual(
          historyCase === "absent" ? Option.none() : Option.some(recipient)
        );

        yield* Effect.tryPromise(() => db.batch(inverse(historyCase === "absent" ? 0 : 1).slice()));
        expect((yield* Effect.tryPromise(read)).map((row) => row.results)).toEqual(original);
      })
    )
);
